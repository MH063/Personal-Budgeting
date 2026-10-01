import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { recordToTrash } from './trash';

export interface TxPayload {
  type: 'income' | 'expense' | 'transfer' | 'lend' | 'borrow' | 'repay_in' | 'repay_out';
  amount: number;
  categoryId?: number;
  accountId: number;
  toAccountId?: number;
  loanId?: number;
  date: string;
  note?: string;
  /** 支付时间（可选，如 `2026-09-27 19:02:40`） */
  payTime?: string;
  /** 付款方式（可选，如 `微信支付`/`支付宝`/`银行卡`） */
  payMethod?: string;
  /** 收款方全称（可选） */
  payee?: string;
  /** 订单号（可选） */
  orderNo?: string;
  /** 商家订单号（可选） */
  merchantOrderNo?: string;
  tagIds?: number[];
}

const VALID_TYPES: TxPayload['type'][] = ['income', 'expense', 'transfer', 'lend', 'borrow', 'repay_in', 'repay_out'];

/**
 * 日期(date)与支付时间(payTime)联动归一化（纯函数，便于单测）。
 * date 是账务归属日（粒度到日）、payTime 是实际支付时刻（含时分秒），二者同源但维度不同。
 * 规则：date 已有值则保持不变（payTime 不反向覆盖记账日）；
 * 否则若 payTime 含日期（形如 `YYYY-MM-DD ...`），用其日期部分补全 date，保证「记账日 = 支付日」。
 * @returns 归一化后的 date；无法补全时返回空串（由上层校验兜底）
 */
export function resolveBookDate(date?: string, payTime?: string): string {
  if (date) return date;
  if (!payTime) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(payTime).trim());
  return m ? m[1] : '';
}

/** 校验交易入参（纯函数，便于单元测试）：金额必须为有限正数、账户与日期必填合法、类型合法。
 *  返回错误信息；合法时返回 null。 */
export function validateTxPayload(p: TxPayload): string | null {
  if (!p || typeof p !== 'object') return '交易参数无效';
  if (!VALID_TYPES.includes(p.type)) return '交易类型不合法';
  if (!Number.isFinite(p.amount) || p.amount <= 0) return '金额必须为大于 0 的有效数字';
  if (!Number.isInteger(p.accountId) || p.accountId <= 0) return '请选择有效账户';
  if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || Number.isNaN(Date.parse(p.date))) return '日期格式不正确';
  if (p.type === 'transfer' && (!Number.isInteger(p.toAccountId) || !p.toAccountId)) return '转账必须指定转入账户';
  return null;
}

export interface Transaction {
  id: number;
  type: TxPayload['type'];
  amount: number;
  category_id: number | null;
  account_id: number;
  to_account_id: number | null;
  loan_id: number | null;
  date: string;
  note: string;
  pay_time: string | null;
  pay_method: string | null;
  payee: string | null;
  order_no: string | null;
  merchant_order_no: string | null;
  created_at: string;
  updated_at: string;
  reconciliation_id?: number | null; // 银行对账归属批次（0 无此字段迁移时undefined）
}

