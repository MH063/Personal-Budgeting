// 银行对账模块
// -----------------------------------------------------------------------------
// 流程：建批次（选账户+期间+期初/银行余额）→ 导入银行流水（xlsx 解析）→
// 自动/手动匹配本地交易 → 查看差异 → 完成锁定（标记 transactions.reconciliation_id）。
// 对账只做「核对/标记」，不改变任何账户余额（与 import.ts 的余额中性一致）。
// -----------------------------------------------------------------------------
import dayjs from 'dayjs';
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { roundMoney } from '@/lib/money';
import { createTransaction } from './transactions';

export type ReconcileStatus = 'draft' | 'locked';

export interface Reconciliation {
  id: number;
  account_id: number;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number;
  bank_balance: number | null;
  calc_balance: number | null;
  diff_total: number;
  status: ReconcileStatus;
  created_at: string;
  ledger_id: number;
}

export interface ReconItem {
  id: number;
  reconciliation_id: number;
  bank_row: string;
  transaction_id: number | null;
  match_kind: string;
  matched_at: string;
}

/** 差异报告中「本地有·银行无」的本地交易条目 */
export interface LocalUnmatchedTx {
  transaction_id: number;
  tx_date: string | null;
  tx_amount: number | null;
  tx_note: string | null;
  account_name: string | null;
}

export interface BankRow {
  date: string;
  summary: string;
  income: number;    // 收入
  expense: number;   // 支出
  balance: number;   // 银行流水余额（可选）
  line: number;      // 原文件行号
}

