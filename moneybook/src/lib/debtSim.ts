// 债务偿还模拟（纯函数，无副作用，便于单元测试）
// -----------------------------------------------------------------------------
// 职责：对多笔欠款按「雪球（先清最小余额）／雪崩（先清最高利率）」策略做逐月推演，
// 并对比「仅按最低还款」与「追加每月额外还款」的总利息与结清时长。
// 不查库、不写库：欠款数据由 api 侧从 loans 表（direction='borrow'、remaining>0）聚合传入。
// 口径：按月计息（月利率 = 年利率 ÷ 12）；每月先计提当期利息，再分配还款——
//   ① 每笔保底还「最低还款」；② 剩余资金（含已结清笔释放出的最低还款）按策略
//   优先偿还目标债务。不计手续费、罚息与提前还款违约金。
// -----------------------------------------------------------------------------

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 结清判定阈值（避免浮点残值导致永不结清） */
const ZERO = 0.005;
/** 推演上限（月），防止「还款 < 利息」时死循环；超限视为无法结清 */
const MAX_MONTHS = 600;

export interface DebtInput {
  id: number;
  name: string;
  /** 剩余本金 */
  balance: number;
  /** 年利率（百分数，如 18.25） */
  apr: number;
  /** 每月最低还款额 */
  minPayment: number;
}

export type DebtStrategy = 'snowball' | 'avalanche';

export interface DebtPayoffResult {
  strategy: DebtStrategy;
  /** 全部结清所需月数；未能在上限内结清时为 -1 */
  months: number;
  /** 是否已全部结清 */
  cleared: boolean;
  totalInterest: number;
  totalPaid: number;
  /** 结清顺序（债务 id，按先后） */
  payoffOrder: number[];
  /** 各笔明细 */
  perDebt: { id: number; name: string; months: number; interest: number }[];
  /** 逐月时间线（月末总余额 / 当月利息 / 当月还款） */
  timeline: { month: number; totalBalance: number; interest: number; payment: number }[];
}

interface WorkItem {
  id: number;
  name: string;
  bal: number;
  /** 月利率（小数） */
  rate: number;
  min: number;
  interest: number;
  months: number;
  cleared: boolean;
}

/**
 * 推演多笔债务的偿还过程。
 * @param debts 欠款列表（余额<=0 的会被忽略）
 * @param extraMonthly 每月额外还款（在最低还款之外追加）
 * @param strategy 还款策略：snowball 先清最小余额 / avalanche 先清最高利率
 */
export function simulateDebtPayoff(
  debts: DebtInput[],
  extraMonthly: number,
  strategy: DebtStrategy
): DebtPayoffResult {
  const extra = Math.max(0, Number(extraMonthly) || 0);
  const items: WorkItem[] = (debts ?? [])
    .filter((d) => Number(d.balance) > ZERO)
    .map((d) => ({
      id: d.id,
      name: d.name,
      bal: round2(Number(d.balance)),
      rate: Math.max(0, Number(d.apr) || 0) / 100 / 12,
      min: Math.max(0, Number(d.minPayment) || 0),
      interest: 0,
      months: 0,
      cleared: false,
    }));

  // 固定月供总额 = 各笔最低还款之和 + 额外还款（某笔结清后其最低还款自动转为加速资金）
  const monthlyBudget = round2(items.reduce((s, x) => s + x.min, 0) + extra);
  const timeline: DebtPayoffResult['timeline'] = [];
  const payoffOrder: number[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;

  while (items.some((x) => x.bal > ZERO) && month < MAX_MONTHS) {
    month++;
    // ① 计提当月利息（计入本金）
    let interestThisMonth = 0;
    for (const x of items) {
      if (x.bal <= ZERO) continue;
      const i = round2(x.bal * x.rate);
      if (i === 0) continue;
      x.bal = round2(x.bal + i);
      x.interest = round2(x.interest + i);
      interestThisMonth = round2(interestThisMonth + i);
      totalInterest = round2(totalInterest + i);
    }
    // ② 保底：每笔按最低还款额偿付
    let cash = monthlyBudget;
    for (const x of items) {
      if (x.bal <= ZERO) continue;
      const pay = Math.min(x.min, x.bal);
      x.bal = round2(x.bal - pay);
      cash = round2(cash - pay);
    }
    // ③ 剩余资金按策略集中偿还目标债务
    while (cash > ZERO) {
      const pool = items.filter((x) => x.bal > ZERO);
      if (pool.length === 0) break;
      pool.sort((a, b) =>
        strategy === 'avalanche'
          ? (b.rate - a.rate) || (a.bal - b.bal)
          : (a.bal - b.bal) || (b.rate - a.rate)
      );
      const t = pool[0];
      const pay = Math.min(cash, t.bal);
      t.bal = round2(t.bal - pay);
      cash = round2(cash - pay);
    }
    // ④ 记录本月结清的债务（结清月即当前月）
    for (const x of items) {
      if (!x.cleared && x.bal <= ZERO) {
        x.cleared = true;
        x.months = month;
        payoffOrder.push(x.id);
      }
    }
    const paidThisMonth = round2(monthlyBudget - cash);
    totalPaid = round2(totalPaid + paidThisMonth);
    timeline.push({
      month,
      totalBalance: round2(items.reduce((s, x) => s + Math.max(0, x.bal), 0)),
      interest: interestThisMonth,
      payment: paidThisMonth,
    });
  }

  const cleared = items.length === 0 ? true : items.every((x) => x.bal <= ZERO);
  return {
    strategy,
    months: items.length === 0 ? 0 : cleared ? month : -1,
    cleared,
    totalInterest,
    totalPaid,
    payoffOrder,
    perDebt: items.map((x) => ({
      id: x.id,
      name: x.name,
      months: x.cleared ? x.months : -1,
      interest: x.interest,
    })),
    timeline,
  };
}

/**
 * 对比「基准方案」（如仅最低还款）与「加速方案」（追加额外还款）的收益。
 * 未能在上限内结清（months=-1）时，对应节省按 0 处理，避免出现无意义数值。
 */
export function comparePayoff(
  base: DebtPayoffResult,
  boosted: DebtPayoffResult
): { interestSaved: number; monthsSaved: number } {
  const interestSaved = round2(base.totalInterest - boosted.totalInterest);
  const monthsSaved = base.months > 0 && boosted.months > 0 ? base.months - boosted.months : 0;
  return { interestSaved, monthsSaved };
}