export async function listTransactions(opts: {
  type?: string;
  accountId?: number;
  from?: string;
  to?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  categoryId?: number;
  tagIds?: number[];
  limit?: number;
  offset?: number;
} = {}): Promise<Transaction[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  conds.push(`t.ledger_id = $1`);
  params.push(currentLedgerId());
  if (opts.type) { conds.push(`t.type = $${params.length + 1}`); params.push(opts.type); }
  if (opts.accountId) { conds.push(`(t.account_id = $${params.length + 1} OR t.to_account_id = $${params.length + 1})`); params.push(opts.accountId); }
  if (opts.from) { conds.push(`t.date >= $${params.length + 1}`); params.push(opts.from); }
  if (opts.to) { conds.push(`t.date <= $${params.length + 1}`); params.push(opts.to); }
  // 关键词检索：覆盖备注 + 交易明细 5 字段（收款方/订单号/商家订单号/付款方式/支付时间），便于对账查单
  if (opts.search) {
    const p = params.length + 1;
    conds.push(`(t.note LIKE $${p} OR t.payee LIKE $${p} OR t.order_no LIKE $${p}
      OR t.merchant_order_no LIKE $${p} OR t.pay_method LIKE $${p} OR t.pay_time LIKE $${p})`);
    params.push(`%${opts.search}%`);
  }
  if (opts.minAmount !== undefined) { conds.push(`t.amount >= $${params.length + 1}`); params.push(opts.minAmount); }
  if (opts.maxAmount !== undefined) { conds.push(`t.amount <= $${params.length + 1}`); params.push(opts.maxAmount); }
  if (opts.categoryId) { conds.push(`t.category_id = $${params.length + 1}`); params.push(opts.categoryId); }
  if (opts.tagIds && opts.tagIds.length) {
    const tph = opts.tagIds.map((_, i) => `$${params.length + i + 1}`).join(', ');
    conds.push(`EXISTS(SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id IN (${tph}))`);
    params.push(...opts.tagIds);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const limit = opts.limit ?? 200;
  params.push(limit);
  let limitSql = ` LIMIT $${params.length}`;
  if (opts.offset) { params.push(opts.offset); limitSql += ` OFFSET $${params.length}`; }
  return select<Transaction>(
    `SELECT t.* FROM transactions t${where} ORDER BY t.date DESC, t.id DESC${limitSql}`,
    params
  );
}

export interface TransactionDetail extends Transaction {
  category_name: string | null;
  category_icon: string | null;
  account_name: string;
  account_icon: string;
  account_type: string;
  to_account_name: string | null;
}

/** 包含账户/分类名称的列表查询 */
export async function listTransactionsDetailed(opts: {
  type?: string;
  accountId?: number;
  from?: string;
  to?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  categoryId?: number;
  tagIds?: number[];
  limit?: number;
  offset?: number;
} = {}): Promise<TransactionDetail[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  conds.push(`t.ledger_id = $1`);
  params.push(currentLedgerId());
  if (opts.type) { conds.push(`t.type = $${params.length + 1}`); params.push(opts.type); }
  if (opts.accountId) { conds.push(`(t.account_id = $${params.length + 1} OR t.to_account_id = $${params.length + 1})`); params.push(opts.accountId); }
  if (opts.from) { conds.push(`t.date >= $${params.length + 1}`); params.push(opts.from); }
  if (opts.to) { conds.push(`t.date <= $${params.length + 1}`); params.push(opts.to); }
  // 关键词检索：覆盖备注 + 交易明细 5 字段（收款方/订单号/商家订单号/付款方式/支付时间），便于对账查单
  if (opts.search) {
    const p = params.length + 1;
    conds.push(`(t.note LIKE $${p} OR t.payee LIKE $${p} OR t.order_no LIKE $${p}
      OR t.merchant_order_no LIKE $${p} OR t.pay_method LIKE $${p} OR t.pay_time LIKE $${p})`);
    params.push(`%${opts.search}%`);
  }
  if (opts.minAmount !== undefined) { conds.push(`t.amount >= $${params.length + 1}`); params.push(opts.minAmount); }
  if (opts.maxAmount !== undefined) { conds.push(`t.amount <= $${params.length + 1}`); params.push(opts.maxAmount); }
  if (opts.categoryId) { conds.push(`t.category_id = $${params.length + 1}`); params.push(opts.categoryId); }
  if (opts.tagIds && opts.tagIds.length) {
    const tph = opts.tagIds.map((_, i) => `$${params.length + i + 1}`).join(', ');
    conds.push(`EXISTS(SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id IN (${tph}))`);
    params.push(...opts.tagIds);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const limit = opts.limit ?? 200;
  params.push(limit);
  let limitSql = ` LIMIT $${params.length}`;
  if (opts.offset) { params.push(opts.offset); limitSql += ` OFFSET $${params.length}`; }
  return select<TransactionDetail>(
    `SELECT t.*,
       c.name AS category_name, c.icon AS category_icon,
       a.name AS account_name, a.icon AS account_icon, a.type AS account_type,
       ta.name AS to_account_name
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     LEFT JOIN accounts a ON t.account_id = a.id
     LEFT JOIN accounts ta ON t.to_account_id = ta.id
     ${where} ORDER BY t.date DESC, t.id DESC${limitSql}`,
    params
  );
}

/** 写入一笔交易并更新账户余额（事务内）。写库前统一做入参校验。 */
export async function createTransaction(p: TxPayload): Promise<number> {
  const err = validateTxPayload(p);
  if (err) throw new Error(err);
  return runInTransaction(async () => {
    const now = new Date().toISOString();
    const result = await execute(
      `INSERT INTO transactions
        (type, amount, category_id, account_id, to_account_id, loan_id, date, note,
         pay_time, pay_method, payee, order_no, merchant_order_no,
         created_at, updated_at, ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [p.type, p.amount, p.categoryId ?? null, p.accountId, p.toAccountId ?? null,
       p.loanId ?? null, p.date, p.note ?? '',
       p.payTime ?? null, p.payMethod ?? null, p.payee ?? null,
       p.orderNo ?? null, p.merchantOrderNo ?? null,
       now, now, currentLedgerId()]
    );
    await assertTransferTarget(p.type, p.toAccountId, p.accountId);
    await applyBalance(p);
    await syncVirtualAccounts();
    // 同事务内写入标签关联
    await setTxTags(result.lastInsertId as number, p.tagIds);
    return result.lastInsertId as number;
  });
}

export async function deleteTransaction(id: number): Promise<void> {
  return runInTransaction(async () => {
    const rows = await select<Transaction>(`SELECT * FROM transactions WHERE id = $1`, [id]);
    const tx = rows[0];
    if (!tx) return;
    // 贷款生成的交易由借贷模块整体管理，禁止单独删除（否则借贷余额/虚拟账户会不一致）
    if (tx.loan_id) {
      throw new Error('贷款生成的交易不能单独删除，请到「借贷」页删除对应的贷款记录。');
    }
    // 删除前把交易及标签关联写入回收站（同一事务），供恢复
    const tags = await select<{ tag_id: number }>(`SELECT tag_id FROM transaction_tags WHERE transaction_id = $1`, [id]);
    await recordToTrash('transaction', id, { ...tx }, { tags: tags.map((r) => r.tag_id) });
    await reverseBalance(tx);
    await execute(`DELETE FROM transactions WHERE id = $1`, [id]);
    await syncVirtualAccounts();
  });
}

export async function updateTransaction(id: number, p: TxPayload): Promise<void> {
  const err = validateTxPayload(p);
  if (err) throw new Error(err);
  return runInTransaction(async () => {
    const rows = await select<Transaction>(`SELECT * FROM transactions WHERE id = $1`, [id]);
    const old = rows[0];
    if (!old) return;
    // 贷款生成的交易不能直接编辑，避免金额/方向与 loans.remaining 及还款记录错位
    if (old.loan_id) {
      throw new Error('贷款生成的交易不能直接编辑，请到「借贷」页管理对应的贷款。');
    }
    await reverseBalance(old);
    await execute(
      `UPDATE transactions SET
        type=$1, amount=$2, category_id=$3, account_id=$4, to_account_id=$5,
        loan_id=$6, date=$7, note=$8,
        pay_time=$9, pay_method=$10, payee=$11, order_no=$12, merchant_order_no=$13,
        updated_at=$14
       WHERE id=$15`,
      [p.type, p.amount, p.categoryId ?? null, p.accountId, p.toAccountId ?? null,
       p.loanId ?? null, p.date, p.note ?? '',
       p.payTime ?? null, p.payMethod ?? null, p.payee ?? null,
       p.orderNo ?? null, p.merchantOrderNo ?? null,
       new Date().toISOString(), id]
    );
    await assertTransferTarget(p.type, p.toAccountId, p.accountId);
    await applyBalance(p);
    await syncVirtualAccounts();
    await setTxTags(id, p.tagIds);
  });
}

// 在事务内写入某笔交易的标签多对多关联
async function setTxTags(txId: number, tagIds?: number[]) {
  await execute(`DELETE FROM transaction_tags WHERE transaction_id = $1`, [txId]);
  if (tagIds && tagIds.length) {
    const uniq = [...new Set(tagIds)];
    for (const id of uniq) {
      await execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`, [txId, id]);
    }
  }
}

// ---- 虚拟账户余额同步 ----
// 将 receivable/payable 虚拟账户余额设为所有活跃借贷的剩余本金之和
// 这样无论增删改借贷/还款交易，虚拟账户都能保持正确
// 导出供 loans 模块在整个贷款删除后重算
export async function syncVirtualAccounts() {
  // 应收款 = 所有活跃 lend 借贷的剩余本金之和
  const [recvRow] = await select<{ total: number | null }>(
    `SELECT COALESCE(SUM(remaining), 0) AS total FROM loans
     WHERE direction = 'lend' AND status IN ('active', 'overdue') AND ledger_id = $1`,
    [currentLedgerId()]
  );
  // 应付款 = 所有活跃 borrow 借贷的剩余本金之和
  const [payRow] = await select<{ total: number | null }>(
    `SELECT COALESCE(SUM(remaining), 0) AS total FROM loans
     WHERE direction = 'borrow' AND status IN ('active', 'overdue') AND ledger_id = $1`,
    [currentLedgerId()]
  );
  await execute(`UPDATE accounts SET balance = $1 WHERE type = 'receivable' AND ledger_id = $2`, [recvRow?.total ?? 0, currentLedgerId()]);
  await execute(`UPDATE accounts SET balance = $1 WHERE type = 'payable' AND ledger_id = $2`, [payRow?.total ?? 0, currentLedgerId()]);
}

/**
 * 参与「按流水重算余额」的真实账户类型。
 * 排除项及原因：
 *  - `receivable`/`payable`：虚拟账户，余额由 syncVirtualAccounts 按借贷剩余本金重算，与流水无累加关系；
 *  - `investment`：其 balance 是账户内【现金】，买卖持仓时由 adjustCash 直接增减且【不产生流水】，
 *    按流水重算会把持仓买卖造成的现金变动抹掉，故不参与。
 * 其余类型（现金/银行/电子钱包/信用/储蓄）余额完全由流水累加而来，可安全重算。
 */
const RECALC_ACCOUNT_TYPES = ['cash', 'bank', 'ewallet', 'credit', 'savings'];

/**
 * 某账户的「流水净影响」合计 Σ（口径与 recalcAccountBalances 完全一致）。
 *
 * 单账户口径：转入本账户的 transfer、以及 income/borrow/repay_in 记 +；其余出账类型记 −。
 * 供「按当前余额校正账户金额」时反推初始余额使用：initial_balance = 目标余额 − Σ流水。
 */
export async function getAccountNetFlow(accountId: number): Promise<number> {
  const [agg] = await select<{ delta: number | null }>(
    `SELECT COALESCE(SUM(CASE
        WHEN t.type = 'transfer' AND t.to_account_id = $1 THEN t.amount
        WHEN t.account_id = $1 AND t.type IN ('income','borrow','repay_in') THEN t.amount
        ELSE -t.amount
      END), 0) AS delta
     FROM transactions t
     WHERE t.ledger_id = $2 AND (t.account_id = $1 OR t.to_account_id = $1)`,
    [accountId, currentLedgerId()]
  );
  return Number(agg?.delta ?? 0);
}

/**
 * 按流水重算「真实账户」余额（现金 / 银行 / 电子钱包 / 信用 / 储蓄）。
 *
 * 背景：批量导入是「余额中性」的——只写流水、不调用 applyBalance，因此导入进来的
 * 消费/收入/还款不会反映到账户余额上（信用账户负债始终显示为 0）。此函数把每个真实账户
 * 的余额按其名下全部流水重新算一遍，使账户余额与流水一致。
 *
 * 口径：`balance = initial_balance + Σ流水净影响`
 * 方向与 applyBalance 严格一致（income/borrow/repay_in 入账 +；expense/lend/repay_out 出账 −；
 * transfer 出账 −、入账 +），故对「已由记账动作维护过余额」的账户重算是幂等的、不改变结果；
 * 只补上那些「导入写进来、尚未影响余额」的流水。保留 initial_balance 是为了不覆盖用户手工设定的起始余额。
 *
 * 注意：投资账户与应收/应付虚拟账户不参与重算（见 RECALC_ACCOUNT_TYPES 注释）。
 *
 * @returns 余额确实发生变化的账户（含改前/改后），供前端提示；无变化返回空数组
 */
export async function recalcAccountBalances(): Promise<{ id: number; name: string; before: number; after: number }[]> {
  const lid = currentLedgerId();
  const typePh = RECALC_ACCOUNT_TYPES.map((_, i) => `$${i + 2}`).join(', ');
  return runInTransaction(async () => {
    const accs = await select<{ id: number; name: string; balance: number; initial_balance: number | null }>(
      `SELECT id, name, balance, initial_balance FROM accounts
        WHERE ledger_id = $1 AND type IN (${typePh})`,
      [lid, ...RECALC_ACCOUNT_TYPES]
    );
    const changed: { id: number; name: string; before: number; after: number }[] = [];
    for (const a of accs) {
      // 逐笔净影响：转入本账户的 transfer 与 income/borrow/repay_in 记 +，本账户出账的其余类型记 −
      const delta = await getAccountNetFlow(a.id);
      // 不做金额四舍五入：与 applyBalance 的累加行为保持一致，重算才能真正幂等
      const after = (a.initial_balance ?? 0) + delta;
      if (after !== a.balance) {
        await execute(`UPDATE accounts SET balance = $1 WHERE id = $2`, [after, a.id]);
        changed.push({ id: a.id, name: a.name, before: a.balance, after });
      }
    }
    return changed;
  });
}

// ---- 内部：余额变更 ----
// 转账目标限制的由来：receivable/payable 这类「虚拟账户」的余额由 syncVirtualAccounts 按借贷剩余本金重算，
// 若允许转入，则除转出 -X 外虚拟账户还会被重算成 +X，净资产会被放大为 2X，故禁止转到它们。
// 而 credit（花呗/白条/信用卡）是真实账户、余额由流水直接增减：转入即「还款」→ 负债减少，净资产守恒，故允许。
const TRANSFER_TARGET_TYPES = ['cash', 'bank', 'ewallet', 'investment', 'savings', 'credit'];
async function assertTransferTarget(type: TxPayload['type'], toAccountId?: number, accountId?: number) {
  if (type !== 'transfer' || !toAccountId) return;
  // 转账自环拦截：出账与入账必须是不同账户，否则资金原地往返、余额与流水错乱
  if (accountId != null && accountId === toAccountId) {
    throw new Error('转账账户与转入账户不能相同。');
  }
  const [acc] = await select<{ type: string }>(`SELECT type FROM accounts WHERE id = $1`, [toAccountId]);
  if (!acc) throw new Error('转账目标账户不存在');
  if (!TRANSFER_TARGET_TYPES.includes(acc.type)) {
    throw new Error('转账目标必须是现金、银行、电子钱包、投资、储蓄或信用（信用卡/花呗）账户，不能转到该类型账户。');
  }
}

// 不允许出现负余额的实资产账户类型（持卡类/应收应付虚拟账户除外）。
// 支出/转出/借出/还款从前述账户扣款前，必须校验余额充足，避免账户被扣成负余额导致对账失真。
const NO_NEGATIVE_TYPES = ['cash', 'bank', 'ewallet', 'investment', 'savings'];
const BALANCE_ACTION_LABEL: Partial<Record<TxPayload['type'], string>> = {
  expense: '支出', transfer: '转账', lend: '借出', repay_out: '还款',
};
async function assertSufficientBalance(type: TxPayload['type'], accountId: number, amount: number) {
  if (amount <= 0) throw new Error('金额必须大于 0');
  const [acc] = await select<{ name: string; type: string; balance: number }>(
    `SELECT name, type, balance FROM accounts WHERE id = $1`, [accountId]
  );
  if (!acc) throw new Error('账户不存在');
  if (!NO_NEGATIVE_TYPES.includes(acc.type)) return; // 信用卡/虚拟账户不受下限约束
  if (acc.balance < amount - 0.0001) {
    throw new Error(`账户「${acc.name}」余额不足（可用 ${acc.balance.toFixed(2)} < ${amount.toFixed(2)}），无法完成该笔${
      BALANCE_ACTION_LABEL[type] ?? '扣款'}。请调整账户或金额。`);
  }
}

/** 应用一笔交易对账户余额的影响（创建交易时调用；恢复回收站快照时亦复用） */
export async function applyBalance(p: TxPayload) {
  switch (p.type) {
    case 'income':
      await execute(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [p.amount, p.accountId]);
      break;
    case 'expense':
      await assertSufficientBalance('expense', p.accountId, p.amount);
      await execute(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [p.amount, p.accountId]);
      break;
    case 'transfer':
      if (!p.toAccountId) throw new Error('转账必须指定转入账户');
      await assertSufficientBalance('transfer', p.accountId, p.amount);
      await execute(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [p.amount, p.accountId]);
      await execute(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [p.amount, p.toAccountId]);
      break;
    // lend/borrow/repay 只更新真实账户，虚拟账户由 syncVirtualAccounts 统一重算
    case 'lend':
      await assertSufficientBalance('lend', p.accountId, p.amount);
      await execute(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [p.amount, p.accountId]);
      break;
    case 'borrow':
      await execute(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [p.amount, p.accountId]);
      break;
    case 'repay_in':
      await execute(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [p.amount, p.accountId]);
      break;
    case 'repay_out':
      await assertSufficientBalance('repay_out', p.accountId, p.amount);
      await execute(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [p.amount, p.accountId]);
      break;
  }
}

export async function reverseBalance(p: Transaction) {
  const neg: TxPayload = {
    type: p.type, amount: p.amount, categoryId: p.category_id ?? undefined,
    accountId: p.account_id, toAccountId: p.to_account_id ?? undefined,
    loanId: p.loan_id ?? undefined, date: p.date, note: p.note,
  };
  switch (p.type) {
    case 'income': neg.type = 'expense'; break;
    case 'expense': neg.type = 'income'; break;
    case 'transfer':
      await execute(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [p.amount, p.account_id]);
      await execute(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [p.amount, p.to_account_id ?? 0]);
      return;
    case 'lend': neg.type = 'repay_in'; break;
    case 'borrow': neg.type = 'repay_out'; break;
    case 'repay_in': neg.type = 'lend'; break;
    case 'repay_out': neg.type = 'borrow'; break;
  }
  await applyBalance(neg);
}