/** 创建对账批次，返回批次 id */
export async function createReconciliation(p: {
  accountId: number;
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: number;
}): Promise<number> {
  const r = await execute(
    `INSERT INTO reconciliations (account_id, period_start, period_end, opening_balance, ledger_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [p.accountId, p.periodStart ?? null, p.periodEnd ?? null, p.openingBalance ?? 0, currentLedgerId()]
  );
  return r.lastInsertId as number;
}

/** 对账批次列表（含账户名） */
export async function listReconciliations(): Promise<(Reconciliation & { account_name: string })[]> {
  return select(
    `SELECT r.*, a.name AS account_name
     FROM reconciliations r
     LEFT JOIN accounts a ON r.account_id = a.id
     WHERE r.ledger_id = $1
     ORDER BY r.id DESC`,
    [currentLedgerId()]
  );
}

/** 删除对账批次（级联删除明细） */
export async function deleteReconciliation(id: number): Promise<void> {
  await runInTransaction(async () => {
    // 释放该批次标记的交易
    await execute(`UPDATE transactions SET reconciliation_id = NULL WHERE reconciliation_id = $1`, [id]);
    await execute(`DELETE FROM reconciliations WHERE id = $1 AND ledger_id = $2`, [id, currentLedgerId()]);
  });
}

/** 把 Excel 日期转换为 YYYY-MM-DD（纯函数，便于单元测试）。
 *  优先用 dayjs 直接解析字符串；若为 Excel 序列号数字，则按「序列号 → 1899-12-30 起的天数 → UTC 日期」
 *  换算，用 getUTC 取年月日，从而完全不依赖运行环境时区，避免跨时区日期错位一天。 */
export function excelDateToStr(raw: string | number): string {
  const s = typeof raw === 'number' ? String(raw) : (raw ?? '').trim();
  if (!s) return '';
  // Excel 序列号（含小数，纯数字形态）走 UTC 换算；否则交给 dayjs 解析
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    try {
      const date = new Date(Math.round((Number(s) - 25569) * 86400000));
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth() + 1;
      const d = date.getUTCDate();
      if (!Number.isNaN(y) && y > 1970) {
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    } catch {
      /* 换算失败回退到 dayjs */
    }
  }
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD') : '';
}

/** 解析银行对账单（xlsx/xls/csv → 结构化行）。列：日期/摘要/收入/支出/余额 */
export async function parseBankStatement(raw: ArrayBuffer | string): Promise<BankRow[]> {
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.read(raw, { type: typeof raw === 'string' ? 'string' : 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

  // 表头映射：兼容「日期/摘要(备注)/收入/支出/余额」及常见别名
  const headerRow = rows.find((r) => r.some((c) => /日期|时间|date/i.test(String(c ?? '')))) ?? rows[0];
  const idx = headerRow.map((c) => String(c ?? '').trim());
  const colOf = (names: string[]) => idx.findIndex((h) => names.some((n) => h.includes(n)));
  const dateCol = colOf(['日期', '时间', 'date', 'Date']);
  const summaryCol = colOf(['摘要', '备注', '说明', '用途', 'summary', 'note']);
  const incomeCol = colOf(['收入', '存入', '贷方', 'income', 'in']);
  const expenseCol = colOf(['支出', '取出', '借方', 'expense', 'out']);
  const balanceCol = colOf(['余额', 'balance']);
  const dataRows = rows.slice(rows.indexOf(headerRow) + 1);

  const out: BankRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (!r || r.every((c) => c == null || String(c).trim() === '')) continue;
    const rawDate = dateCol >= 0 ? r[dateCol] : undefined;
    const dateStr = typeof rawDate === 'number'
      ? excelDateToStr(rawDate)
      : excelDateToStr(typeof rawDate === 'string' ? rawDate : '');
    const summary = summaryCol >= 0 ? String(r[summaryCol] ?? '').trim() : '';
    const income = incomeCol >= 0 ? Number(r[incomeCol]) || 0 : 0;
    const expense = expenseCol >= 0 ? Math.abs(Number(r[expenseCol])) || 0 : 0;
    const balance = balanceCol >= 0 ? Number(r[balanceCol]) || 0 : 0;
    if (!dateStr || (income === 0 && expense === 0 && !balance)) continue;
    out.push({ date: dateStr, summary, income, expense, balance, line: i + 2 });
  }
  return out;
}

/** 校验并写入银行流水行到批次（逐行写入 items，未匹配） */
export async function importBankRows(recId: number, rows: BankRow[]): Promise<number> {
  return runInTransaction(async () => {
    // 清空该批次已有流水（重新导入）
    await execute(`DELETE FROM reconciliation_items WHERE reconciliation_id = $1 AND match_kind IN ('unmatched_bank','auto','manual','split')`, [recId]);
    let n = 0;
    for (const row of rows) {
      const net = row.income - row.expense;
      if (net === 0 && row.balance !== 0) continue; // 无变动行跳过
      await execute(
        `INSERT INTO reconciliation_items (reconciliation_id, bank_row, match_kind) VALUES ($1,$2,'unmatched_bank')`,
        [recId, JSON.stringify(row)]
      );
      n++;
    }
    return n;
  });
}

/** 银行流水方向：净额为正表示钱进入对账账户（转入），为负表示转出；零变动返回 none */
export function bankDirection(bank: Pick<BankRow, 'income' | 'expense'>): 'in' | 'out' | 'none' {
  const net = roundMoney((Number(bank.income) || 0) - (Number(bank.expense) || 0));
  if (Math.abs(net) <= 0.001) return 'none';
  return net > 0 ? 'in' : 'out';
}

/**
 * 本地交易相对「某个对账账户」的资金方向。
 * 收入/借入/收回借款 → 进账；支出/借出/还款 → 出账；
 * 转账按账户两端判定：钱转入该账户 → in，转出 → out。
 * 历史缺陷：此前转账一律判为 'transfer'，与银行侧的 in/out 永不相等，
 * 导致「银行卡→支付宝」这类转账流水永远无法自动匹配、只能人工配对。
 */
export function txDirectionForAccount(
  tx: { type: string; account_id: number; to_account_id: number | null },
  accountId: number
): 'in' | 'out' | 'none' {
  if (['income', 'borrow', 'repay_in'].includes(tx.type)) return 'in';
  if (['expense', 'lend', 'repay_out'].includes(tx.type)) return 'out';
  if (tx.type === 'transfer') {
    if (tx.to_account_id === accountId) return 'in';
    if (tx.account_id === accountId) return 'out';
  }
  return 'none';
}

/** 把数组按固定大小分块（用于参数化 IN 查询分批，避免超过 SQLite 变量数量上限） */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (!arr.length) return [];
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 自动匹配用到的本地交易精简字段（只取匹配所需，避免拉回整行与关联表） */
interface MatchCandidate {
  id: number;
  type: string;
  amount: number;
  date: string;
  note: string | null;
  account_id: number;
  to_account_id: number | null;
  reconciliation_id: number | null;
}

/**
 * 拉取「可能匹配」的本地交易：仅限对账账户（含转出/转入两端）、批次期间内，
 * 且金额落在银行流水金额集合内的行。
 * 金额用 ROUND(amount,2) IN (...) 分批预筛，避免把期间内全部交易（含大量无关金额）拉回内存。
 */
async function listMatchCandidates(rec: Reconciliation, bankRows: BankRow[]): Promise<MatchCandidate[]> {
  const amounts = [...new Set(
    bankRows
      .map((b) => Math.abs(roundMoney((Number(b.income) || 0) - (Number(b.expense) || 0))))
      .filter((a) => a > 0.001)
      .map((a) => Number(a.toFixed(2)))
  )];
  if (!amounts.length) return [];

  const bankDates = bankRows.map((b) => b.date).filter(Boolean).sort();
  const from = rec.period_start || bankDates[0] || null;
  const to = rec.period_end || bankDates[bankDates.length - 1] || null;

  const conds = ['t.ledger_id = $1', '(t.account_id = $2 OR t.to_account_id = $2)'];
  const params: unknown[] = [currentLedgerId(), rec.account_id];
  if (from) { params.push(from); conds.push(`t.date >= $${params.length}`); }
  if (to) { params.push(to); conds.push(`t.date <= $${params.length}`); }

  const out: MatchCandidate[] = [];
  // 每批 400 个金额：远低于 SQLite 默认参数上限，同时对账单行数通常也在数百量级
  for (const chunk of chunkArray(amounts, 400)) {
    const ph = chunk.map((_, i) => `$${params.length + i + 1}`).join(',');
    const rows = await select<MatchCandidate>(
      `SELECT t.id, t.type, t.amount, t.date, t.note, t.account_id, t.to_account_id, t.reconciliation_id
       FROM transactions t
       WHERE ${conds.join(' AND ')} AND ROUND(t.amount, 2) IN (${ph})
       ORDER BY t.date, t.id`,
      [...params, ...chunk]
    );
    out.push(...rows);
  }
  return out;
}

/** 自动匹配：金额相同 + 日期 ±3 天内 + 备注去除空白后模糊相似（或金额相同且唯一候选） */
export async function matchAuto(recId: number): Promise<{ matched: number; skipped: number }> {
  const [rec] = await select<Reconciliation>(`SELECT * FROM reconciliations WHERE id = $1 AND ledger_id = $2`, [recId, currentLedgerId()]);
  if (!rec) throw new Error('对账批次不存在');

  const bankItems = await select<ReconItem>(
    `SELECT * FROM reconciliation_items WHERE reconciliation_id = $1 AND match_kind = 'unmatched_bank' ORDER BY id`,
    [recId]
  );
  // 解析银行行；坏行（JSON 损坏）直接跳过，不阻断整批匹配（零金额行保留，最终计为 skipped）
  const bankRows: Array<{ item: ReconItem; bank: BankRow }> = [];
  for (const bi of bankItems) {
    try {
      bankRows.push({ item: bi, bank: JSON.parse(bi.bank_row) as BankRow });
    } catch {
      continue;
    }
  }

  // 本批次已被占用的本地交易：一笔本地交易只能对应一条银行流水，
  // 否则重复点「自动匹配」时，同金额的另一条银行行会再次抢走已配对的交易
  const usedRows = await select<{ transaction_id: number }>(
    `SELECT transaction_id FROM reconciliation_items WHERE reconciliation_id = $1 AND transaction_id IS NOT NULL`,
    [recId]
  );
  const usedTxIds = new Set(usedRows.map((r) => r.transaction_id));

  // 候选本地交易：该账户在期间内、未被其他批次占用
  const pool = (await listMatchCandidates(rec, bankRows.map((b) => b.bank)))
    .filter((t) => (t.reconciliation_id == null || t.reconciliation_id === recId) && !usedTxIds.has(t.id));

  let matched = 0;
  let skipped = 0;
  await runInTransaction(async () => {
    for (const { item, bank } of bankRows) {
      const bankAmt = Math.abs(roundMoney((Number(bank.income) || 0) - (Number(bank.expense) || 0)));
      const dir = bankDirection(bank);
      // 按金额 + 方向 + 日期窗筛候选
      const candidates = pool.filter((tx) => {
        if (Math.abs(tx.amount - bankAmt) > 0.001) return false;
        if (txDirectionForAccount(tx, rec.account_id) !== dir) return false;
        return Math.abs(dayjs(tx.date).diff(dayjs(bank.date), 'day')) <= 3;
      });
      // 备注模糊加权：去空白/符号后包含关系
      const norm = (s: string) => s.replace(/[\s\-_（）()/\\]/g, '').toLowerCase();
      const bk = norm(bank.summary ?? '');
      const scored = candidates
        .map((tx) => ({ tx, score: bk && (norm(tx.note ?? '').includes(bk) || bk.includes(norm(tx.note ?? ''))) ? 10 : 0 }))
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return Math.abs(dayjs(a.tx.date).diff(dayjs(bank.date), 'day')) - Math.abs(dayjs(b.tx.date).diff(dayjs(bank.date), 'day'));
        });
      const best = scored[0];
      // 仅当唯一（无并列）或备注强命中时才自动配对
      const unique = scored.length === 1 || scored[0].score > 0;
      if (best && unique && !scored.some((s, i) => i > 0 && s.tx.amount === best.tx.amount && s.score === best.score)) {
        await execute(
          `UPDATE reconciliation_items SET transaction_id = $1, match_kind = 'auto', matched_at = datetime('now','localtime') WHERE id = $2`,
          [best.tx.id, item.id]
        );
        pool.splice(pool.indexOf(best.tx), 1); // 一笔本地交易只配一次
        matched++;
      } else {
        skipped++;
      }
    }
  });
  return { matched, skipped };
}

/** 手动匹配：把某条银行流水关联到指定本地交易（合并模式支持多对一，用 split 记录） */
export async function matchManual(recId: number, itemId: number, txId: number): Promise<void> {
  await execute(
    `UPDATE reconciliation_items SET transaction_id = $1, match_kind = 'manual', matched_at = datetime('now','localtime') WHERE id = $2 AND reconciliation_id = $3`,
    [txId, itemId, recId]
  );
}

/**
 * 忽略某条银行流水（未匹配闭环之一）：标记为 ignored，不再计入待处理差异，也不再阻断锁定。
 * 仅改对账明细状态，不生成交易、不改变任何账户余额。
 */
export async function ignoreBankItem(recId: number, itemId: number): Promise<void> {
  await execute(
    `UPDATE reconciliation_items SET match_kind = 'ignored', transaction_id = NULL, matched_at = datetime('now','localtime')
     WHERE id = $1 AND reconciliation_id = $2`,
    [itemId, recId]
  );
}

/**
 * 由「银行有·本地无」流水一键生成本地交易并直接配对（未匹配闭环之二）。
 * 收入/支出方向按银行行净额判定，日期与摘要沿用银行流水；生成后账户余额随之变动（属于补记真实流水）。
 * @returns 新生成的本地交易 id
 */
export async function createTxFromBankItem(recId: number, itemId: number): Promise<number> {
  return runInTransaction(async () => {
    const [rec] = await select<Reconciliation>(`SELECT * FROM reconciliations WHERE id = $1 AND ledger_id = $2`, [recId, currentLedgerId()]);
    if (!rec) throw new Error('对账批次不存在');
    if (rec.status === 'locked') throw new Error('该批次已锁定，请先解锁再补记流水');
    const [item] = await select<ReconItem>(
      `SELECT * FROM reconciliation_items WHERE id = $1 AND reconciliation_id = $2`,
      [itemId, recId]
    );
    if (!item) throw new Error('银行流水行不存在');
    const bank = JSON.parse(item.bank_row) as BankRow;
    const net = roundMoney(bank.income - bank.expense);
    if (Math.abs(net) <= 0.001) throw new Error('该银行流水无金额变动，无法生成交易');
    const txId = await createTransaction({
      type: net > 0 ? 'income' : 'expense',
      amount: Math.abs(net),
      accountId: rec.account_id,
      date: bank.date,
      note: bank.summary || `对账补记（批次 ${recId}）`,
    });
    await execute(
      `UPDATE reconciliation_items SET transaction_id = $1, match_kind = 'manual', matched_at = datetime('now','localtime') WHERE id = $2`,
      [txId, itemId]
    );
    // 补记的交易立即归属本批次：否则未锁定期间它仍是「无归属」状态，
    // 可能被其他批次的自动匹配抓走，造成同一笔流水被重复对账
    await execute(`UPDATE transactions SET reconciliation_id = $1 WHERE id = $2`, [recId, txId]);
    return txId;
  });
}

/** 余额调节表：把「银行对账单余额」与「本地推算余额」各自调整到可比口径。
 *  - 银行侧调整：＋本地已记·银行未记净额（本地已记收入但银行尚未入账，银行余额偏低）
 *  - 本地侧调整：＋银行已记·本地未记净额（银行已发生但漏记，本地推算余额偏低）
 *  调整后两值应相等（差额为 0 即账实相符）。
 */
export interface BalanceAdjustment {
  /** 银行对账单期末余额（页面输入的银行余额） */
  bankStatement: number | null;
  /** 本地推算余额（期初 + 已匹配银行流水净额） */
  calcBalance: number | null;
  /** 本地已记·银行未记净额（正数表示本地多记了收入） */
  localNotBankNet: number;
  /** 本地已记·银行未记笔数 */
  localNotBankCount: number;
  /** 银行已记·本地未记净额（正数表示银行多入账） */
  bankNotLocalNet: number;
  /** 银行已记·本地未记笔数 */
  bankNotLocalCount: number;
  /** 调整后银行余额 */
  adjustedBank: number | null;
  /** 调整后本地余额 */
  adjustedLocal: number | null;
  /** 调整后差额（0 表示账实相符） */
  difference: number | null;
  /** 差额是否在容差内 */
  balanced: boolean;
}

/** 解析单条银行流水的净额（收入 − 支出），坏行按 0 处理 */
function bankRowNet(raw: string): number {
  try {
    const b = JSON.parse(raw) as BankRow;
    return roundMoney((Number(b.income) || 0) - (Number(b.expense) || 0));
  } catch {
    return 0;
  }
}

/** 构造余额调节表（纯函数，便于单元测试） */
export function buildBalanceAdjustment(input: {
  bankEndBalance: number | null;
  calcBalance: number | null;
  /** 「本地有·银行无」全量净额与笔数（收入为正/支出为负） */
  localNotBankNet: number;
  localNotBankCount: number;
  bankUnmatched: ReconItem[];
  amountMismatch: ReconItem[];
}): BalanceAdjustment {
  const localNotBankNet = roundMoney(input.localNotBankNet);
  const bankRows = [...input.bankUnmatched, ...input.amountMismatch];
  const bankNotLocalNet = roundMoney(bankRows.reduce((s, it) => s + bankRowNet(it.bank_row), 0));

  const adjustedBank = input.bankEndBalance == null ? null : roundMoney(input.bankEndBalance + localNotBankNet);
  const adjustedLocal = input.calcBalance == null ? null : roundMoney(input.calcBalance + bankNotLocalNet);
  const difference = adjustedBank != null && adjustedLocal != null ? roundMoney(adjustedBank - adjustedLocal) : null;

  return {
    bankStatement: input.bankEndBalance,
    calcBalance: input.calcBalance,
    localNotBankNet,
    localNotBankCount: input.localNotBankCount,
    bankNotLocalNet,
    bankNotLocalCount: bankRows.length,
    adjustedBank,
    adjustedLocal,
    difference,
    balanced: difference != null && Math.abs(difference) <= 0.001,
  };
}

/** 拆分匹配：银行流水金额由多笔本地交易构成（每笔记一条 split；原行保留为 unmatched_bank + amount_mismatch 标记） */
export async function matchManualSplit(recId: number, itemId: number, txId: number, portion: number): Promise<void> {
  await runInTransaction(async () => {
    const [item] = await select<ReconItem>(`SELECT * FROM reconciliation_items WHERE id = $1 AND reconciliation_id = $2`, [itemId, recId]);
    if (!item) throw new Error('流水行不存在');
    const bank = JSON.parse(item.bank_row) as BankRow;
    // 原行标记为金额不符，拆分行另存
    await execute(`UPDATE reconciliation_items SET match_kind = 'amount_mismatch' WHERE id = $1`, [itemId]);
    await execute(
      `INSERT INTO reconciliation_items (reconciliation_id, bank_row, transaction_id, match_kind)
       VALUES ($1,$2,$3,'split')`,
      [recId, JSON.stringify({ ...bank, line: bank.line, splitAmount: portion }), txId]
    );
  });
}

/** 批次匹配明细（含本地交易信息） */
export async function listMatches(recId: number): Promise<(ReconItem & {
  tx_date: string | null; tx_amount: number | null; tx_note: string | null; account_name: string | null;
})[]> {
  return select(
    `SELECT ri.*, t.date AS tx_date, t.amount AS tx_amount, t.note AS tx_note, t.account_id AS tx_account_id,
            a.name AS account_name
     FROM reconciliation_items ri
     LEFT JOIN transactions t ON ri.transaction_id = t.id
     LEFT JOIN accounts a ON t.account_id = a.id
     WHERE ri.reconciliation_id = $1
     ORDER BY ri.id`,
    [recId]
  );
}

/** 「本地有·银行无」查询的分页选项 */
export interface LocalUnmatchedPageOpts {
  limit?: number;
  offset?: number;
}

/** 构造「本地有·银行无」查询的 SQL 与参数（纯函数，便于单元测试）。
 *  语义：对账期间内某账户的本地交易中，既未被本批次匹配（items 无关联）、
 *  也未归属其他批次（reconciliation_id 为空）的记录，按日期倒序取指定（默认 200）条。
 *  入参 opts 中 limit/offset 用于差异报告的分页加载。
 */
export function buildLocalUnmatchedQuery(rec: Reconciliation, opts: LocalUnmatchedPageOpts = {}): { sql: string; params: unknown[] } {
  const params: unknown[] = [currentLedgerId(), rec.account_id, rec.id];
  let cond = `t.ledger_id = $1 AND (t.account_id = $2 OR t.to_account_id = $2)
              AND t.reconciliation_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM reconciliation_items ri
                WHERE ri.reconciliation_id = $3 AND ri.transaction_id = t.id
              )`;
  if (rec.period_start) { params.push(rec.period_start); cond += ` AND t.date >= $${params.length}`; }
  if (rec.period_end) { params.push(rec.period_end); cond += ` AND t.date <= $${params.length}`; }
  // 数字类型防御：分页参数可能来自 UI 等外部调用，强制转为非负整数并夹紧范围，
  // 防止 NaN/负数/字符串破坏 LIMIT/OFFSET 拼接（低危但易排查）。
  const limit = Math.min(100000, Math.max(1, Math.floor(Number(opts.limit ?? 200) || 200)));
  const offset = Math.max(0, Math.floor(Number(opts.offset ?? 0) || 0));
  const sql =
    `SELECT t.id AS transaction_id, t.date AS tx_date, t.amount AS tx_amount,
            t.note AS tx_note, a.name AS account_name
     FROM transactions t
     LEFT JOIN accounts a ON t.account_id = a.id
     WHERE ${cond}
     ORDER BY t.date DESC, t.id DESC
     LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params };
}

