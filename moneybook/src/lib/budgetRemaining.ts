// 本月「剩余可花」计算（纯函数，供仪表盘展示与单元测试）
// -----------------------------------------------------------------------------
// 口径：优先用「总预算」（category_id 为 null 的预算行）；没有总预算时，
// 退化为把各分类预算相加作为总额度，已用取这些分类预算的实际支出之和。
// 剩余可花 = 总额度 − 已用；日均可用 = 剩余可花 ÷ 本月剩余天数（含今天）。
// 无任何预算时 hasBudget=false，调用方应直接不展示该卡片（不编造模拟数据）。
// -----------------------------------------------------------------------------
import dayjs from 'dayjs';

export interface BudgetScopeRow {
  /** 预算行对应的分类；null 表示「总预算」 */
  category_id: number | null;
  budget_amount: number;
  /** 该预算范围内的实际支出（已由 SQL 汇总） */
  actual: number;
}

export type SpendableScope = 'total' | 'category' | 'none';

export interface SpendableResult {
  /** 是否存在任何预算配置 */
  hasBudget: boolean;
  /** 预算口径：总预算 / 分类预算合计 / 无 */
  scope: SpendableScope;
  /** 本月预算总额度 */
  totalBudget: number;
  /** 本月已用（按上述口径） */
  spent: number;
  /** 剩余可花（可为负，表示已超支） */
  remaining: number;
  /** 本月剩余天数（含今天，最小为 1） */
  daysLeft: number;
  /** 日均可用（剩余可花 ÷ 剩余天数；已超支时为负） */
  perDay: number;
  /** 是否已超支 */
  overBudget: boolean;
}

/**
 * 标记「已被总预算覆盖」的分类预算行（纯函数，便于单测）。
 *
 * 口径：总预算（category_id 为 null）的实际支出已经是当月全部支出，分类预算只是它的细分。
 * 因此当总预算存在时，分类行不应再被当作独立额度计入「剩余可花」，也不应再单独触发超支提醒，
 * 否则同一笔支出会被重复统计、用户会以为两套额度可以叠加。
 * @param rows 预算对比行（通常来自 getBudgetVsActual）
 * @returns 原行 + shadowed 标记（存在总预算时分类行为 true，总预算行与无总预算场景为 false）
 */
export function markShadowedBudgets<T extends { category_id: number | null }>(
  rows: T[]
): Array<T & { shadowed: boolean }> {
  const hasTotal = rows.some((r) => r.category_id == null);
  return rows.map((r) => ({ ...r, shadowed: hasTotal && r.category_id != null }));
}

/**
 * 计算本月剩余可花。
 * @param rows 预算对比实际的行（通常来自 getBudgetVsActual）
 * @param today 今天日期 YYYY-MM-DD（默认当前日期）
 */
export function computeSpendable(rows: BudgetScopeRow[], today = dayjs().format('YYYY-MM-DD')): SpendableResult {
  const todayD = dayjs(today);
  const daysInMonth = todayD.daysInMonth();
  // 剩余天数含今天：28 号看当月（31 天）→ 4 天；跨月脏数据也至少按 1 天算
  const day = Math.min(Math.max(1, todayD.date()), daysInMonth);
  const daysLeft = Math.max(1, daysInMonth - day + 1);

  const totalRows = rows.filter((r) => r.category_id == null);
  const catRows = rows.filter((r) => r.category_id != null);

  let scope: SpendableScope = 'none';
  let totalBudget = 0;
  let spent = 0;

  if (totalRows.length > 0) {
    // 总预算可能存在多行（历史数据），额度相加；实际支出取总预算行的合计
    scope = 'total';
    totalBudget = totalRows.reduce((s, r) => s + Number(r.budget_amount || 0), 0);
    spent = totalRows.reduce((s, r) => s + Number(r.actual || 0), 0);
  } else if (catRows.length > 0) {
    // 仅分类预算：总额度 = 各分类预算之和，已用 = 各分类实际之和
    scope = 'category';
    totalBudget = catRows.reduce((s, r) => s + Number(r.budget_amount || 0), 0);
    spent = catRows.reduce((s, r) => s + Number(r.actual || 0), 0);
  }

  const hasBudget = totalBudget > 0;
  const remaining = totalBudget - spent;
  const perDay = daysLeft > 0 ? remaining / daysLeft : remaining;

  return {
    hasBudget,
    scope,
    totalBudget,
    spent,
    remaining,
    daysLeft,
    perDay,
    overBudget: remaining < -0.001,
  };
}
