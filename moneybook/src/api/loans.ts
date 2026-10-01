import { createTransaction, reverseBalance, syncVirtualAccounts } from './transactions';
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import type { Transaction } from './transactions';
import { recordToTrash } from './trash';

export type LoanMethod = 'balloon' | 'equal_principal' | 'equal_payment';

export interface Loan {
  id: number;
  direction: 'lend' | 'borrow';
  counterparty: string;
  principal: number;
  remaining: number;
  account_id: number | null;
  date: string;
  due_date: string | null;
  rate: number;
  periods: number | null;
  compound: number;                // 0 单利  1 复利
  method: LoanMethod;              // 还款方式
  first_repay_date: string | null; // 开始还款日期（首期还款日）
  repay_day: number | null;        // 固定还款日（每月几号）
  note: string;
  status: 'active' | 'settled' | 'overdue';
  /** 已自动累计但尚未入账（未收/未付）的逾期利息 */
  accrued_interest: number;
  /** 逾期利息累计截止日期（YYYY-MM-DD，用于增量累计） */
  interest_accrued_until: string | null;
}

export const METHOD_LABELS: Record<LoanMethod, string> = {
  balloon: '到期一次还本付息',
  equal_principal: '等额本金',
  equal_payment: '等额本息',
};

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}
export function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function addMonths(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}
function setDayOfMonth(dateStr: string, day: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}
const round2 = (x: number): number => Number(x.toFixed(2));

/** 计息结束日：到期日 → 开始还款日 → 期数×整月 → 今日 */
function interestEnd(loan: Pick<Loan, 'due_date' | 'first_repay_date' | 'periods' | 'date'>, asOf?: string): string {
  if (loan.due_date) return loan.due_date;
  if (loan.first_repay_date) return loan.first_repay_date;
  if (loan.periods && loan.periods > 0) return addMonths(loan.date, loan.periods);
  return asOf ?? todayStr();
}

/** 到期一次还本付息的本金利息（支持单利/复利） */
function balloonInterest(loan: Pick<Loan, 'principal' | 'rate' | 'periods' | 'date' | 'due_date' | 'first_repay_date' | 'compound'>, asOf?: string): number {
  const rate = Number(loan.rate) || 0;
  if (rate <= 0) return 0;
  if (Number(loan.compound) === 1 && loan.periods && loan.periods > 0) {
    const r = rate / 100 / 12; // 按月复利
    const n = loan.periods;
    return round2(loan.principal * (Math.pow(1 + r, n) - 1));
  }
  const end = interestEnd(loan, asOf);
  const days = Math.max(0, daysBetween(loan.date, end));
  return round2(loan.principal * (rate / 100) * (days / 365));
}

export interface LoanScheduleRow {
  period: number;
  dueDate: string;
  principal: number; // 应还本金
  interest: number;  // 应还利息
  payment: number;   // 应还总额
  remaining: number; // 还款后剩余本金
}
export interface LoanSchedule {
  rows: LoanScheduleRow[];
  totalPrincipal: number;
  totalInterest: number;
  totalPayment: number;
  method: LoanMethod;
}