/** 统计「本地有·银行无」的总条数（与 buildLocalUnmatchedQuery 同一过滤条件，纯函数便于分页/导出）。 */
export function buildLocalUnmatchedCount(rec: Reconciliation): { sql: string; params: unknown[] } {
  const params: unknown[] = [currentLedgerId(), rec.account_id, rec.id];
  let cond = `t.ledger_id = $1 AND (t.account_id = $2 OR t.to_account_id = $2)
              AND t.reconciliation_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM reconciliation_items ri
                WHERE ri.reconciliation_id = $3 AND ri.transaction_id = t.id
              )`;
  if (rec.period_start) { params.push(rec.period_start); cond += ` AND t.date >= $${params.length}`; }
  if (rec.period_end) { params.push(rec.period_end); cond += ` AND t.date <= $${params.length}`; }
  return { sql: `SELECT COUNT(*) AS n FROM transactions t WHERE ${cond}`, params };
}

/** 汇总「本地有·银行无」的交易净额（收入为正/支出为负），供余额调节表使用（不受分页影响）。 */
export function buildLocalUnmatchedSum(rec: Reconciliation): { sql: string; params: unknown[] } {
  const params: unknown[] = [currentLedgerId(), rec.account_id, rec.id];
  let cond = `t.ledger_id = $1 AND (t.account_id = $2 OR t.to_account_id = $2)
              AND t.reconciliation_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM reconciliation_items ri
                WHERE ri.reconciliation_id = $3 AND ri.transaction_id = t.id
              )`;
  if (rec.period_start) { params.push(rec.period_start); cond += ` AND t.date >= $${params.length}`; }
  if (rec.period_end) { params.push(rec.period_end); cond += ` AND t.date <= $${params.length}`; }
  return { sql: `SELECT COALESCE(SUM(t.amount), 0) AS net FROM transactions t WHERE ${cond}`, params };
}

