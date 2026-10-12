// 年度预算总览计算（纯函数，无副作用，便于单元测试）
// -----------------------------------------------------------------------------
// 职责：把「年度预算额度」与「年初至今实际支出」转换为年度进度指标：
// 时间进度、预算消耗进度、节奏比、年末线性外推与掉队判定。
// 本模块不查库、不写库，数据由调用方（api/planning.ts）聚合后传入，
// 便于规划页与统计页复用同一口径。
// 口径说明：外推采用「已用 ÷ 时间进度」的线性假设，仅作趋势提示，非精算预测。
// -----------------------------------------------------------------------------

/** 保留两位小数（金额/比值统一口径） */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AnnualProgressInput {
  /** 已过去的整月数（含当月，1~12）；用于计算时间进度 */
  monthsElapsed: number;
  /** 全年月数，默认 12（自然年） */
  totalMonths?: number;
  /** 年初至今实际支出合计 */
  actualToDate: number;
  /** 年度预算总额（未设预算传 0） */
  budgetTotal: number;
}

export interface AnnualProgress {
  /** 时间进度 0~1（已过月数 ÷ 全年月数），已归一到 [0,1] */
  timeRatio: number;
  /** 预算消耗进度 0~1（实际 ÷ 预算；无预算时为 0） */
  usedRatio: number;
  /** 节奏比 = 消耗进度 ÷ 时间进度（>1 超速、<1 有余量；时间进度为 0 时为 0） */
  paceRatio: number;
  /** 按当前节奏线性外推的年末实际支出 */
  forecastYearEnd: number;
  /** 年末预计结余 = 预算 − 外推（可为负） */
  forecastRemaining: number;
  /** 是否掉队：有预算且外推支出超过预算总额 */
  offTrack: boolean;
}

/**
 * 计算年度预算进度与年末外推。
 * 边界：monthsElapsed 会被裁剪到 [0, totalMonths]；时间进度为 0（年初）时不做外推。
 */
export function computeAnnualProgress(input: AnnualProgressInput): AnnualProgress {
  const totalMonths = input.totalMonths && input.totalMonths > 0 ? input.totalMonths : 12;
  const elapsed = Math.max(0, Math.min(Number(input.monthsElapsed) || 0, totalMonths));
  const actual = Math.max(0, Number(input.actualToDate) || 0);
  const budget = Math.max(0, Number(input.budgetTotal) || 0);

  const timeRatio = elapsed / totalMonths;
  const usedRatio = budget > 0 ? actual / budget : 0;
  const paceRatio = timeRatio > 0 ? usedRatio / timeRatio : 0;
  const forecastYearEnd = timeRatio > 0 ? round2(actual / timeRatio) : 0;
  const forecastRemaining = round2(budget - forecastYearEnd);

  return {
    timeRatio: round2(timeRatio),
    usedRatio: round2(usedRatio),
    paceRatio: round2(paceRatio),
    forecastYearEnd,
    forecastRemaining,
    offTrack: budget > 0 && forecastYearEnd > budget,
  };
}

/**
 * 把年度额度分解到各月，用于「年度预算 vs 实际」柱状图的预算基线。
 * - 不传 weights：按 12 个月均分。
 * - 传 weights：按权重归一化分配（权重之和为 0 时退化为均分）。
 * - 末月用「总额 − 前 N−1 月之和」修正，保证分解后合计严格等于 annualAmount。
 */
export function splitAnnualToMonthly(annualAmount: number, weights?: number[]): number[] {
  const months = weights && weights.length > 0 ? weights.length : 12;
  const total = Number(annualAmount) || 0;
  const sumW = weights ? weights.reduce((s, w) => s + (Number(w) || 0), 0) : 0;
  const useWeights = !!weights && sumW > 0;

  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < months; i++) {
    const ratio = useWeights ? (Number(weights![i]) || 0) / sumW : 1 / months;
    const v = i === months - 1 ? round2(total - acc) : round2(total * ratio);
    acc = round2(acc + v);
    out.push(v);
  }
  return out;
}
