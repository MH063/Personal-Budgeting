import dayjs from 'dayjs';
import { readAIConfig } from '@/stores/useAIStore';
import { sanitizeForClassification } from '@/lib/sanitize';
import { chat } from './llm';
import { getCategoryDistribution, getInsights } from './stats';
import { buildHealthReview } from './healthScore';
import { buildSubscriptionReminders } from './subscription';
import { buildAnomalyReport } from './anomaly';

/**
 * 自动周报 / 月报生成
 * ---------------------------------------------------------------
 * 本地先把本期收支、分类 TOP、环比、健康分、订阅到期、异常等聚合成结构化数据，
 * 直接生成一份 markdown 报告（无 AI 也可用）；若已启用 AI 且允许发送明细，
 * 则把"脱敏的聚合数据"交给 LLM 生成更自然的总结与建议，失败自动回退本地报告；
 * 全程不上送单笔明细。
 */

export type ReportPeriod = 'week' | 'month';

/** 纯函数：计算两个周期范围的起止（本周/本月 + 上一等价期）。 */
export function buildPeriodRange(period: ReportPeriod): { from: string; to: string; prevFrom: string; prevTo: string } {
  if (period === 'week') {
    const from = dayjs().startOf('week').format('YYYY-MM-DD');
    const to = dayjs().endOf('week').format('YYYY-MM-DD');
    const len = 6;
    const prevTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
    const prevFrom = dayjs(prevTo).subtract(len, 'day').format('YYYY-MM-DD');
    return { from, to, prevFrom, prevTo };
  }
  const from = dayjs().startOf('month').format('YYYY-MM-DD');
  const to = dayjs().endOf('month').format('YYYY-MM-DD');
  return { from, to, prevFrom: dayjs(from).subtract(1, 'month').startOf('month').format('YYYY-MM-DD'), prevTo: dayjs(from).subtract(1, 'month').endOf('month').format('YYYY-MM-DD') };
}

export interface SummaryInput {
  word: string;
  from: string;
  to: string;
  income: number;
  expense: number;
  surplus: number;
  momExpensePct: number | null;
  topExpense: Array<{ name: string; total: number }>;
  topIncome: Array<{ name: string; total: number }>;
  healthLabel: string;
  healthScore: number;
  dueSubs: number;
  anomalyCount: number;
  /** 支出较上一期上升的归因（分类级增量），供"为什么上升"解释 */
  attribution: string[];
}

/**
 * 归因（纯函数）：对比最近两期的分类金额，返回较上期增幅最大（上升）的来源 Top N。
 * 让"支出上升"这种结论有"因为 xx 增加了多少"的解释，而非只给环比数字。
 */
export function topIncrementAttribution(
  curr: Record<string, number>,
  prev: Record<string, number>,
  limit = 3
): Array<{ name: string; delta: number; total: number }> {
  const keys = new Set([...Object.keys(curr), ...Object.keys(prev)]);
  const out: Array<{ name: string; delta: number; total: number }> = [];
  for (const k of keys) {
    const c = curr[k] ?? 0;
    const p = prev[k] ?? 0;
    const delta = c - p;
    if (delta > 0) out.push({ name: k, delta, total: c });
  }
  return out.sort((a, b) => b.delta - a.delta).slice(0, limit);
}

const money = (v: number) => `¥${v.toFixed(2)}`;

/** 纯函数：把聚合数据拼成一份 markdown 周/月报（可单测）。 */
export function assembleReportText(s: SummaryInput): string {
  const lines: string[] = [];
  lines.push(`# ${s.word}（${s.from} ~ ${s.to}）`);
  lines.push('');
  lines.push(`- 收入：${money(s.income)}`);
  lines.push(`- 支出：${money(s.expense)}`);
  lines.push(`- 结余：${money(s.surplus)}${s.surplus < 0 ? '（入不敷出）' : ''}`);
  lines.push(`- 支出较上一期：${s.momExpensePct == null ? '——' : (s.momExpensePct > 0 ? '+' : '') + s.momExpensePct.toFixed(1) + '%'}`);
  lines.push(`- 财务健康：${s.healthScore} 分（${s.healthLabel}）`);
  if (s.topExpense.length) lines.push(`- 主要支出：${s.topExpense.map((c) => `${c.name} ${money(c.total)}`).join('、')}`);
  if (s.attribution.length) lines.push(`- 支出上升主要来自（较上一周期）：${s.attribution.join('；')}。`);
  if (s.topIncome.length) lines.push(`- 主要收入：${s.topIncome.map((c) => `${c.name} ${money(c.total)}`).join('、')}`);
  if (s.dueSubs) lines.push(`- 近期有 ${s.dueSubs} 项订阅/扣费将到期，请注意。`);
  if (s.anomalyCount) lines.push(`- 检测到 ${s.anomalyCount} 条异常/疑似风险交易，建议核查。`);
  return lines.join('\n') + '\n';
}