/** 差异报告：按类别汇总 → 推算余额 → 差异金额。
 *  其中 localUnmatched 为「对账期间内存在的本地交易但银行流水中没有对应记录」，
 *  用于双向核对（避免只盯银行行而漏掉本地误记）。
 *  page / pageSize 可控制 localUnmatched 的分页；localUnmatchedTotal 为满足条件的总条数。 */
export async function reconDiffSummary(
  recId: number,
  opts?: { page?: number; pageSize?: number }
): Promise<{
  bankUnmatched: ReconItem[];
  localUnmatched: LocalUnmatchedTx[];
  localUnmatchedTotal: number;
  /** 「本地有·银行无」全量净额（收入为正/支出为负），供余额调节表使用 */
  localUnmatchedNet: number;
  amountMismatch: ReconItem[];
  calcBalance: number | null;
}> {
  const items = await listMatches(recId);
  const [rec] = await select<Reconciliation>(`SELECT * FROM reconciliations WHERE id = $1`, [recId]);
  const bankUnmatched = items.filter((i) => i.match_kind === 'unmatched_bank');
  const amountMismatch = items.filter((i) => i.match_kind === 'amount_mismatch');

  // 本地有·银行无：对账期间内该账户的本地交易中，未被本批次匹配、且未归属其他批次的
  let localUnmatched: LocalUnmatchedTx[] = [];
  let localUnmatchedTotal = 0;
  let localUnmatchedNet = 0;
  if (rec) {
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.max(1, opts?.pageSize ?? 100);
    const offset = (page - 1) * pageSize;
    const { sql, params } = buildLocalUnmatchedQuery(rec, { limit: pageSize, offset });
    localUnmatched = await select<LocalUnmatchedTx>(sql, params);
    const { sql: cntSql, params: cntParams } = buildLocalUnmatchedCount(rec);
    const cnt = await select<{ n: number }>(cntSql, cntParams);
    localUnmatchedTotal = Number(cnt[0]?.n ?? 0);
    // 净额必须用全量汇总，不能用当前页数据（否则余额调节表会随翻页变化）
    const { sql: sumSql, params: sumParams } = buildLocalUnmatchedSum(rec);
    const sum = await select<{ net: number }>(sumSql, sumParams);
    localUnmatchedNet = roundMoney(Number(sum[0]?.net ?? 0));
  }

  // 推算余额 = 期初 + Σ(匹配银行行净额)（以银行流水的 balance 或净额为准）
  const matched = items.filter((i) => ['auto', 'manual', 'split'].includes(i.match_kind));
  let net = rec?.opening_balance ?? 0;
  for (const m of matched) {
    const b = JSON.parse(m.bank_row) as BankRow;
    net = roundMoney(net + (b.income - b.expense)); // 每行取整到分，消除浮点尾差累积
  }
  return {
    bankUnmatched,
    localUnmatched,
    localUnmatchedTotal,
    localUnmatchedNet,
    amountMismatch,
    calcBalance: rec ? net : null,
  };
}

