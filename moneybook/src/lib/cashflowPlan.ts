// 现金流场景预测（纯函数，无副作用，便于单元测试）
// -----------------------------------------------------------------------------
// 职责：在「收入/支出基线」之上叠加用户假设（收入涨跌、分类支出调整、一次性
// 收支、每月额外储蓄），按月推演未来 N 个月的现金流与累计结余。
// 不查库、不写库：基线数据由 api/planning.ts 聚合传入，本模块只做确定性推演。
// 口径说明：这是「假设推演」而非精算预测——相同输入必得相同输出，便于单测与解释。
// -----------------------------------------------------------------------------

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 月份字符串（'YYYY-MM'）整体偏移若干个月（自实现，避免依赖时区/本地化） */
function shiftMonth(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export interface ExpenseItem {
  /** 分类名称（仅用于展示） */
  name: string;
  /** 月度支出基线 */
  base: number;
  /** 变化百分比（正=增加，负=减少） */
  deltaPct: number;
}

export interface OneOff {
  /** 发生的月份 'YYYY-MM' */
  ym: string;
  /** 正=一次性收入，负=一次性支出 */
  amount: number;
  /** 备注（展示用） */
  label?: string;
}

export interface CashflowAssumption {
  /** 预测起始月 'YYYY-MM' */
  startYm: string;
  /** 预测月数 */
  months: number;
  /** 月收入基线 */
  incomeBase: number;
  /** 收入变化百分比（可选） */
  incomeDeltaPct?: number;
  /** 各分类支出基线及其变化 */
  expenseItems: ExpenseItem[];
  /** 每月额外储蓄（计入当期流出，用于储蓄目标推演） */
  extraMonthlySaving?: number;
  /** 一次性收支（按 ym 落入对应月份） */
  oneOffs?: OneOff[];
}

export interface CashflowRow {
  ym: string;
  /** 当月收入（含一次性收入） */
  income: number;
  /** 当月支出（含一次性支出） */
  expense: number;
  /** 当月额外储蓄 */
  saving: number;
  /** 当月净现金流 = 收入 − 支出 − 储蓄 */
  net: number;
  /** 累计结余（自预测起点累积） */
  cumulative: number;
  /** 当月一次性项备注 */
  oneOffNote?: string;
}

export interface CashflowPlanResult {
  rows: CashflowRow[];
  totalIncome: number;
  totalExpense: number;
  totalSaving: number;
  /** 期末累计结余 */
  endBalance: number;
  /** 累计结余最低点 */
  minCumulative: number;
  /** 累计结余最低点所在月份 */
  minYm: string;
  /** 累计结余为负（入不敷出）的月份列表 */
  deficitMonths: string[];
}

/**
 * 按月推演现金流。
 * 逻辑：当月收入 = 基线 × (1+收入变化%) + 一次性收入；
 *      当月支出 = Σ(分类基线 × (1+该分类变化%)) + 一次性支出；
 *      净现金流 = 收入 − 支出 − 额外储蓄；逐月累计得结余曲线。
 * 边界：months<=0 返回空结果；负的基线/储蓄按 0 处理。
 */
export function simulateCashflow(a: CashflowAssumption): CashflowPlanResult {
  const months = Math.max(0, Math.floor(Number(a.months)) || 0);
  const saving = Math.max(0, Number(a.extraMonthlySaving) || 0);
  const income = round2((Number(a.incomeBase) || 0) * (1 + (Number(a.incomeDeltaPct) || 0) / 100));
  const items = a.expenseItems ?? [];
  const oneOffs = a.oneOffs ?? [];

  const rows: CashflowRow[] = [];
  let cumulative = 0;
  let totalIncome = 0;
  let totalExpense = 0;
  let totalSaving = 0;
  let minCumulative = 0;
  let minYm = a.startYm;
  const deficitMonths: string[] = [];

  for (let i = 0; i < months; i++) {
    const ym = shiftMonth(a.startYm, i);
    // 分类支出：按各自变化率调整后求和
    const expense = round2(
      items.reduce((s, it) => s + (Number(it.base) || 0) * (1 + (Number(it.deltaPct) || 0) / 100), 0)
    );
    // 落入本月的一次性项：正负拆分为收入/支出，便于分列展示
    const offs = oneOffs.filter((o) => o && o.ym === ym);
    const offSum = round2(offs.reduce((s, o) => s + (Number(o.amount) || 0), 0));
    const offIncome = Math.max(0, offSum);
    const offExpense = Math.max(0, -offSum);
    const oneOffNote = offs.map((o) => o.label).filter(Boolean).join('、') || undefined;

    const rowIncome = round2(income + offIncome);
    const rowExpense = round2(expense + offExpense);
    const net = round2(rowIncome - rowExpense - saving);
    cumulative = round2(cumulative + net);

    totalIncome = round2(totalIncome + rowIncome);
    totalExpense = round2(totalExpense + rowExpense);
    totalSaving = round2(totalSaving + saving);

    if (i === 0 || cumulative < minCumulative) {
      minCumulative = cumulative;
      minYm = ym;
    }
    if (cumulative < 0) deficitMonths.push(ym);

    rows.push({ ym, income: rowIncome, expense: rowExpense, saving, net, cumulative, oneOffNote });
  }

  return {
    rows,
    totalIncome,
    totalExpense,
    totalSaving,
    endBalance: cumulative,
    minCumulative,
    minYm,
    deficitMonths,
  };
}
