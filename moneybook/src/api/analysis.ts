/**
 * 本地自主财务分析引擎（不依赖 AI / 云端）
 * ---------------------------------------------------------------
 * 本模块完全在本地运行：读取本地数据库的原始数据，按结构化规则产出
 * 「收支结构 + 趋势 + 集中度 + 储蓄/净资产 + 预算执行 + 账户流动性」的诊断，
 * 并给出按优先级排序的、可执行的本地建议。
 *
 * 隐私边界：本模块是「本地路线」，数据只在本机计算、展示，**绝不上传**，
 * 不受 AI 开关影响，也不做脱敏（因为根本不离开本机）。
 * 上传云端给 AI 的脱敏由 llm.ts 单独负责，二者互不干扰。
 */

import dayjs from 'dayjs';
import { currentLedgerId } from '@/lib/ledger';
import { select } from './db';
import {
  getCategoryDistribution,
  getPeriodComparison,
  getNetWorthTrend,
  getBudgetVsActualAdvanced,
} from './stats';

/** 本地方案可选的支出去向分析维度 */
export type AnalysisDimension = 'category' | 'account' | 'tag' | 'amount' | 'week';

const round = (n: number) => Math.round(n * 100) / 100;

/** 判定某分类是否属于「刚性/常设支出」倾向（近似启发式，用于结构分析） */
const FIXED_KEYWORDS = [
  '房租', '房贷', '车贷', '保险', '话费', '通讯', '流量', '宽带', '水费', '电费', '燃气',
  '物业', '地铁', '公交', '停车', '通勤', '订阅', '会员', '学费', '教育', '培训',
  '育儿', '托儿', '还款', '利息', '贷款', '公积金', '社保', '税金', '医疗',
];

function isFixedCategory(name: string): boolean {
  return FIXED_KEYWORDS.some((k) => name.includes(k));
}

export interface LocalAdvice {
  /** 1 最高优先级 */
  priority: 1 | 2 | 3;
  kind: 'structure' | 'saving' | 'budget' | 'wealth' | 'risk' | 'keep';
  title: string;
  detail: string;
}

export interface CategoryStat {
  name: string;
  icon: string;
  total: number;
  ratio: number; // 百分比（0-100）
}

export interface LocalDiagnosis {
  ym: string;
  dimension: AnalysisDimension;
  income: number;
  expense: number;
  surplus: number;
  savingsRate: number;
  /** 刚性/常设支出占比（占支出 0-1） */
  fixedRatio: number;
  fixedExpense: number;
  flexibleExpense: number;
  topExpense: CategoryStat[];
  top1Ratio: number; // 最大支出去向占比（%）
  top5Ratio: number; // 前 5 支出去向累计占比（%）
  incomeTop: CategoryStat[];
  singleIncomeRisk: boolean; // 是否高度依赖单一收入来源
  expMomPct: number | null; // 支出环比（%）
  expYoYPct: number | null; // 支出同比（%）
  netWorthDelta: number; // 净资产月度变化（元）
  netWorthChangePct: number | null;
  budgetOverCount: number; // 超预算分类数
  budgetAlertCount: number; // 快超标分类数（>=80%）
  healthScore: number;
  scoreLabel: string;
  advice: LocalAdvice[];
}

const ratioOf = (v: number, total: number) => (total > 0 ? Math.round((v / total) * 100) : 0);

interface BaseExpenseRow {
  name: string;
  total: number;
}

/** 金额区间档位（下限含，上限不含），用于「金额区间」维度 */
const AMOUNT_BUCKETS: { lower: number; upper: number | null; label: string }[] = [
  { lower: 0, upper: 50, label: '¥0-50' },
  { lower: 50, upper: 100, label: '¥50-100' },
  { lower: 100, upper: 300, label: '¥100-300' },
  { lower: 300, upper: 1000, label: '¥1000-' },
  { lower: 1000, upper: null, label: '¥1000+' },
];

/** 把单笔金额映射到所属金额区间 */
function amountBucket(amount: number): string {
  const hit = AMOUNT_BUCKETS.find((b) => amount >= b.lower && (b.upper === null || amount < b.upper));
  return hit?.label ?? '¥1000+';
}

/** 按日期计算其在锚定月内的周序（1-5），用于「周」维度 */
function weekOfMonth(date: string): string {
  const d = Number(String(date).slice(8, 10));
  const day = Number.isNaN(d) ? 1 : d;
  const week = Math.min(5, Math.floor((day - 1) / 7) + 1);
  return `第${week}周`;
}

