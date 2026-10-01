// 银行对账模块
// -----------------------------------------------------------------------------
// 流程：建批次（选账户+期间+期初/银行余额）→ 导入银行流水（xlsx 解析）→
// 自动/手动匹配本地交易 → 查看差异 → 完成锁定（标记 transactions.reconciliation_id）。
// 对账只做「核对/标记」，不改变任何账户余额（与 import.ts 的余额中性一致）。
// -----------------------------------------------------------------------------
import dayjs from 'dayjs';
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { listTransactionsDetailed } from './transactions';

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

/** 自动匹配：金额相同 + 日期 ±3 天内 + 备注去除空白后模糊相似（或金额相同且唯一候选） */
export async function matchAuto(recId: number): Promise<{ matched: number; skipped: number }> {
  const [rec] = await select<Reconciliation>(`SELECT * FROM reconciliations WHERE id = $1 AND ledger_id = $2`, [recId, currentLedgerId()]);
  if (!rec) throw new Error('对账批次不存在');

  // 候选本地交易：该账户在期间内、未被其他批次锁定
  const localTxs = await listTransactionsDetailed({
    accountId: rec.account_id,
    from: rec.period_start ?? undefined,
    to: rec.period_end ?? undefined,
    limit: 100000,
  });
  const pool = localTxs.filter((t) => t.reconciliation_id == null || t.reconciliation_id === recId);
  const bankItems = await select<ReconItem>(
    `SELECT * FROM reconciliation_items WHERE reconciliation_id = $1 AND match_kind = 'unmatched_bank' ORDER BY id`,
    [recId]
  );

  let matched = 0;
  let skipped = 0;
  await runInTransaction(async () => {
    for (const bi of bankItems) {
      const bank = JSON.parse(bi.bank_row) as BankRow;
      const bankAmt = Math.abs(bank.income - bank.expense);
      const dir = bank.income > 0 ? 'in' : bank.expense > 0 ? 'out' : 'none';
      // 按金额+日期候选
      const candidates = pool.filter((tx) => {
        if (Math.abs(tx.amount - bankAmt) > 0.001) return false;
        if (dir === 'none') return false;
        const txDir = ['income', 'borrow', 'repay_in'].includes(tx.type) ? 'in'
          : ['expense', 'lend', 'repay_out'].includes(tx.type) ? 'out' : 'transfer';
        if (txDir !== dir) return false;
        const diff = Math.abs(dayjs(tx.date).diff(dayjs(bank.date), 'day'));
        return diff <= 3;
      });
      // 备注模糊加权：去空白/符号后包含关系
      const norm = (s: string) => s.replace(/[\s\-_（）()/\\]/g, '').toLowerCase();
      const bk = norm(bank.summary);
      const scored = candidates
        .map((tx) => ({ tx, score: bk && (norm(tx.note).includes(bk) || bk.includes(norm(tx.note))) ? 10 : 0 }))
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
          [best.tx.id, bi.id]
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
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
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
  if (rec) {
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.max(1, opts?.pageSize ?? 100);
    const offset = (page - 1) * pageSize;
    const { sql, params } = buildLocalUnmatchedQuery(rec, { limit: pageSize, offset });
    localUnmatched = await select<LocalUnmatchedTx>(sql, params);
    const { sql: cntSql, params: cntParams } = buildLocalUnmatchedCount(rec);
    const cnt = await select<{ n: number }>(cntSql, cntParams);
    localUnmatchedTotal = Number(cnt[0]?.n ?? 0);
  }

  // 推算余额 = 期初 + Σ(匹配银行行净额)（以银行流水的 balance 或净额为准）
  const matched = items.filter((i) => ['auto', 'manual', 'split'].includes(i.match_kind));
  let net = rec?.opening_balance ?? 0;
  for (const m of matched) {
    const b = JSON.parse(m.bank_row) as BankRow;
    net += (b.income - b.expense);
  }
  return {
    bankUnmatched,
    localUnmatched,
    localUnmatchedTotal,
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

    // 有未配对流水则禁止锁定（差异需处理）
    const pending = await select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM reconciliation_items
       WHERE reconciliation_id = $1 AND transaction_id IS NULL AND match_kind != 'amount_mismatch'`,
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
      calc += (b.income - b.expense);
    }
    const diff = Math.abs(calc - bankEndBalance);

    await execute(
      `UPDATE reconciliations SET bank_balance = $1, calc_balance = $2, diff_total = $3, status = 'locked' WHERE id = $4`,
      [bankEndBalance, calc, diff, recId]
    );
    if (diff > 0.001) {
      throw new Error(`锁定成功，但注意：推算期末余额 ${calc.toFixed(2)} 与银行余额 ${bankEndBalance.toFixed(2)} 差异 ${diff.toFixed(2)}，请复核。`);
    }
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