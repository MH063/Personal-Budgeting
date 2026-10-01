import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { getLedgerInvestmentMarketValue } from './holdings';
import { recordToTrash } from './trash';
import { syncVirtualAccounts, getAccountNetFlow } from './transactions';
import { recordAudit } from './audit';

export interface Account {
  id: number;
  name: string;
  type: string;
  balance: number;
  initial_balance: number;
  icon: string;
  color: string;
  is_active: number;
  sort_order: number;
  note: string;
}

export async function listAccounts(activeOnly = true): Promise<Account[]> {
  const ledger = currentLedgerId();
  const cond = activeOnly ? ' AND is_active = 1' : '';
  return select<Account>(`SELECT * FROM accounts WHERE ledger_id = $1${cond} ORDER BY sort_order, id`, [ledger]);
}

export async function createAccount(p: {
  name: string; type: string; initialBalance?: number; icon?: string; color?: string; note?: string;
}): Promise<number> {
  return runInTransaction(async () => {
    const ledger = currentLedgerId();
    const r = await execute(
      `INSERT INTO accounts
        (name, type, balance, initial_balance, icon, color, note, sort_order, ledger_id)
       VALUES ($1,$2,$3,$3,$4,$5,$6,0,$7)`,
      [p.name, p.type, p.initialBalance ?? 0, p.icon ?? '', p.color ?? '#6B7280', p.note ?? '', ledger]
    );
    return r.lastInsertId as number;
  });
}

/**
 * 更新账户（局部字段）。
 *
 * 关于「金额」：用户所说的“账户金额”就是界面上显示的**当前余额**。因此这里支持直接校正
 * 当前余额（p.balance），并按「余额 = 初始余额 + Σ流水净影响」反推初始余额：
 *   `initial_balance = 目标余额 − Σ流水`
 * 这样既让用户所见即所得地改到金额，又保持与「重算账户余额」同一口径——
 * 后续重算不会把用户刚才的设置覆盖掉（因为 initial + Σ流水 恰好等于目标余额）。
 */
export async function updateAccount(id: number, p: Partial<Account>): Promise<void> {
  const set: string[] = [];
  const params: unknown[] = [];
  // 校正当前余额 → 反推初始余额，保证「重算」幂等（不会改回旧值）
  if (p.balance !== undefined) {
    const target = Number(p.balance) || 0;
    const flow = await getAccountNetFlow(id);
    set.push(`balance = $${params.length + 1}`); params.push(target);
    set.push(`initial_balance = $${params.length + 1}`); params.push(target - flow);
  }
  if (p.name !== undefined) { set.push(`name = $${params.length + 1}`); params.push(p.name); }
  if (p.type !== undefined) { set.push(`type = $${params.length + 1}`); params.push(p.type); }
  if (p.icon !== undefined) { set.push(`icon = $${params.length + 1}`); params.push(p.icon); }
  if (p.color !== undefined) { set.push(`color = $${params.length + 1}`); params.push(p.color); }
  if (p.note !== undefined) { set.push(`note = $${params.length + 1}`); params.push(p.note); }
  if (set.length) { params.push(id); await execute(`UPDATE accounts SET ${set.join(', ')} WHERE id = $${params.length}`, params); }
}

export async function setAccountActive(id: number, active: boolean): Promise<void> {
  await execute(`UPDATE accounts SET is_active = $1 WHERE id = $2`, [active ? 1 : 0, id]);
}

/**
 * 将账户余额清零（删除账户前的必需步骤）。
 *
 * 为什么要先清零：账户被删除后整行消失，其余额会直接从「净资产」里消失。
 * 若不先明确清零，用户会看到资产凭空减少且无从追溯。因此这里：
 *  1) 把余额置 0，并把初始余额设为 `−Σ流水`（保证之后「重算账户余额」不会把它改回去）；
 *  2) 写入一条「账户调整」审计记录（kind=account_adjust），使这次变动可追溯。
 *
 * @returns 被清零前的余额（已是 0 则返回 0）
 */
export async function zeroAccountBalance(id: number): Promise<number> {
  return runInTransaction(async () => {
    const [acc] = await select<{ name: string; balance: number }>(
      `SELECT name, balance FROM accounts WHERE id = $1`, [id]
    );
    if (!acc) throw new Error('账户不存在');
    const before = Number(acc.balance ?? 0);
    if (Math.abs(before) < 0.005) return 0; // 已经是 0，无需调整

    const flow = await getAccountNetFlow(id);
    await execute(`UPDATE accounts SET balance = 0, initial_balance = $1 WHERE id = $2`, [-flow, id]);
    // 留痕：审计写入失败不影响清零本身，但会提示可追溯性下降
    await recordAudit({
      kind: 'account_adjust',
      source: 'user',
      action: `账户「${acc.name}」余额清零`,
      before: `balance=${before}`,
      after: 'balance=0',
      basis: '删除账户前清零，避免资产凭空从净资产消失',
      method: 'zeroAccountBalance',
    });
    return before;
  });
}

/** 删除账户。
 *  前置校验：
 *   - 若账户被交易、借贷或储蓄目标引用，拒绝删除（防止产生孤儿数据）；
 *   - 若账户余额不为 0，拒绝删除（否则这笔钱会凭空从净资产消失）——
 *     用户可先编辑账户把余额改为 0，或改用「停用账户」，也可走「清零并删除」。
 *  删除前把账户快照写入回收站，支持恢复。
 */