/** 标记本地交易归属批次（unmatched_local 可手动配对；结束后把剩余未配对记 mismatch） */
export async function completeReconciliation(recId: number, bankEndBalance: number): Promise<void> {
  return runInTransaction(async () => {
    const [rec] = await select<Reconciliation>(`SELECT * FROM reconciliations WHERE id = $1 AND ledger_id = $2`, [recId, currentLedgerId()]);
    if (!rec) throw new Error('对账批次不存在');
    if (rec.status === 'locked') throw new Error('该批次已锁定，请先解锁再修改');

    // 已自动/手动配对的本地交易 → 标记归属
    const matchedItems = await select<ReconItem>(
      `SELECT * FROM reconciliation_items WHERE reconciliation_id = $1 AND transaction_id IS NOT NULL`,
      [recId]
    );
    for (const m of matchedItems) {
      await execute(`UPDATE transactions SET reconciliation_id = $1 WHERE id = $2`, [recId, m.transaction_id]);
    }

    // 有未配对流水则禁止锁定（差异需处理）；已忽略的流水视为已闭环，不再阻断
    const pending = await select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM reconciliation_items
       WHERE reconciliation_id = $1 AND transaction_id IS NULL AND match_kind NOT IN ('amount_mismatch','ignored')`,
      [recId]
    );
    const pendingN = Number(pending[0]?.n ?? 0);
    if (pendingN > 0) throw new Error(`还有 ${pendingN} 条银行流水未配对，请先处理差异再完成对账。`);

    // 推算期末余额并与银行对账输入对比
    const matched = await select<ReconItem>(
      `SELECT * FROM reconciliation_items WHERE reconciliation_id = $1 AND match_kind IN ('auto','manual','split')`,
      [recId]
    );
    let calc = rec.opening_balance ?? 0;
    for (const m of matched) {
      const b = JSON.parse(m.bank_row) as BankRow;
      calc = roundMoney(calc + (b.income - b.expense)); // 每行取整到分，消除浮点尾差累积
    }
    // 差异同样归一到分：避免 0.30000000000000004 这类尾差导致误报「有差异」
    const diff = Math.abs(roundMoney(calc - bankEndBalance));

    // 差异超阈值：取消锁定（事务回滚全部标记），明确提示先处理差异。
    // 原实现先 UPDATE 锁定再抛错——因事务回滚导致实际未锁定，却提示「锁定成功」，与事实相悖。
    if (diff > 0.001) {
      throw new Error(`推算期末余额 ${calc.toFixed(2)} 与银行余额 ${bankEndBalance.toFixed(2)} 差异 ${diff.toFixed(2)} 元，已取消锁定。请先核对差异后再完成对账。`);
    }
    await execute(
      `UPDATE reconciliations SET bank_balance = $1, calc_balance = $2, diff_total = $3, status = 'locked' WHERE id = $4`,
      [bankEndBalance, calc, diff, recId]
    );
  });
}

/** 解锁批次（可继续调整） */
export async function unlockReconciliation(recId: number): Promise<void> {
  await runInTransaction(async () => {
    // 释放已标记的交易归属
    await execute(`UPDATE transactions SET reconciliation_id = NULL WHERE reconciliation_id = $1`, [recId]);
    await execute(`UPDATE reconciliations SET status = 'draft' WHERE id = $1 AND ledger_id = $2`, [recId, currentLedgerId()]);
  });
}

/** 获取某批次已标记的交易 id 列表（用于展示"已对账"标记） */
export async function listReconciledTransactionIds(recId: number): Promise<number[]> {
  const rows = await select<{ id: number }>(`SELECT id FROM transactions WHERE reconciliation_id = $1`, [recId]);
  return rows.map((r) => r.id);
}

/** 差异导出的单行（Excel / CSV 通用），类型固定便于序列化 */
export interface ReconDiffRow {
  /** 差异类别：bank_unmatched / local_unmatched / amount_mismatch */
  kind: string;
  date: string;
  summary: string;
  income: number;
  expense: number;
}

/** 将差异数据组装成可导出的扁平行数组（纯函数，便于单元测试）。
 *  bankUnmatched / amountMismatch 来自银行流水行（bank_row JSON），localUnmatched 来自本地交易。 */
export function buildReconDiffRows(args: {
  bankUnmatched: ReconItem[];
  amountMismatch: ReconItem[];
  localUnmatched: LocalUnmatchedTx[];
}): ReconDiffRow[] {
  const rows: ReconDiffRow[] = [];

  // 银行有·本地无
  for (const i of args.bankUnmatched) {
    let b: BankRow | null = null;
    try { b = JSON.parse(i.bank_row) as BankRow; } catch { /* 忽略坏行 */ }
    if (!b) continue;
    rows.push({
      kind: 'bank_unmatched',
      date: b.date,
      summary: b.summary,
      income: b.income,
      expense: b.expense,
    });
  }

  // 金额不符
  for (const i of args.amountMismatch) {
    let b: BankRow | null = null;
    try { b = JSON.parse(i.bank_row) as BankRow; } catch { /* 忽略坏行 */ }
    rows.push({
      kind: 'amount_mismatch',
      date: b?.date ?? '',
      summary: b?.summary ?? '',
      income: b?.income ?? 0,
      expense: b?.expense ?? 0,
    });
  }

  // 本地有·银行无
  for (const t of args.localUnmatched) {
    const amount = t.tx_amount ?? 0;
    rows.push({
      kind: 'local_unmatched',
      date: t.tx_date ?? '',
      summary: t.tx_note ?? '',
      income: amount > 0 ? amount : 0,
      expense: amount < 0 ? Math.abs(amount) : 0,
    });
  }

  return rows;
}

/** 差异导出：读取全量三类差异并返回扁平行数据（供 Excel / CSV 下载）。 */
export async function reconcileExportRows(recId: number): Promise<ReconDiffRow[]> {
  const items = await listMatches(recId);
  const [rec] = await select<Reconciliation>(`SELECT * FROM reconciliations WHERE id = $1`, [recId]);
  const bankUnmatched = items.filter((i) => i.match_kind === 'unmatched_bank');
  const amountMismatch = items.filter((i) => i.match_kind === 'amount_mismatch');
  let localUnmatched: LocalUnmatchedTx[] = [];
  if (rec) {
    // 导出应取全量，不受页面分页影响；用较大上限加载
    const { sql, params } = buildLocalUnmatchedQuery(rec, { limit: 100000 });
    localUnmatched = await select<LocalUnmatchedTx>(sql, params);
  }
  return buildReconDiffRows({ bankUnmatched, amountMismatch, localUnmatched });
}