export interface ReportResult {
  title: string;
  range: string;
  text: string;
  source: 'local' | 'ai';
}

const REPORT_SYSTEM =
  '你是个人财务助手。下面给出某周期的"脱敏聚合财务数据"。请据此生成一份精炼的自然语言周报/月报，包含：① 本期收支结余概览；② 1-2 句总评；③ 2-3 条具体可执行的建议。保持简洁、口语化，只依据给定数据，不编造。';

export async function buildReport(period: ReportPeriod): Promise<ReportResult> {
  const word = period === 'week' ? '周报' : '月报';
  const r = buildPeriodRange(period);
  const [exp, inc, prevExp, ins, health, sub, anom] = await Promise.all([
    getCategoryDistribution('expense', r.from, r.to),
    getCategoryDistribution('income', r.from, r.to),
    getCategoryDistribution('expense', r.prevFrom, r.prevTo),
    getInsights(dayjs().format('YYYY-MM')),
    buildHealthReview(),
    buildSubscriptionReminders(),
    buildAnomalyReport(period === 'week' ? 1 : 3),
  ]);

  const income = inc.reduce((s, c) => s + c.total, 0);
  const expense = exp.reduce((s, c) => s + c.total, 0);
  const prevExpense = prevExp.reduce((s, c) => s + c.total, 0);
  const surplus = income - expense;
  const momExpensePct = prevExpense > 0 ? Math.round(((expense - prevExpense) / prevExpense) * 1000) / 10 : null;

  // 支出上升归因：对比本期与上期的分类金额增量，回答"为什么支出上升"
  const currByCat = Object.fromEntries(exp.map((c) => [c.name, c.total]));
  const prevByCat = Object.fromEntries(prevExp.map((c) => [c.name, c.total]));
  const attr = topIncrementAttribution(currByCat, prevByCat).map((a) => `${a.name} +${money(a.delta)}`);

  const summary: SummaryInput = {
    word,
    from: r.from,
    to: r.to,
    income,
    expense,
    surplus,
    momExpensePct,
    topExpense: [...exp].sort((a, b) => b.total - a.total).slice(0, 5).map((c) => ({ name: c.name, total: c.total })),
    topIncome: [...inc].sort((a, b) => b.total - a.total).slice(0, 3).map((c) => ({ name: c.name, total: c.total })),
    healthLabel: health.score.label,
    healthScore: health.score.score,
    dueSubs: sub.dueSoon.length,
    anomalyCount: anom.length,
    attribution: attr,
  };
  const local = assembleReportText(summary);

  const cfg = readAIConfig();
  if (cfg.enabled && cfg.allowDetail) {
    try {
      const facts =
        `时间：${r.from} ~ ${r.to}\n` +
        `收入 ${money(income)}，支出 ${money(expense)}，结余 ${money(surplus)}\n` +
        `较上期支出 ${momExpensePct == null ? '——' : (momExpensePct > 0 ? '+' : '') + momExpensePct.toFixed(1) + '%'}\n` +
        `支出TOP：${summary.topExpense.map((c) => `${sanitizeForClassification(c.name)} ${money(c.total)}`).join('、')}\n` +
        `健康分 ${health.score.score}（${health.score.label}）；${summary.dueSubs ? `${summary.dueSubs} 项订阅将到期；` : ''}${summary.anomalyCount ? `${summary.anomalyCount} 条异常待核查。` : '无异常。'}`;
      const reply = await chat([{ role: 'user', content: `${REPORT_SYSTEM}\n\n数据：\n${facts}` }]);
      if (reply && reply.trim()) return { title: word, range: `${r.from} ~ ${r.to}`, text: reply.trim(), source: 'ai' };
    } catch {
      /* AI 失败 → 用本地报告 */
    }
  }
  return { title: word, range: `${r.from} ~ ${r.to}`, text: local, source: 'local' };
}