export async function deleteAccount(id: number): Promise<void> {
  return runInTransaction(async () => {
    const [acc0] = await select<{ name: string; balance: number }>(
      `SELECT name, balance FROM accounts WHERE id = $1`, [id]
    );
    if (!acc0) return;
    if (Math.abs(Number(acc0.balance ?? 0)) >= 0.005) {
      throw new Error(
        `账户「${acc0.name}」当前余额 ¥${Number(acc0.balance).toFixed(2)}，不能直接删除（否则这笔钱会凭空从净资产消失）。` +
        `请先编辑账户把余额改为 0，或改用「停用账户」；也可使用「清零并删除」。`
      );
    }
    const [txn] = await select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM transactions WHERE account_id = $1 OR to_account_id = $1`, [id]
    );
    if (txn.n > 0) {
      throw new Error('该账户存在交易记录，无法删除。请先删除相关交易，或将账户改为停用。');
    }
    const [loan] = await select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM loans WHERE account_id = $1`, [id]
    );
    if (loan.n > 0) {
      throw new Error('该账户关联借贷记录，无法删除。');
    }
    const [goal] = await select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM savings_goals WHERE account_id = $1`, [id]
    );
    if (goal.n > 0) {
      throw new Error('该账户关联储蓄目标，无法删除。');
    }
    const [acc] = await select<Record<string, unknown>>(`SELECT * FROM accounts WHERE id = $1`, [id]);
    if (acc) await recordToTrash('account', id, acc);
    await execute(`DELETE FROM accounts WHERE id = $1`, [id]);
  });
}

// 合并账户时需同步迁走的引用表：交易出/入账方、借贷、储蓄目标、持仓
// 余额随资金本体一并并入目标账户后删除来源账户，全程在一个事务内，保证数据一致性。
interface AccountRow extends Account { ledger_id: number; }

/** 合并账户：把来源账户（fromId）的资金往来与余额并入目标账户（toId），随后删除来源账户。
 *  前置校验（统一防御逻辑性错误）：
 *  - 来源/目标必须存在且属于同一账本（跨账本合并会串账）；
 *  - 禁止自环（fromId === toId）；
 *  - 类型必须一致（尤其禁止现金/银行吞掉信用卡负债，防止净资产口径被破坏）。
 *  所有引用表迁移 + 余额累加在同一事务内，任一步失败整体回滚。来源账户快照写入回收站以便追溯。 */
export async function mergeAccounts(fromId: number, toId: number): Promise<void> {
  if (fromId === toId) throw new Error('不能将账户合并到它自身。');
  return runInTransaction(async () => {
    const [from] = await select<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [fromId]);
    const [to] = await select<AccountRow>(`SELECT * FROM accounts WHERE id = $1`, [toId]);
    if (!from || !to) throw new Error('账户不存在，无法合并。');
    if (from.ledger_id !== to.ledger_id) throw new Error('两个账户不属于同一账本，无法合并。');
    if (from.type !== to.type) {
      throw new Error(`账户类型不同（「${from.name}」为${from.type}，目标为${to.type}），无法直接合并，请先将类型调整一致。`);
    }
    // 迁移所有引用来源账户的关联表指向目标账户
    await execute(`UPDATE transactions SET account_id = $1 WHERE account_id = $2`, [toId, fromId]);
    await execute(`UPDATE transactions SET to_account_id = $1 WHERE to_account_id = $2`, [toId, fromId]);
    await execute(`UPDATE loans SET account_id = $1 WHERE account_id = $2`, [toId, fromId]);
    await execute(`UPDATE savings_goals SET account_id = $1 WHERE account_id = $2`, [toId, fromId]);
    await execute(`UPDATE savings_goals SET auto_account_id = $1 WHERE auto_account_id = $2`, [toId, fromId]);
    await execute(`UPDATE account_holdings SET account_id = $1 WHERE account_id = $2`, [toId, fromId]);
    // 来源余额并入目标（同一类型，余额口径一致，直接累加）
    await execute(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [from.balance, toId]);
    // 来源账户快照写入回收站，便于追溯（恢复后为独立账户，不自动回拨流水）
    await recordToTrash('account', fromId, from as unknown as Record<string, unknown>);
    await execute(`DELETE FROM accounts WHERE id = $1`, [fromId]);
    await syncVirtualAccounts();
  });
}

/** 账户类型汇总（供净资产展示；投资类型含持仓市值）。
 *  口径说明：**包含停用账户**——停用只是归档，钱仍在账上，
 *  必须与 getNetWorth（未按 is_active 过滤）保持一致；此前这里排除停用账户会与净资产对不上。 */
export async function getAccountTotals(): Promise<{ type: string; total: number }[]> {
  const ledger = currentLedgerId();
  const rows = await select<{ type: string; total: number }>(
    `SELECT type, COALESCE(SUM(balance),0) AS total FROM accounts WHERE ledger_id = $1 GROUP BY type`,
    [ledger]
  );
  const mv = await getLedgerInvestmentMarketValue();
  if (mv) {
    const inv = rows.find((r) => r.type === 'investment');
    if (inv) inv.total += mv;
    else rows.push({ type: 'investment', total: mv });
  }
  return rows;
}

// 不应出现负余额的账户类型（现金/银行/电子钱包/投资/储蓄）。
// 信用卡与应收/应付款不属于此类：信用卡本身可为负、应收/应付为虚拟账户。
const NO_NEGATIVE_TYPES = ['cash', 'bank', 'ewallet', 'investment', 'savings'];

/** 返回因记账（支出/转账/借出等）导致余额为负的受限账户，用于保存后提示用户 */
export async function listNegativeAccounts(): Promise<Account[]> {
  const ledger = currentLedgerId();
  const ph = NO_NEGATIVE_TYPES.map((_, i) => `$${i + 2}`).join(',');
  return select<Account>(
    `SELECT * FROM accounts WHERE ledger_id = $1 AND is_active = 1 AND type IN (${ph}) AND balance < 0`,
    [ledger, ...NO_NEGATIVE_TYPES]
  );
}