/** 生成还款计划（按还款方式展开）。balloon 只返回一行；等额本金/等额本息按期次展开。 */
export function calcSchedule(loan: Pick<Loan, 'principal' | 'rate' | 'periods' | 'date' | 'first_repay_date' | 'repay_day' | 'compound' | 'method' | 'due_date'>): LoanSchedule {
  const method: LoanMethod = loan.method ?? 'balloon';
  const n = loan.periods && loan.periods > 0 ? loan.periods : 0;
  const rate = Number(loan.rate) || 0;
  const r = rate / 100 / 12; // 月利率
  const rows: LoanScheduleRow[] = [];

  if (method === 'balloon' || n <= 0) {
    const interest = balloonInterest(loan as Loan);
    const payment = round2(loan.principal + interest);
    rows.push({
      period: 0, dueDate: loan.due_date ?? interestEnd(loan, todayStr()),
      principal: loan.principal, interest, payment, remaining: 0,
    });
    return { rows, totalPrincipal: loan.principal, totalInterest: interest, totalPayment: payment, method };
  }

  const first = loan.first_repay_date && loan.first_repay_date >= loan.date ? loan.first_repay_date : addMonths(loan.date, 1);
  const dueDate = (i: number): string => {
    const d = i === 1 ? first : addMonths(first, i - 1);
    return loan.repay_day && loan.repay_day > 0 ? setDayOfMonth(d, loan.repay_day) : d;
  };

  let totalInterest = 0;
  let remaining = loan.principal;

  if (method === 'equal_principal') {
    const base = loan.principal / n;
    for (let i = 1; i <= n; i++) {
      const interest = remaining * r;
      const principal = Math.min(base, remaining);
      remaining = Math.max(0, remaining - principal);
      totalInterest += interest;
      rows.push({ period: i, dueDate: dueDate(i), principal: round2(principal), interest: round2(interest), payment: round2(principal + interest), remaining: round2(remaining) });
    }
  } else {
    // 等额本息
    const payment = r > 0
      ? (loan.principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
      : loan.principal / n;
    for (let i = 1; i <= n; i++) {
      const interest = remaining * r;
      const isLast = i === n;
      const principal = isLast ? remaining : Math.min(remaining, Math.max(0, payment - interest));
      remaining = Math.max(0, remaining - principal);
      totalInterest += interest;
      rows.push({ period: i, dueDate: dueDate(i), principal: round2(principal), interest: round2(interest), payment: round2(principal + interest), remaining: round2(remaining) });
    }
  }
  return {
    rows, totalPrincipal: loan.principal,
    totalInterest: round2(totalInterest), totalPayment: round2(loan.principal + totalInterest), method,
  };
}

/** 计算某笔借贷的预计利息（按还款方式口径：到期一次看单笔本息，分期按计划累计） */
export function calcLoanInterest(loan: Pick<Loan, 'principal' | 'rate' | 'periods' | 'date' | 'due_date' | 'first_repay_date' | 'compound' | 'method'>, asOf?: string): number {
  const rate = Number(loan.rate) || 0;
  if (rate <= 0) return 0;
  const method = loan.method ?? 'balloon';
  const n = loan.periods && loan.periods > 0 ? loan.periods : 0;
  if (method !== 'balloon' && n > 0) return calcSchedule(loan as Loan).totalInterest;
  return balloonInterest(loan, asOf);
}

export interface NextDue {
  period: number;         // 还款计划的期次（0 = 到期一次/结清口径）
  dueDate: string | null;
  principal: number;
  interest: number;
  payment: number;
}

/**
 * 计算贷款"下一期应还"：依据已还本金反推当前期次。
 * - 等额本金/等额本息：返回首个"本金未还清"的期次的应还本金/利息/总额。
 * - 到期一次（balloon）或无数期：返回剩余本金及到期日；利息部分交由还款表单按实际计算。
 * 余额已清零返回 null。
 */
export function getLoanNextDue(loan: Pick<Loan, 'principal' | 'remaining' | 'rate' | 'periods' | 'date' | 'due_date' | 'first_repay_date' | 'repay_day' | 'compound' | 'method' | 'accrued_interest'>): NextDue | null {
  if (loan.remaining <= 0.0001) return null;
  const method = loan.method ?? 'balloon';
  const n = loan.periods && loan.periods > 0 ? loan.periods : 0;
  // 已累计的逾期利息，需要随下一期一并支付（计入"其中利息"建议值）
  const accrued = Number(loan.accrued_interest) || 0;

  if (method === 'balloon' || n <= 0) {
    return {
      period: 0,
      dueDate: loan.due_date ?? interestEnd(loan, todayStr()),
      principal: round2(loan.remaining),
      interest: round2(accrued),
      payment: round2(loan.remaining + accrued),
    };
  }

  const repaid = round2(loan.principal - loan.remaining);
  const sched = calcSchedule(loan);
  let cum = 0;
  for (let i = 0; i < sched.rows.length; i++) {
    cum += sched.rows[i].principal;
    // 该期本金尚未还清（含部分还款），即为下一期应还
    if (cum > repaid + 0.005) {
      const row = sched.rows[i];
      const interest = round2(row.interest + accrued);
      return { period: row.period, dueDate: row.dueDate, principal: row.principal, interest, payment: round2(row.principal + interest) };
    }
  }
  return null; // 所有期次本金均已还清
}

/** 还款计划行的进度状态 */
export interface ScheduleProgressRow {
  row: LoanScheduleRow;
  status: 'paid' | 'current' | 'upcoming' | 'overdue';
}

/**
 * 依据已还本金，标注还款计划每一期的进度状态：
 * - paid: 该期本金已全部归还
 * - current: 该期应为"下一期"（含部分还款）
 * - overdue: 到期日已过仍未还
 * - upcoming: 未来的期次
 */
export async function listLoans(): Promise<Loan[]> {
  return select<Loan>(
    `SELECT * FROM loans WHERE ledger_id = $1 ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'overdue' THEN 1 ELSE 2 END, date DESC`,
    [currentLedgerId()]
  );
}

export function calcScheduleProgress(
  loan: Pick<Loan, 'principal' | 'remaining' | 'rate' | 'periods' | 'date' | 'due_date' | 'first_repay_date' | 'repay_day' | 'compound' | 'method'>,
  today = todayStr()
): ScheduleProgressRow[] {
  const sched = calcSchedule(loan);
  const repaidTotal = round2(loan.principal - loan.remaining);
  let cum = 0;
  let currentIndex = -1;
  return sched.rows.map((row, idx) => {
    cum += row.principal;
    let status: ScheduleProgressRow['status'] = 'upcoming';
    if (round2(cum) <= repaidTotal + 0.005) {
      status = 'paid';
    } else if (currentIndex === -1) {
      currentIndex = idx;
      status = 'current';
    } else if (row.dueDate < today) {
      status = 'overdue';
    }
    return { row, status };
  });
}

/**
 * 某笔借贷已记账的利息之和（本金之外、已计入收入/支出的那部分）。
 * 用列表或明细统计"实收/实付利息"。
 */
export async function getLoanBookedInterest(loanId: number): Promise<number> {
  const rows = await select<{ total: number | null }>(
    `SELECT COALESCE(SUM(interest), 0) AS total FROM loan_repayments WHERE loan_id = $1`, [loanId]
  );
  return rows[0]?.total ?? 0;
}

/** 尚未记账的预计剩余利息（用于还款表单的"其中利息"默认建议值）。
 *  含已自动累计的逾期利息（随还款一并收回/支出）。 */
export async function getLoanRemainingInterest(loan: Loan): Promise<number> {
  const expected = calcLoanInterest(loan);
  const booked = await getLoanBookedInterest(loan.id);
  const accrued = Number(loan.accrued_interest) || 0;
  return Math.max(0, round2(expected - booked + accrued));
}

export async function createLoan(p: {
  direction: 'lend' | 'borrow';
  counterparty: string;
  principal: number;
  accountId: number;
  date: string;
  dueDate?: string;
  rate?: number;
  periods?: number;
  compound?: boolean;
  method?: LoanMethod;
  firstRepayDate?: string | null;
  repayDay?: number | null;
  note?: string;
}): Promise<number> {
  return runInTransaction(async () => {
    const r = await execute(
      `INSERT INTO loans (direction, counterparty, principal, remaining, account_id, date, due_date, rate, periods, compound, method, first_repay_date, repay_day, note, ledger_id)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [p.direction, p.counterparty, p.principal, p.accountId, p.date, p.dueDate ?? null, p.rate ?? 0, p.periods ?? null, p.compound ? 1 : 0, p.method ?? 'balloon', p.firstRepayDate ?? null, p.repayDay ?? null, p.note ?? '', currentLedgerId()]
    );
    const loanId = r.lastInsertId as number;
    await createTransaction({
      type: p.direction === 'lend' ? 'lend' : 'borrow',
      amount: p.principal,
      accountId: p.accountId,
      loanId,
      date: p.date,
      note: p.note ? p.note : `${p.direction === 'lend' ? '借出给' : '借自'} ${p.counterparty}`,
    });
    return loanId;
  });
}

// 利息收入/支出对应的默认分类（按类型名查找；未找到则留空分类，只计入收支合计）
async function interestCategoryId(direction: 'lend' | 'borrow'): Promise<number | undefined> {
  const name = direction === 'lend' ? '投资收益' : '其他支出';
  const rows = await select<{ id: number }>(
    `SELECT id FROM categories WHERE type = $1 AND name = $2 AND ledger_id = $3 LIMIT 1`,
    [direction === 'lend' ? 'income' : 'expense', name, currentLedgerId()]
  );
  const id = rows[0]?.id;
  if (id != null) return id;
  // 兜底：取该类别的第一个分类（避免利息完全无法归类）
  const fallback = await select<{ id: number }>(
    `SELECT id FROM categories WHERE type = $1 AND ledger_id = $2 LIMIT 1`,
    [direction === 'lend' ? 'income' : 'expense', currentLedgerId()]
  );
  return fallback[0]?.id;
}

export async function repayLoan(loanId: number, p: {
  amount: number; interest?: number; period?: number | null; accountId: number; date: string; note?: string;
}): Promise<void> {
  return runInTransaction(async () => {
    const [loan] = await select<Loan>(`SELECT * FROM loans WHERE id = $1`, [loanId]);
    if (!loan) throw new Error('借贷记录不存在');
    if (p.amount <= 0) throw new Error('还款金额必须大于 0');
    const interest = Math.max(0, p.interest ?? 0);
    if (interest > p.amount + 0.0001) throw new Error('利息不能大于还款总金额');
    const principal = round2(p.amount - interest);
    if (principal > loan.remaining + 0.0001) throw new Error('还款本金超过剩余未还本金');

    const newRemaining = Math.max(0, round2(loan.remaining - principal));
    await execute(
      `INSERT INTO loan_repayments (loan_id, amount, interest, period, account_id, date, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [loanId, p.amount, interest, p.period ?? null, p.accountId, p.date, p.note ?? '']
    );
    await execute(
      `UPDATE loans SET remaining = $1, status = $2 WHERE id = $3`,
      [newRemaining, newRemaining <= 0.0001 ? 'settled' : 'active', loanId]
    );
    // 本金部分：冲销债权（借出收回）或债务（借入偿还），属资产负债表变动，不进收入/支出
    await createTransaction({
      type: loan.direction === 'lend' ? 'repay_in' : 'repay_out',
      amount: principal,
      accountId: p.accountId,
      loanId,
      date: p.date,
      note: p.note ? `${p.note}（本金）` : `本金还款`,
    });
    // 利息部分：放贷收息 = 收入，借款付息 = 支出（真实资金流动计入收支）
    if (interest > 0.0001) {
      const categoryId = await interestCategoryId(loan.direction);
      await createTransaction({
        type: loan.direction === 'lend' ? 'income' : 'expense',
        amount: interest,
        accountId: p.accountId,
        categoryId,
        loanId,
        date: p.date,
        note: p.note ? `${p.note}（利息）` : `${loan.direction === 'lend' ? '利息收入' : '利息支出'}`,
      });
      // 实付利息优先抵偿已自动累计的逾期利息（FIFO），剩余部分视为正常利息。
      // 已抵偿的部分从 accrued_interest 中扣减，避免在结清时被重复入账。
      const accruedBefore = Number(loan.accrued_interest) || 0;
      if (accruedBefore > 0.0001) {
        const remainingAccrued = round2(Math.max(0, accruedBefore - interest));
        await execute(`UPDATE loans SET accrued_interest = $1 WHERE id = $2`, [remainingAccrued, loanId]);
      }
    }
    await syncVirtualAccounts();
  });
}

/**
 * 撤销结清…（略）
 */

/** 单独偿还已累计的逾期利息（不与本金混合）。
 *  与 repayLoan 的利息部分不同，这里只冲减 accrued_interest 并计收/计支，不改动 remaining。
 *  用于"逾期利息作为独立条目、与本金分开回收"的场景。 */
export async function repayOverdueInterest(loanId: number, p: {
  amount: number; accountId: number; date: string;
}): Promise<void> {
  return runInTransaction(async () => {
    const [loan] = await select<Loan>(`SELECT * FROM loans WHERE id = $1`, [loanId]);
    if (!loan) throw new Error('借贷记录不存在');
    const accrued = Number(loan.accrued_interest) || 0;
    if (accrued <= 0.0001) throw new Error('该借贷暂无已累计的逾期利息');
    if (p.amount <= 0) throw new Error('金额必须大于 0');
    if (p.amount > accrued + 0.0001) throw new Error('还款金额超过已累计逾期利息');
    const categoryId = await interestCategoryId(loan.direction);
    await createTransaction({
      type: loan.direction === 'lend' ? 'income' : 'expense',
      amount: p.amount,
      accountId: p.accountId,
      categoryId,
      loanId,
      date: p.date,
      note: loan.direction === 'lend' ? '逾期利息收入' : '逾期利息支出',
    });
    // 只扣减已累计的逾期利息；不动 remaining，也不回拨计息锚点（锚点只在累计时前进）
    await execute(`UPDATE loans SET accrued_interest = $1 WHERE id = $2`, [
      round2(Math.max(0, accrued - p.amount)), loanId,
    ]);
    await syncVirtualAccounts();
  });
}

/**
 * 撤销结清：将已结清(settled)的借贷回置为进行中(active)。
 * 取舍说明：settleLoan 中若剩余本金>0 会新增一笔结清还款记录并清零 remaining；
 * 撤销结清不会回滚那些还款记录（真实资金已实际发生，不应抹去账目），仅回置状态，
 * remaining 保持不变，避免与既有还款记录产生余额不一致。
 * 简单起见直接置为 'active'（不因关联还款计划判定重新置为 'overdue'）。
 */
export async function unSettleLoan(loanId: number, p?: { reason?: string }): Promise<void> {
  return runInTransaction(async () => {
    void p;
    const [loan] = await select<Loan>(`SELECT * FROM loans WHERE id = $1`, [loanId]);
    if (!loan) throw new Error('借贷记录不存在');
    if (loan.status !== 'settled') throw new Error('仅已结清的借贷可恢复进行中');
    await execute(`UPDATE loans SET status = 'active' WHERE id = $1`, [loanId]);
  });
}

/** 逾期利息估算（单利）：remaining × 年利率(百分数) ÷ 100 × 逾期天数 ÷ 365。纯函数，仅供展示，不写库。 */
export function calcOverdueInterestAmount(
  loan: Pick<Loan, 'remaining' | 'rate' | 'due_date'>,
  asOf = todayStr()
): number {
  const rate = Number(loan.rate) || 0;
  if (rate <= 0) return 0;
  if (!loan.due_date || loan.due_date >= asOf) return 0;
  const days = Math.max(0, daysBetween(loan.due_date, asOf));
  return round2(loan.remaining * (rate / 100) * (days / 365));
}

export async function listRepayments(loanId: number): Promise<{ id: number; amount: number; interest: number; period: number | null; date: string; note: string }[]> {
  return select<{ id: number; amount: number; interest: number; period: number | null; date: string; note: string }>(
    `SELECT id, amount, interest, period, date, note FROM loan_repayments WHERE loan_id = $1 ORDER BY date DESC, id DESC`, [loanId]
  );
}

/** 结清借贷：若还有剩余本金，则将剩余额作为一笔结清还款计入（并生成对应交易），随后标记为已结清 */
export async function settleLoan(loanId: number): Promise<void> {
  return runInTransaction(async () => {
    const [loan] = await select<Loan>(`SELECT * FROM loans WHERE id = $1`, [loanId]);
    if (!loan) throw new Error('借贷记录不存在');
    if (loan.status === 'settled') return;

    const today = new Date().toISOString().slice(0, 10);
    // 剩余本金 > 0：补齐一笔结清还款，避免"标记结清但余额仍残留"的不一致
    if (loan.remaining > 0.0001) {
      if (!loan.account_id) throw new Error('该借贷未关联资金账户，无法自动结清剩余金额');
      await execute(
        `INSERT INTO loan_repayments (loan_id, amount, account_id, date, note) VALUES ($1,$2,$3,$4,$5)`,
        [loanId, loan.remaining, loan.account_id, today, '结清剩余']
      );
      await createTransaction({
        type: loan.direction === 'lend' ? 'repay_in' : 'repay_out',
        amount: loan.remaining,
        accountId: loan.account_id,
        loanId,
        date: today,
        note: '结清剩余',
      });
    }
    await execute(`UPDATE loans SET remaining = 0, status = 'settled' WHERE id = $1`, [loanId]);
    // 结清时，把仍累计但尚未入账的逾期利息实现为收支（放贷计收入、借款计支出），并清零
    const accruedBefore = Number(loan.accrued_interest) || 0;
    if (accruedBefore > 0.0001 && loan.account_id) {
      const categoryId = await interestCategoryId(loan.direction);
      await createTransaction({
        type: loan.direction === 'lend' ? 'income' : 'expense',
        amount: accruedBefore,
        accountId: loan.account_id,
        categoryId,
        loanId,
        date: today,
        note: loan.direction === 'lend' ? '逾期利息收入（结清）' : '逾期利息支出（结清）',
      });
    }
    await execute(`UPDATE loans SET accrued_interest = 0 WHERE id = $1`, [loanId]);
    await syncVirtualAccounts();
  });
}

/** 编辑借贷元数据（对方/日期/到期/利率/期数/备注），不修改金额与方向，避免破坏关联交易 */
export async function updateLoan(id: number, p: {
  counterparty?: string; date?: string; dueDate?: string | null; rate?: number; periods?: number | null;
  compound?: boolean; method?: LoanMethod; firstRepayDate?: string | null; repayDay?: number | null; note?: string;
}): Promise<void> {
  return runInTransaction(async () => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { sets.push(`${col} = $${params.length + 1}`); params.push(val); };
    if (p.counterparty !== undefined) push('counterparty', p.counterparty);
    if (p.date !== undefined) push('date', p.date);
    if (p.dueDate !== undefined) push('due_date', p.dueDate);
    if (p.rate !== undefined) push('rate', p.rate);
    if (p.periods !== undefined) push('periods', p.periods);
    if (p.compound !== undefined) push('compound', p.compound ? 1 : 0);
    if (p.method !== undefined) push('method', p.method);
    if (p.firstRepayDate !== undefined) push('first_repay_date', p.firstRepayDate);
    if (p.repayDay !== undefined) push('repay_day', p.repayDay);
    if (p.note !== undefined) push('note', p.note);
    if (sets.length) { params.push(id); await execute(`UPDATE loans SET ${sets.join(', ')} WHERE id = $${params.length}`, params); }

    // 同步主交易（借出/借入那笔）的日期与备注，保证统计数据与交易记录一致
    if (p.date !== undefined || p.note !== undefined) {
      const txSets: string[] = [];
      const txParams: unknown[] = [];
      if (p.date !== undefined) { txSets.push(`date = $${txParams.length + 1}`); txParams.push(p.date); }
      if (p.note !== undefined) { txSets.push(`note = $${txParams.length + 1}`); txParams.push(p.note); }
      txParams.push(id);
      await execute(
        `UPDATE transactions SET ${txSets.join(', ')} WHERE loan_id = $${txParams.length} AND type IN ('lend','borrow')`,
        txParams
      );
    }
  });
}

/** 删除借贷记录及关联还款与交易，并回滚账户余额、重算虚拟账户。
 *  删除前把贷款、关联交易与还款记录快照写入回收站，支持恢复。 */
export async function deleteLoan(loanId: number): Promise<void> {
  return runInTransaction(async () => {
    const [loanRow] = await select<Record<string, unknown>>(`SELECT * FROM loans WHERE id = $1`, [loanId]);
    if (loanRow) {
      const txsSnap = await select<Record<string, unknown>>(`SELECT * FROM transactions WHERE loan_id = $1 ORDER BY id`, [loanId]);
      const repsSnap = await select<Record<string, unknown>>(`SELECT * FROM loan_repayments WHERE loan_id = $1 ORDER BY id`, [loanId]);
      await recordToTrash('loan', loanId, loanRow, { txs: txsSnap, repayments: repsSnap });
    }
    // 先反转并删除该贷款的全部关联交易（借出/借入 + 还款）
    const txs = await select<Transaction>(`SELECT * FROM transactions WHERE loan_id = $1`, [loanId]);
    for (const tx of txs) {
      await reverseBalance(tx);
      await execute(`DELETE FROM transactions WHERE id = $1`, [tx.id]);
    }
    await execute(`DELETE FROM loan_repayments WHERE loan_id = $1`, [loanId]);
    await execute(`DELETE FROM loans WHERE id = $1`, [loanId]);
    await syncVirtualAccounts();
  });
}

/** 检查并更新逾期状态的借贷记录 */
export async function listOverdueLoans(): Promise<Loan[]> {
  await checkOverdueLoans();
  return select<Loan>(
    `SELECT * FROM loans WHERE status = 'overdue' AND remaining > 0.0001 AND ledger_id = $1 ORDER BY due_date`,
    [currentLedgerId()]
  );
}

/** 计算一笔借贷的"逾期起算日"：该笔应还的最近一次到期日（借款或分期均适用）。
 *  - 到期一次（balloon）含 due_date：取 due_date；
 *  - 分期还款：取当前未还期次的到期日（getLoanNextDue）；
 *  - 无明确到期日：返回 null（视为永不逾期）。
 * 返回 null 表示无到期约束；否则返回 'YYYY-MM-DD'。 */
function getLoanOverdueStart(loan: Pick<Loan, 'principal' | 'remaining' | 'rate' | 'periods' | 'date' | 'due_date' | 'first_repay_date' | 'repay_day' | 'compound' | 'method' | 'accrued_interest'>): string | null {
  if (loan.remaining <= 0.0001) return null;
  const method = loan.method ?? 'balloon';
  const n = loan.periods && loan.periods > 0 ? loan.periods : 0;
  if (method === 'balloon' || n <= 0) return loan.due_date ?? null;
  return getLoanNextDue(loan)?.dueDate ?? loan.first_repay_date ?? null;
}

/**
 * 自动累计逾期利息（单利）：对每笔未结清、有利率且有到期约束、且已逾期的借贷，
 * 将其逾期利息（remaining × 年利率 ÷ 100 ÷ 365 × 逾期天数）累积写入 loans.accrued_interest。
 * 采用兴趣锚点增量累计（interest_accrued_until），同日内重复调用不会重复计息（幂等）。
 * 返回本次新增累计的利息总额与涉及笔数。
 */
export async function accrueOverdueInterest(): Promise<{ loans: number; interest: number }> {
  const loans = await select<Loan>(
    `SELECT * FROM loans WHERE status != 'settled' AND remaining > 0.0001 AND rate > 0 AND ledger_id = $1`,
    [currentLedgerId()]
  );
  const today = todayStr();
  let interestTotal = 0;
  let n = 0;
  for (const loan of loans) {
    const due = getLoanOverdueStart(loan);
    if (!due) continue;
    const overdueSince = due;
    if (overdueSince >= today) continue; // 尚未逾期
    // 首次从逾期起算日累计，此后仅累计自上次截止日到今天的增量
    const anchor = loan.interest_accrued_until && loan.interest_accrued_until >= overdueSince
      ? loan.interest_accrued_until : overdueSince;
    const days = Math.max(0, daysBetween(anchor, today));
    if (days <= 0) continue;
    const daily = (loan.remaining * Number(loan.rate)) / 100 / 365;
    const add = round2(daily * days);
    if (add <= 0) continue;
    await execute(
      `UPDATE loans SET accrued_interest = accrued_interest + $1, interest_accrued_until = $2 WHERE id = $3`,
      [add, today, loan.id]
    );
    interestTotal += add;
    n++;
  }
  return { loans: n, interest: round2(interestTotal) };
}

/**
 * 检查并更新逾期状态（重算所有未结清借贷的 status）。
 * - 兼容到期一次与分期还款：逾期 = 最近应还到期日早于今天且尚有剩余本金；
 * - 顺带同步累计逾期利息到 loans.accrued_interest。
 */
export async function checkOverdueLoans(): Promise<{ overdue: number; accruedInterest: number }> {
  const loans = await select<Loan>(
    `SELECT * FROM loans WHERE status != 'settled' AND remaining > 0.0001 AND ledger_id = $1`,
    [currentLedgerId()]
  );
  const today = todayStr();
  let overdue = 0;
  for (const loan of loans) {
    const due = getLoanOverdueStart(loan);
    const isOverdue = !!due && due < today;
    const target = isOverdue ? 'overdue' : 'active';
    if (loan.status !== target) {
      await execute(`UPDATE loans SET status = $1 WHERE id = $2`, [target, loan.id]);
    }
    if (isOverdue) overdue++;
  }
  const accrued = await accrueOverdueInterest();
  return { overdue, accruedInterest: accrued.interest };
}