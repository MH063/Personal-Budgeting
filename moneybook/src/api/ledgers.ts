import { execute, select, runInTransaction, getActiveLedgerId, setActiveLedgerId } from './db';

export interface Ledger {
  id: number;
  name: string;
  icon: string;
  color: string;
  created_at: string;
}

/** 全部账本 */
export async function listLedgers(): Promise<Ledger[]> {
  return select<Ledger>('SELECT * FROM ledgers ORDER BY id');
}

/** 新建账本 */
export async function createLedger(name: string, icon?: string, color?: string): Promise<number> {
  const rs = await execute(
    `INSERT INTO ledgers (name, icon, color) VALUES ($1, $2, $3)`,
    [name.trim(), icon || '📒', color || '#3B82F6']
  );
  return rs.lastInsertId!;
}

/** 重命名账本 */
export async function updateLedger(id: number, name: string, icon?: string, color?: string): Promise<void> {
  await execute(`UPDATE ledgers SET name = $2, icon = $3, color = $4 WHERE id = $1`, [id, name.trim(), icon || '📒', color || '#3B82F6']);
}

/** 删除账本（级联删除其账户、交易、借贷、储蓄与预算数据） */
export async function deleteLedger(id: number): Promise<void> {
  await runInTransaction(async () => {
    await execute(`DELETE FROM transactions WHERE ledger_id = $1`, [id]); // transaction_tags 级联
    await execute(`DELETE FROM loans WHERE ledger_id = $1`, [id]); // loan_repayments 级联
    await execute(`DELETE FROM savings_goals WHERE ledger_id = $1`, [id]);
    await execute(`DELETE FROM budgets WHERE ledger_id = $1`, [id]);
    await execute(`DELETE FROM accounts WHERE ledger_id = $1`, [id]);
    await execute(`DELETE FROM ledgers WHERE id = $1`, [id]);
  });
}

export async function getActiveLedger(): Promise<number> {
  return getActiveLedgerId();
}

export async function setActiveLedger(id: number): Promise<void> {
  await setActiveLedgerId(id);
}

// ---------------- 账本间数据复制迁移 ----------------

export interface CopyReport {
  sourceId: number;
  sourceName: string;
  targetId: number;
  targetName: string;
  accounts: number;
  loans: number;
  transactions: number;
  loanRepayments: number;
  savingsGoals: number;
  budgets: number;
  recurring: number;
  holdings: number;
  skipped: number; // 因源账本内引用缺失（孤儿账户/贷款）而跳过的行数
}

interface Row {
  [col: string]: unknown;
}

/** 复制源账本数据到目标账本（跨表复制 + 关联 ID 重映射）
 *  规则：
 *  - 账户/贷款/交易/储蓄目标/预算/周期任务按源账本复制到目标账本
 *  - 分类(categories)与标签(tags)为全局共享，直接沿用（category_id/tag_id 不做映射）
 *  - 所有内部引用（account_id / loan_id / to_account_id / goal_id...）按新建 ID 重映射，
 *    保证目标账本内的关联完整性
 */
