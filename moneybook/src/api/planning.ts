// 预算与现金流规划：数据聚合层
// -----------------------------------------------------------------------------
// 为「规划」页提供三类聚合数据：年度预算总览、场景预测基线、债务还款模拟输入。
// 一律读真实库表，绝不返回模拟数据；纯计算委托给 src/lib 下的纯函数
// （annualBudget / cashflowPlan / debtSim），本层只负责查库与组装。
// -----------------------------------------------------------------------------
import dayjs from 'dayjs';
import { select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { getBudgetVsActualAdvanced } from './stats';
import { computeAnnualProgress, splitAnnualToMonthly, type AnnualProgress } from '@/lib/annualBudget';
import { fetchMonthlySeries } from './predict';
import { listLoans, getLoanNextDue, type Loan } from './loans';

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AnnualBudgetOverview {
  year: string;
  /** 年度预算合计（优先取「总预算」行；无总预算则汇总各分类年度预算；均无则为 0） */
  yearBudget: number;
  /** 年度实际支出合计（直接由 transactions 汇总，避免多行预算重复计实际） */
  yearActual: number;
  /** 年度进度与外推指标（纯函数计算） */
  progress: AnnualProgress;
  /** 逐月：预算基线 vs 实际支出（12 项，缺失月补 0） */
  monthly: { ym: string; budget: number; actual: number }[];
}

/**
 * 年度预算总览。
 * 口径说明（重要，避免重复计数）：
 *  - 年度预算合计：若存在「总预算」行（category_id 为 NULL），直接取它；
 *    否则汇总各分类年度预算；两者都没有则为 0（界面提示"未设年度预算"）。
 *  - 年度实际支出：不累加各行预算的 actual（总预算行与分类行会重复），
 *    而是从 transactions 直接汇总当年支出，保证真实唯一。
 *  - 预算基线：年度额按 12 个月均分（splitAnnualToMonthly），仅作柱状图参考线。
 */
export async function getAnnualBudgetOverview(year: string): Promise<AnnualBudgetOverview> {
  const lid = currentLedgerId();
  const rows = await getBudgetVsActualAdvanced({ period: 'yearly', anchor: `${year}-01`, ledgerId: lid });

  const totalRows = rows.filter((r) => r.category_id == null);
  const yearBudget = round2(
    (totalRows.length ? totalRows : rows).reduce((s, r) => s + (Number(r.period_amount) || 0), 0)
  );

  const [actualRow] = await select<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE type = 'expense' AND ledger_id = $1 AND date BETWEEN $2 AND $3`,
    [lid, `${year}-01-01`, `${year}-12-31`]
  );
  const yearActual = round2(Number(actualRow?.total) || 0);

  // 逐月实际支出（缺失月补 0）
  const expRows = await select<{ ym: string; exp: number }>(
    `SELECT strftime('%Y-%m', date) AS ym, SUM(amount) AS exp FROM transactions
     WHERE type = 'expense' AND ledger_id = $1 AND date BETWEEN $2 AND $3
     GROUP BY ym`,
    [lid, `${year}-01-01`, `${year}-12-31`]
  );
  const expMap = new Map(expRows.map((r) => [r.ym, Number(r.exp) || 0]));
  const baseline = splitAnnualToMonthly(yearBudget);
  const monthly: AnnualBudgetOverview['monthly'] = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    monthly.push({ ym, budget: baseline[m - 1] ?? 0, actual: round2(expMap.get(ym) ?? 0) });
  }

  // 已过月数：往年=12、今年=当前月、未来年=0
  const now = dayjs();
  const curYear = now.year();
  const monthsElapsed = Number(year) < curYear ? 12 : Number(year) > curYear ? 0 : now.month() + 1;

  const progress = computeAnnualProgress({
    monthsElapsed, totalMonths: 12, actualToDate: yearActual, budgetTotal: yearBudget,
  });
  console.log(`[planning] 年度总览 ${year}：预算 ${yearBudget}，实际 ${yearActual}，已过 ${monthsElapsed} 个月`);
  return { year, yearBudget, yearActual, progress, monthly };
}

export interface PlanningBaseline {
  /** 采样窗口宽度（月） */
  windowMonths: number;
  /** 窗口内"实际有数据"的最大月份数（样本是否充足） */
  sampleMonths: number;
  /** 月均收入 */
  incomeAvg: number;
  /** 月均支出（分类明细，按金额降序，最多 8 项） */
  expenseItems: { name: string; icon: string; base: number }[];
  /** 月均支出合计 */
  expenseTotal: number;
}

/** 数组均值（空数组返回 0） */
function avg(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

/** 把「各分类的逐月序列」按月份纵向求和，得到每月合计序列 */
function sumByMonth(cats: { values: number[] }[], len: number): number[] {
  const out = new Array(len).fill(0) as number[];
  for (const c of cats) {
    for (let i = 0; i < len; i++) out[i] += Number(c.values[i]) || 0;
  }
  return out;
}

/**
 * 场景预测基线：近 N 个月的月均收入与分类月均支出。
 * 复用 fetchMonthlySeries（含补零到整月窗口），使基线与「下月预测」口径一致。
 */
export async function getPlanningBaseline(months = 6): Promise<PlanningBaseline> {
  const [inc, exp] = await Promise.all([
    fetchMonthlySeries('income', months),
    fetchMonthlySeries('expense', months),
  ]);
  const incomeMonthly = sumByMonth(inc.categories, inc.ymList.length);
  const incomeAvg = round2(avg(incomeMonthly));

  const expenseItems = exp.categories
    .map((c) => ({ name: c.name, icon: c.icon || '', base: round2(avg(c.values)) }))
    .filter((c) => c.base > 0)
    .sort((a, b) => b.base - a.base)
    .slice(0, 8);
  const expenseTotal = round2(expenseItems.reduce((s, c) => s + c.base, 0));
  const sampleMonths = exp.categories.reduce(
    (mx, c) => Math.max(mx, c.values.filter((v) => v > 0).length), 0
  );

  console.log(`[planning] 场景基线（近 ${months} 月）：月均收入 ${incomeAvg}，月均支出 ${expenseTotal}`);
  return { windowMonths: months, sampleMonths, incomeAvg, expenseItems, expenseTotal };
}

export interface PlanningDebt {
  id: number;
  /** 对方名称 */
  name: string;
  /** 剩余本金 */
  balance: number;
  /** 年利率（百分数） */
  apr: number;
  /** 每月最低还款建议值（可由用户修改） */
  minPayment: number;
  /** 建议值是否来自还款计划（true=自动带出；false=到期一次，需用户填） */
  minFromSchedule: boolean;
}

/** 依据还款方式给出"每月最低还款"建议：分期还款取下一期应还；到期一次无固定月供返回 0 */
function suggestMinPayment(loan: Loan): number {
  const method = loan.method ?? 'balloon';
  const n = loan.periods && loan.periods > 0 ? loan.periods : 0;
  if (method === 'balloon' || n <= 0) return 0;
  const due = getLoanNextDue(loan);
  return due ? round2(due.payment) : 0;
}

/** 待模拟借款：取借贷表中「借入、未结清、仍有剩余本金」的记录 */
export async function getPlanningDebts(): Promise<PlanningDebt[]> {
  const loans = await listLoans();
  const debts = loans
    .filter((l) => l.direction === 'borrow' && Number(l.remaining) > 0.005 && l.status !== 'settled')
    .map((l) => {
      const suggested = suggestMinPayment(l);
      return {
        id: l.id,
        name: l.counterparty || `借款 #${l.id}`,
        balance: round2(Number(l.remaining) || 0),
        apr: Number(l.rate) || 0,
        minPayment: suggested,
        minFromSchedule: suggested > 0,
      };
    });
  console.log(`[planning] 待模拟借款 ${debts.length} 笔`);
  return debts;
}
