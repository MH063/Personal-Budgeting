import dayjs from 'dayjs';
import { analyzeLocally } from './analysis';
import { getInsights, getNetWorth, getBudgetVsActualAdvanced } from './stats';
import { listNegativeAccounts } from './accounts';
import { fetchMonthlySeries, type CategorySeries } from './predict';

/**
 * 个性化省钱建议 + 财务健康评分（纯本地规则，无网络）
 * ---------------------------------------------------------------
 * ① 健康评分：由储蓄率、刚性支出占比、预算是否超支、是否入不敷出、负债比例等综合打分（0-100）。
 * ② 个性化省钱建议：对"可削减"的弹性类目，若近月均额较高，给出"减少 N 次/降低 Y%"可省 ¥X/月」的具体建议。
 * 评分与建议均为核心纯函数，便于单测；buildHealthReview 负责拉取真实数据并编排。
 */

export interface HealthInput {
  /** 0~1 */
  savingsRate: number;
  /** 0~1 刚性支出占比 */
  fixedRatio: number;
  /** 0~100 既有支出健康度 */
  expenseHealth: number;
  /** 超支预算项数 */
  overBudget: number;
  /** 是否存在账户负余额 */
  hasNegative: boolean;
  /** 结余（正=有结余，负=入不敷出） */
  surplus: number;
  /** 负债/净资产比（净资产负债率），无负债为 0 */
  debtRatio: number;
}

export interface HealthFactor {
  name: string;
  note: string;
  delta: number;
}

export interface HealthResult {
  score: number;
  label: '优秀' | '良好' | '需关注' | '较差';
  factors: HealthFactor[];
}

export function computeHealthScore(inp: HealthInput): HealthResult {
  const factors: HealthFactor[] = [];
  let score = 60;
  const add = (name: string, note: string, delta: number) => {
    score += delta;
    factors.push({ name, note, delta });
  };

  if (inp.savingsRate >= 0.3) add('储蓄率', `储蓄率 ${(inp.savingsRate * 100).toFixed(0)}%，非常稳健`, 20);
  else if (inp.savingsRate >= 0.2) add('储蓄率', `储蓄率 ${(inp.savingsRate * 100).toFixed(0)}%，较稳健`, 12);
  else if (inp.savingsRate >= 0.1) add('储蓄率', `储蓄率 ${(inp.savingsRate * 100).toFixed(0)}%，尚可`, 4);
  else if (inp.savingsRate >= 0) add('储蓄率', '储蓄率偏低，建议提升到 10% 以上', 0);
  else add('储蓄率', '本月入不敷出', -15);

  if (inp.fixedRatio <= 0.5) add('刚性支出', `刚性支出占比 ${(inp.fixedRatio * 100).toFixed(0)}%，弹性空间充足`, 10);
  else if (inp.fixedRatio <= 0.6) add('刚性支出', `刚性支出占比 ${(inp.fixedRatio * 100).toFixed(0)}%，合理`, 4);
  else if (inp.fixedRatio <= 0.7) add('刚性支出', '刚性支出占比偏高，弹性可压缩空间有限', 0);
  else add('刚性支出', '刚性支出占比过高，易影响结余', -10);

  // 支出健康度归一：>60 加分，<50 扣分
  add('支出健康', `综合消费健康度 ${Math.round(inp.expenseHealth)}`, Math.round((inp.expenseHealth - 60) / 4));

  if (inp.overBudget > 0) add('预算执行', `有 ${inp.overBudget} 项预算超支`, -5 * inp.overBudget);
  if (inp.hasNegative) add('账户余额', '存在账户余额为负', -8);

  if (inp.surplus > 0) add('结余', `本月结余 ¥${inp.surplus.toFixed(0)}`, 6);
  else if (inp.surplus < 0) add('结余', '本月入不敷出，需警惕', -12);

  if (inp.debtRatio >= 0.5) add('负债率', `净资产负债率 ${(inp.debtRatio * 100).toFixed(0)}% 偏高`, -10);
  else if (inp.debtRatio > 0.2) add('负债率', '有一定负债，注意还款现金流', -4);
  else if (inp.debtRatio > 0) add('负债率', '负债处于低水平', 3);

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const label: HealthResult['label'] = clamped >= 80 ? '优秀' : clamped >= 60 ? '良好' : clamped >= 40 ? '需关注' : '较差';
  return { score: clamped, label, factors };
}

/** 可削减类目关键词（弹性支出） */
const REDUCIBLE = ['外卖', '餐饮', '零食', '购物', '娱乐', '咖啡', '奶茶', '游戏'];

export interface SavingsSuggestion {
  scene: string;
  amountSaving: number;
  currentAvg: number;
  msg: string;
}

/**
 * 个性化省钱建议：对"可削减"类目且近 3 月均值 ≥ threshold 的分类，生成"减少 20% 可省 ¥X/月"。
 * 纯函数，便于单测。
 */
export function suggestSavings(series: CategorySeries[], opts: { threshold?: number; reduceRatio?: number } = {}): SavingsSuggestion[] {
  const threshold = opts.threshold ?? 200;
  const ratio = opts.reduceRatio ?? 0.2;
  const out: SavingsSuggestion[] = [];
  for (const s of series) {
    if (!REDUCIBLE.some((k) => s.name.includes(k))) continue;
    // 近 3 个月均值
    const recent = s.values.slice(-3);
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    if (avg < threshold) continue;
    const saving = Math.round((avg * ratio) / 10) * 10;
    out.push({
      scene: s.name,
      currentAvg: Math.round(avg),
      amountSaving: saving,
      msg: `「${s.name}」月均约 ¥${Math.round(avg)}，若减少 ${Math.round(ratio * 100)}% 可省约 ¥${saving}/月`,
    });
  }
  return out.sort((a, b) => b.amountSaving - a.amountSaving).slice(0, 5);
}

export interface HealthReview {
  score: HealthResult;
  suggestions: SavingsSuggestion[];
}

/** 拉取真实数据并编排健康评分 + 省钱建议（当前账月）。 */
export async function buildHealthReview(): Promise<HealthReview> {
  const ym = dayjs().format('YYYY-MM');
  const d = await analyzeLocally(ym);
  const ins = await getInsights(ym);
  const budgets = await getBudgetVsActualAdvanced({ period: 'monthly', anchor: ym });
  const negatives = await listNegativeAccounts();
  const nw = await getNetWorth();
  const { categories } = await fetchMonthlySeries('expense', 3);

  const overBudget = budgets.filter((b) => b.status === 'over').length;
  const debtRatio = nw.netWorth > 0 ? Math.max(0, nw.totalLiab / nw.netWorth) : 0;
  const score = computeHealthScore({
    savingsRate: d.savingsRate,
    fixedRatio: d.fixedRatio,
    expenseHealth: ins.score,
    overBudget,
    hasNegative: negatives.length > 0,
    surplus: d.surplus,
    debtRatio,
  });
  return { score, suggestions: suggestSavings(categories) };
}