export async function copyLedgerData(sourceId: number, targetId: number): Promise<CopyReport> {
  if (sourceId === targetId) throw new Error('源账本与目标账本相同，无需复制');

  const [src] = await select<{ name: string }>(`SELECT name FROM ledgers WHERE id = $1`, [sourceId]);
  if (!src) throw new Error('源账本不存在');
  const [dst] = await select<{ name: string }>(`SELECT name FROM ledgers WHERE id = $1`, [targetId]);
  if (!dst) throw new Error('目标账本不存在');

  return runInTransaction(async () => {
    let skipped = 0;

    // 1--- 账户：记录 原ID → 新ID 映射
    const accountMap = new Map<number, number>();
    const accounts = await select<Row>(
      `SELECT name, type, balance, initial_balance, icon, color, is_active, sort_order, note, created_at
       FROM accounts WHERE ledger_id = $1 ORDER BY id`, [sourceId]
    );
    for (const a of accounts) {
      const r = await execute(
        `INSERT INTO accounts
          (name, type, balance, initial_balance, icon, color, is_active, sort_order, note, created_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [a.name, a.type, a.balance, a.initial_balance, a.icon, a.color, a.is_active, a.sort_order, a.note, a.created_at, targetId]
      );
      if (r.lastInsertId) accountMap.set(Number(a.id), r.lastInsertId);
    }

    // 2--- 贷款：记录 原ID → 新ID 映射
    const loanMap = new Map<number, number>();
    const loans = await select<Row>(
      `SELECT direction, counterparty, principal, remaining, account_id, date, due_date, rate, periods,
              compound, method, first_repay_date, repay_day, note, status, accrued_interest,
              interest_accrued_until, created_at
       FROM loans WHERE ledger_id = $1 ORDER BY id`, [sourceId]
    );
    for (const l of loans) {
      const r = await execute(
        `INSERT INTO loans
          (direction, counterparty, principal, remaining, account_id, date, due_date, rate, periods,
           compound, method, first_repay_date, repay_day, note, status, accrued_interest,
           interest_accrued_until, created_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [l.direction, l.counterparty, l.principal, l.remaining,
         mapId(accountMap, l.account_id as number | null),
         l.date, l.due_date, l.rate, l.periods, l.compound, l.method,
         l.first_repay_date, l.repay_day, l.note, l.status, l.accrued_interest,
         l.interest_accrued_until, l.created_at, targetId]
      );
      if (r.lastInsertId) loanMap.set(Number(l.id), r.lastInsertId);
    }

    // 3--- 贷款还款记录：重映射 loan_id / account_id
    let loanRepayments = 0;
    const rp = await select<Row>(
      `SELECT lr.loan_id, lr.amount, lr.interest, lr.period, lr.account_id, lr.date, lr.note, lr.created_at
       FROM loan_repayments lr
       JOIN loans l ON lr.loan_id = l.id
       WHERE l.ledger_id = $1 ORDER BY lr.id`, [sourceId]
    );
    for (const r of rp) {
      const newLoanId = loanMap.get(Number(r.loan_id));
      if (!newLoanId) { skipped++; continue; } // 源借贷不存在（孤儿引用），跳过并计入 skipped
      await execute(
        `INSERT INTO loan_repayments
          (loan_id, amount, interest, period, account_id, date, note, created_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newLoanId, r.amount, r.interest, r.period, mapId(accountMap, r.account_id as number | null),
         r.date, r.note, r.created_at, targetId]
      );
      loanRepayments++;
    }

    // 4--- 交易：重映射 account_id / to_account_id / loan_id，并复制标签关联
    const txMap = new Map<number, number>();
    const txs = await select<Row>(
      `SELECT type, amount, category_id, account_id, to_account_id, loan_id, date, note,
              pay_time, pay_method, payee, order_no, merchant_order_no, created_at, updated_at
       FROM transactions WHERE ledger_id = $1 ORDER BY id`, [sourceId]
    );
    for (const t of txs) {
      // 必填账户引用：若指向源账本内不存在的账户（孤儿引用），跳过该行避免插入 account_id=0
      // 触发外键失败而整体回滚；loan_id 为可空引用，缺失时置 null 即可。
      const accId = mapId(accountMap, t.account_id as number | null);
      if (accId == null) { skipped++; continue; }
      const r = await execute(
        `INSERT INTO transactions
          (type, amount, category_id, account_id, to_account_id, loan_id, date, note,
           pay_time, pay_method, payee, order_no, merchant_order_no, created_at, updated_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [t.type, t.amount, t.category_id ?? null, accId,
         mapId(accountMap, t.to_account_id as number | null),
         mapId(loanMap, t.loan_id as number | null),
         t.date, t.note, t.pay_time ?? null, t.pay_method ?? null, t.payee ?? null,
         t.order_no ?? null, t.merchant_order_no ?? null,
         t.created_at, t.updated_at, targetId]
      );
      if (!r.lastInsertId) continue;
      txMap.set(Number(t.id), r.lastInsertId);
    }

    // 交易标签关联（tag 全局限共享，保留原 tag_id）
    for (const [oldTxId, newTxId] of txMap) {
      const tags = await select<{ tag_id: number }>(
        `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1`, [oldTxId]
      );
      for (const tg of tags) {
        await execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [newTxId, tg.tag_id]);
      }
    }

    // 5--- 储蓄目标 + 目标账户关联：重映射 account_id / auto_account_id / goal_id
    const goalMap = new Map<number, number>();
    const goals = await select<Row>(
      `SELECT name, target_amount, current_amount, account_id, target_date, icon, color, status,
              auto_monthly, auto_account_id, auto_day, last_auto_month, note, created_at
       FROM savings_goals WHERE ledger_id = $1 ORDER BY id`, [sourceId]
    );
    for (const g of goals) {
      const r = await execute(
        `INSERT INTO savings_goals
          (name, target_amount, current_amount, account_id, target_date, icon, color, status,
           auto_monthly, auto_account_id, auto_day, last_auto_month, note, created_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [g.name, g.target_amount, g.current_amount, mapId(accountMap, g.account_id as number | null),
         g.target_date, g.icon, g.color, g.status, g.auto_monthly,
         mapId(accountMap, g.auto_account_id as number | null),
         g.auto_day, g.last_auto_month, g.note, g.created_at, targetId]
      );
      if (!r.lastInsertId) continue;
      goalMap.set(Number(g.id), r.lastInsertId);
    }
    // savings_goal_accounts 关联
    for (const [oldGoalId, newGoalId] of goalMap) {
      const links = await select<{ account_id: number }>(
        `SELECT account_id FROM savings_goal_accounts WHERE goal_id = $1`, [oldGoalId]
      );
      for (const ln of links) {
        const accId = mapId(accountMap, ln.account_id);
        if (accId == null) continue;
        await execute(`INSERT INTO savings_goal_accounts (goal_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [newGoalId, accId]);
      }
    }

    // 5b--- 投资持仓：重映射 account_id（账户 balance 已随账户复制，持仓成本/现价原样保留）
    let holdings = 0;
    const holdingRows = await select<Row>(
      `SELECT h.symbol, h.name, h.quantity, h.cost, h.price, h.note, h.created_at, h.updated_at, h.account_id
       FROM account_holdings h
       JOIN accounts a ON h.account_id = a.id
       WHERE a.ledger_id = $1 ORDER BY h.id`, [sourceId]
    );
    for (const h of holdingRows) {
      const accId = mapId(accountMap, h.account_id as number | null);
      if (accId == null) { skipped++; continue; } // 孤儿账户引用，跳过（计入 skipped）
      await execute(
        `INSERT INTO account_holdings (account_id, symbol, name, quantity, cost, price, note, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [accId, h.symbol, h.name, h.quantity, h.cost, h.price, h.note, h.created_at, h.updated_at]
      );
      holdings++;
    }

    // 6--- 预算：category_id 全局共享
    let budgets = 0;
    const budgetRows = await select<Row>(
      `SELECT category_id, amount, period, start_date, end_date, created_at
       FROM budgets WHERE ledger_id = $1 ORDER BY id`, [sourceId]
    );
    for (const b of budgetRows) {
      await execute(
        `INSERT INTO budgets (category_id, amount, period, start_date, end_date, created_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [b.category_id ?? null, b.amount, b.period, b.start_date, b.end_date, b.created_at, targetId]
      );
      budgets++;
    }

    // 7--- 周期任务：重映射 account_id / to_account_id，category_id 共享
    let recurring = 0;
    const recRows = await select<Row>(
      `SELECT type, amount, category_id, account_id, to_account_id, note, frequency, interval,
              start_date, end_date, next_run, last_run, is_active, created_at
       FROM recurring_transactions WHERE ledger_id = $1 ORDER BY id`, [sourceId]
    );
    for (const r of recRows) {
      // 必填账户引用：孤儿账户跳过（同交易逻辑）
      const accId = mapId(accountMap, r.account_id as number | null);
      if (accId == null) { skipped++; continue; }
      await execute(
        `INSERT INTO recurring_transactions
          (type, amount, category_id, account_id, to_account_id, note, frequency, interval,
           start_date, end_date, next_run, last_run, is_active, created_at, ledger_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [r.type, r.amount, r.category_id ?? null, accId,
         mapId(accountMap, r.to_account_id as number | null), r.note, r.frequency, r.interval,
         r.start_date, r.end_date, r.next_run, r.last_run, r.is_active, r.created_at, targetId]
      );
      recurring++;
    }

    return {
      sourceId, sourceName: src.name,
      targetId, targetName: dst.name,
      accounts: accountMap.size,
      loans: loanMap.size,
      transactions: txMap.size,
      loanRepayments,
      savingsGoals: goalMap.size,
      budgets,
      recurring,
      holdings,
      skipped,
    };
  });
}

/** 根据映射返回新 id；原值为空/不在映射中时返回 null */
function mapId(map: Map<number, number>, id: number | null): number | null {
  if (id == null) return null;
  return map.get(id) ?? null;
}