/**
 * 按维度汇总本月支出去向（本地聚合）。
 * - category：复用 getCategoryDistribution（含图标）。
 * - account / tag：单表查询 + JS 关联，避免多表 JOIN 偶发 sql.js 错误，仅取本账本。
 */
async function expenseByDimension(
  dimension: AnalysisDimension,
  curStart: string,
  curEnd: string,
  lid: number
): Promise<BaseExpenseRow[]> {
  // 金额区间 / 周 维度：需要单笔金额与日期，按区间/周序聚合
  if (dimension === 'amount' || dimension === 'week') {
    const txs = await select<{ date: string; amount: number }>(
      `SELECT date, amount FROM transactions WHERE date BETWEEN $1 AND $2 AND type='expense' AND ledger_id = $3`,
      [curStart, curEnd, lid]
    );
    const agg = new Map<string, number>();
    for (const t of txs) {
      const key = dimension === 'amount' ? amountBucket(t.amount) : weekOfMonth(t.date);
      agg.set(key, (agg.get(key) ?? 0) + t.amount);
    }
    return [...agg.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
  }

  if (dimension === 'category') {
    const rows = await getCategoryDistribution('expense', curStart, curEnd);
    return rows.map((r) => ({ name: r.name, total: r.total }));
  }

  if (dimension === 'account') {
    const [txs, accs] = await Promise.all([
      select<{ account_id: number | null; amount: number }>(
        `SELECT account_id, amount FROM transactions WHERE date BETWEEN $1 AND $2 AND type='expense' AND ledger_id = $3`,
        [curStart, curEnd, lid]
      ),
      select<{ id: number; name: string }>(`SELECT id, name FROM accounts`),
    ]);
    const accMap = new Map(accs.map((a) => [a.id, a.name]));
    const agg = new Map<string, number>();
    for (const t of txs) {
      if (t.account_id == null) continue;
      const nm = accMap.get(t.account_id) ?? `账户#${t.account_id}`;
      agg.set(nm, (agg.get(nm) ?? 0) + t.amount);
    }
    return [...agg.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
  }

  // tag
  const [txs, rels, tags] = await Promise.all([
    select<{ id: number; amount: number }>(
      `SELECT id, amount FROM transactions WHERE date BETWEEN $1 AND $2 AND type='expense' AND ledger_id = $3`,
      [curStart, curEnd, lid]
    ),
    select<{ transaction_id: number; tag_id: number }>(`SELECT transaction_id, tag_id FROM transaction_tags`),
    select<{ id: number; name: string }>(`SELECT id, name FROM tags`),
  ]);
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const tagOfTx = new Map<number, string[]>();
  for (const r of rels) {
    const nm = tagName.get(r.tag_id);
    if (!nm) continue;
    const arr = tagOfTx.get(r.transaction_id) ?? [];
    arr.push(nm);
    tagOfTx.set(r.transaction_id, arr);
  }
  const agg = new Map<string, number>();
  for (const t of txs) {
    const names = tagOfTx.get(t.id);
    if (!names) continue;
    for (const nm of names) agg.set(nm, (agg.get(nm) ?? 0) + t.amount);
  }
  return [...agg.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
}

/** 生成某个锚定月（YYYY-MM）的本地自主财务诊断。dimension 控制支出去向分析的维度。 */
export async function analyzeLocally(
  anchorYm: string = dayjs().format('YYYY-MM'),
  opts: { dimension?: AnalysisDimension } = {}
): Promise<LocalDiagnosis> {
  const dimension = opts.dimension ?? 'category';
  const lid = currentLedgerId();
  const curStart = dayjs(`${anchorYm}-01`).format('YYYY-MM-DD');
  const curEnd = dayjs(curStart).endOf('month').format('YYYY-MM-DD');

  const [periods, expenseCats, expenseRows, incomeCats, nw, budgets] = await Promise.all([
    getPeriodComparison(anchorYm),
    getCategoryDistribution('expense', curStart, curEnd),
    expenseByDimension(dimension, curStart, curEnd, lid),
    getCategoryDistribution('income', curStart, curEnd),
    getNetWorthTrend(),
    getBudgetVsActualAdvanced({ period: 'monthly', anchor: anchorYm, ledgerId: lid }),
  ]);

  const cur = periods[0] ?? { income: 0, expense: 0, surplus: 0, ym: anchorYm };
  const prev = periods[1];
  const yoy = periods[2];

  const income = cur.income ?? 0;
  const expense = cur.expense ?? 0;
  const surplus = (cur.surplus ?? 0);
  const savingsRate = income > 0 ? surplus / income : 0;

  // 刚性 vs 弹性
  const fixExp = expenseCats.filter((c) => isFixedCategory(c.name));
  const fixedExpense = round(fixExp.reduce((s, c) => s + c.total, 0));
  const flexibleExpense = round(expense - fixedExpense);
  const fixedRatio = expense > 0 ? fixedExpense / expense : 0;

  // 支出去向 Top 与集中度（按所选 dimension）
  const topExpense: CategoryStat[] = expenseRows.slice(0, 5).map((c) => ({
    name: c.name,
    icon: dimension === 'category' ? (expenseCats.find((e) => e.name === c.name)?.icon ?? '') : '',
    total: c.total,
    ratio: ratioOf(c.total, expense),
  }));
  const top1Ratio = topExpense[0]?.ratio ?? 0;
  const top5Ratio = ratioOf(topExpense.reduce((s, c) => s + c.total, 0), expense);

  // 收入来源结构
  const incomeTop: CategoryStat[] = incomeCats.slice(0, 3).map((c) => ({
    name: c.name,
    icon: c.icon,
    total: c.total,
    ratio: ratioOf(c.total, income),
  }));
  const singleIncomeRisk = income > 0 && (incomeTop[0]?.ratio ?? 0) >= 70;

  // 支出环比/同比
  const pct = (curV: number, baseV: number | undefined): number | null => {
    if (!baseV || baseV <= 0) return null;
    return Math.round(((curV - baseV) / baseV) * 100);
  };
  const expMomPct = pct(expense, prev?.expense);
  const incomeMomPct = pct(income, prev?.income);
  const expYoYPct = pct(expense, yoy?.expense);

  // 净资产变化
  const nwDelta = (() => {
    if (!nw.history.length) return 0;
    const i = nw.history.findIndex((h) => h.month === anchorYm);
    const curNw = i >= 0 ? nw.history[i].net_worth : (i === -1 && nw.history.length ? nw.history[nw.history.length - 1].net_worth : 0);
    const prevNw = i > 0 ? nw.history[i - 1].net_worth : undefined;
    return round(prevNw !== undefined ? curNw - prevNw : 0);
  })();
  const nwChangePct =
    (() => {
      const i = nw.history.findIndex((h) => h.month === anchorYm);
      if (i > 0 && nw.history[i - 1].net_worth !== 0 && nw.history[i - 1].net_worth !== undefined) {
        return Math.round(((nw.history[i].net_worth - nw.history[i - 1].net_worth) / nw.history[i - 1].net_worth) * 100);
      }
      return null;
    })() ?? null;

  // 预算执行
  const budgetOver = budgets.filter((b) => b.status === 'over');
  const budgetAlert = budgets.filter((b) => b.status === 'ok' && b.usable > 0 && b.actual / b.usable >= 0.8);
  const budgetOverCount = budgetOver.length;
  const budgetAlertCount = budgetAlert.length;

  // 健康度评分（与 getInsights 口径保持一致，供本地建议使用）
  let sScore = 0;
  if (savingsRate >= 0.3) sScore = 40;
  else if (savingsRate >= 0.2) sScore = 32;
  else if (savingsRate >= 0.1) sScore = 24;
  else if (savingsRate >= 0) sScore = 14;
  else sScore = 0;
  const overPenalty = budgetOverCount === 0 ? 30 : budgetOverCount === 1 ? 20 : Math.max(8, 30 - budgetOverCount * 10);
  const bScore = budgets.length === 0 ? 22 : overPenalty;
  const score = Math.round(sScore + bScore);
  const scoreLabel = score >= 80 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '需关注' : '风险';

  // ---------------- 本地建议（规则化、按优先级） ----------------
  const advice: LocalAdvice[] = [];

  if (savingsRate < 0 && income > 0) {
    advice.push({
      priority: 1, kind: 'risk',
      title: '本月入不敷出',
      detail: `支出 ¥${expense.toFixed(2)} 已超过收入 ¥${income.toFixed(2)}，结余 ¥${surplus.toFixed(2)}。优先从弹性支出入手：先列出现有订阅/会员并取消闲置项，连续 1 周记账后复盘再优化。`,
    });
  } else if (savingsRate < 0.1) {
    advice.push({
      priority: 2, kind: 'saving',
      title: '储蓄率偏低',
      detail: `本月储蓄率 ${(savingsRate * 100).toFixed(0)}%，建议先把刚性支出压到最低、弹性支出砍掉三档中的非必要项，将储蓄率提升到 10% 以上再逐步到 20%。`,
    });
  }

  if (budgetOverCount > 0) {
    const names = budgetOver.map((b) => `${b.category_icon ?? ''}${b.category_name ?? '总预算'}`).join('、');
    advice.push({
      priority: 1, kind: 'budget',
      title: `${budgetOverCount} 项预算已超支`,
      detail: `超支项：${names}。请复核这些分类的支出明细，判断是额度定低了还是确有突发开销，再决定压缩消费或调整预算额度。`,
    });
  } else if (budgetAlertCount > 0) {
    advice.push({
      priority: 3, kind: 'budget',
      title: `${budgetAlertCount} 项预算接近上限`,
      detail: '本月离结束还有时日，留意已用到 80% 以上的预算项，控制后续相关消费。',
    });
  }

  if (top1Ratio >= 40) {
    advice.push({
      priority: 2, kind: 'structure',
      title: `支出去向集中（首位占 ${top1Ratio}%）`,
      detail: `最大开销「${topExpense[0].icon}${topExpense[0].name}」占支出的 ${top1Ratio}%。单一去向占比过高时，一旦该部分波动就会明显冲击整体支出，建议分散并为其单独设预算观察。`,
    });
  }

  if (singleIncomeRisk) {
    advice.push({
      priority: 2, kind: 'risk',
      title: '收入来源单一',
      detail: `收入高度集中于「${incomeTop[0].icon}${incomeTop[0].name}」（占 ${incomeTop[0].ratio}%）。建议评估副业/被动收入可能，降低对单一收入来源的依赖。`,
    });
  }

  if (nwChangePct !== null) {
    if (nwChangePct <= -5) {
      advice.push({
        priority: 2, kind: 'wealth',
        title: '净资产环比下滑',
        detail: `净资产较上月变化 ¥${nwDelta.toFixed(2)}（${nwChangePct}%）。请复盘当期收支与借贷，优先结清高息负债，避免消耗型负债扩大。`,
      });
    } else if (nwChangePct >= 5 && savingsRate >= 0) {
      advice.push({
        priority: 3, kind: 'wealth',
        title: '净资产正增长',
        detail: `净资产较上月增长 ¥${nwDelta.toFixed(2)}（${nwChangePct}%）。可将新增结余转入储蓄/投资账户，保持当前节奏。`,
      });
    }
  }

  if (expMomPct !== null && expMomPct >= 30) {
    advice.push({
      priority: 2, kind: 'structure',
      title: `支出环比增长 ${expMomPct}%`,
      detail: '本月支出较上月明显上升。请定位增长最快的分类，区分一次性还是趋势性开销，对趋势性部分及时设限。',
    });
  }

  if (budgets.length === 0) {
    advice.push({
      priority: 3, kind: 'budget',
      title: '尚未设置预算',
      detail: '为支出较高的分类设置月度预算，可提前预警超支。建议从本月支出 Top 分类开始设定。',
    });
  }

  if (savingsRate >= 0.2 && budgetOverCount === 0 && top1Ratio < 40) {
    advice.push({
      priority: 3, kind: 'keep',
      title: '本月财务健康向好',
      detail: `储蓄率 ${(savingsRate * 100).toFixed(0)}%、无超支、支出不集中。建议维持并定期关注分类演变。`,
    });
  }

  advice.sort((a, b) => a.priority - b.priority);

  return {
    ym: anchorYm,
    dimension,
    income: round(income),
    expense: round(expense),
    surplus: round(surplus),
    savingsRate: round(savingsRate),
    fixedRatio: round(fixedRatio),
    fixedExpense,
    flexibleExpense,
    topExpense,
    top1Ratio,
    top5Ratio,
    incomeTop,
    singleIncomeRisk,
    expMomPct,
    expYoYPct,
    netWorthDelta: nwDelta,
    netWorthChangePct: nwChangePct,
    budgetOverCount,
    budgetAlertCount,
    healthScore: score,
    scoreLabel,
    advice,
  };
}