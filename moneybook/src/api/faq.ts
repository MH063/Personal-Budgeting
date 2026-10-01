import dayjs from 'dayjs';
import { readAIConfig } from '@/stores/useAIStore';
import { sanitizeForClassification } from '@/lib/sanitize';
import { chat, type ChatMessageInput } from './llm';
import { parseCriteriaLocal } from './aiSearch';
import { getCategoryDistribution } from './stats';
import { buildSubscriptionReminders } from './subscription';
import { buildAnomalyReport } from './anomaly';

/**
 * 聊天式财务问答（Financial Q&A）
 * ---------------------------------------------------------------
 * 用户用自然语言提问，如「上个月餐饮花了多少」「哪类支出增长最快」。
 * 做法：先把问题解析成结构化范围（复用 aiSearch 的分词/时间/类型），再在本地聚合真实数据，
 * 生成确定性答案（不回 AI 也有用）；若已启用 AI 且允许发送明细，则把"脱敏的聚合事实"交给
 * LLM 生成更自然的回答（仅上送聚合，不上送单笔明细），失败自动回退本地答案。
 */

export type FaqIntent = 'expense_total' | 'income_total' | 'top_growth' | 'top_cat' | 'generic';

const intentRe: Array<[RegExp, FaqIntent]> = [
  [/增长|增速|涨|升|哪类.*快|环比/, 'top_growth'],
  [/最多|大头|主要(花|支出|在)/, 'top_cat'],
  [/收入|赚|进账|入账|到账/, 'income_total'],
  [/支出|花|消费|花费|付/, 'expense_total'],
];

/** 解析问题意图（纯函数，便于单测） */
export function detectIntent(q: string): FaqIntent {
  for (const [re, intent] of intentRe) if (re.test(q)) return intent;
  return 'generic';
}

export interface FaqRange {
  from: string;
  to: string;
  /** 用于对比的上一等长窗口 */
  prevFrom: string;
  prevTo: string;
}

/** 由自然语言解析出当前/上一窗口的日期范围（纯函数）。默认当前月，上一窗口为上一月。 */
export function buildRanges(q: string): FaqRange {
  const c = parseCriteriaLocal(q, { categoryNames: [] });
  const curFrom = c.from ?? dayjs().startOf('month').format('YYYY-MM-DD');
  const curTo = c.to ?? dayjs().endOf('month').format('YYYY-MM-DD');
  const lenDays = dayjs(curTo).diff(dayjs(curFrom), 'day');
  const prevTo = dayjs(curFrom).subtract(1, 'day').format('YYYY-MM-DD');
  const prevFrom = dayjs(prevTo).subtract(lenDays, 'day').format('YYYY-MM-DD');
  return { from: curFrom, to: curTo, prevFrom, prevTo };
}

export interface CategoryMom {
  name: string;
  icon: string;
  current: number;
  prev: number;
  momPct: number;
}

/** 计算分类环比（纯函数，便于单测）：prev=0 且 current>0 视为 +100%；两者都 0 视为 null */
export function computeCategoryMom(cur: Array<{ name: string; icon: string; total: number }>, prev: Array<{ name: string; icon: string; total: number }>): CategoryMom[] {
  const prevMap = new Map(prev.map((p) => [p.name, p.total]));
  const curMap = new Map(cur.map((p) => [p.name, p.total]));
  const names = new Set([...curMap.keys(), ...prevMap.keys()]);
  const out: CategoryMom[] = [];
  for (const name of names) {
    const c = curMap.get(name) ?? 0;
    const p = prevMap.get(name) ?? 0;
    if (c === 0 && p === 0) continue;
    const momPct = p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : c > 0 ? 100 : -100;
    out.push({
      name,
      icon: cur.find((x) => x.name === name)?.icon ?? prev.find((x) => x.name === name)?.icon ?? '',
      current: c,
      prev: p,
      momPct,
    });
  }
  out.sort((a, b) => b.momPct - a.momPct || b.current - a.current);
  return out;
}

export interface FaqFacts {
  intent: FaqIntent;
  range: FaqRange;
  type: 'income' | 'expense';
  total: number;
  top: Array<{ name: string; icon: string; total: number }>;
  mom: CategoryMom[];
}

/** 依据意图在本地聚合真实数据（无网络）。type 依据意图决定。 */
export async function buildFacts(q: string): Promise<FaqFacts> {
  const intent = detectIntent(q);
  const type: 'income' | 'expense' = intent === 'income_total' ? 'income' : 'expense';
  const range = buildRanges(q);
  const cur = await getCategoryDistribution(type, range.from, range.to);
  const prev = await getCategoryDistribution(type, range.prevFrom, range.prevTo);
  const total = cur.reduce((s, c) => s + c.total, 0);
  const top = [...cur].sort((a, b) => b.total - a.total).slice(0, 5);
  const mom = computeCategoryMom(cur, prev);
  return { intent, range, type, total, top, mom };
}

const money = (v: number) => `¥${v.toFixed(2)}`;

/** 生成本地确定性的中文答案（可单测的核心文案）。 */
export function textAnswer(f: FaqFacts, q: string): string {
  const windowLabel = `${f.range.from} ~ ${f.range.to}`;
  if (f.intent === 'top_growth') {
    const growing = f.mom.find((m) => m.momPct > 0);
    if (!growing) return `${windowLabel}：各分类支出较上期变化不大，支出合计 ${money(f.total)}。`;
    return `${windowLabel}增长最快的分类是「${growing.name}」${money(growing.current)}，环比 ${growing.momPct > 100 ? '+' : ''}${growing.momPct}%（上期 ${money(growing.prev)}）。此期间${f.type === 'income' ? '收入' : '支出'}合计 ${money(f.total)}。`;
  }
  if (f.intent === 'top_cat') {
    const t = f.top[0];
    return t
      ? `${windowLabel}${f.type === 'income' ? '收入' : '支出'}最大的分类是「${t.name}」${money(t.total)}，TOP：${f.top.map((c) => `${c.name} ${money(c.total)}`).join('、')}。`
      : `${windowLabel}暂无${f.type === 'income' ? '收入' : '支出'}数据。`;
  }
  const label = f.type === 'income' ? '收入' : '支出';
  const topLine = f.top.length ? `其中 TOP：${f.top.map((c) => `${c.name} ${money(c.total)}`).join('、')}。` : '';
  return `${windowLabel}：${label}合计 ${money(f.total)}。${topLine}`;
}

const FAQ_SYSTEM =
  '你是个人财务助手。用户给出一个财务问题和两份脱敏数据：①当前问题对应的聚合事实；②系统数据概览。' +
  '请结合两者用简洁、口语化的简体中文回答；可基于概览做横向对比/趋势/提醒，但只依据给定事实，不编造任何数字。';

/** 组装一份"系统数据概览"（近 3 月，全脱敏聚合，供 AI 灵活运用整体数据）。 */
async function buildSystemOverview(): Promise<string> {
  const from = dayjs().subtract(3, 'month').startOf('month').format('YYYY-MM-DD');
  const to = dayjs().endOf('month').format('YYYY-MM-DD');
  const [exp, inc, sub, anom] = await Promise.all([
    getCategoryDistribution('expense', from, to),
    getCategoryDistribution('income', from, to),
    buildSubscriptionReminders(),
    buildAnomalyReport(3),
  ]);
  const expTotal = exp.reduce((s, c) => s + c.total, 0);
  const incTotal = inc.reduce((s, c) => s + c.total, 0);
  const topExp = [...exp].sort((a, b) => b.total - a.total).slice(0, 5)
    .map((c) => `${sanitizeForClassification(c.name)} ${c.total.toFixed(0)}`).join('、');
  return (
    `近3月总支出 ¥${expTotal.toFixed(0)}、总收入 ¥${incTotal.toFixed(0)}；` +
    `支出TOP：${topExp || '无'}；` +
    `订阅/固定扣费 ${sub.items.length} 项；异常/风险 ${anom.length} 条。`
  );
}

/**
 * 回答问题：先本地聚合并给出确定答案；只要已启用 AI，即强制把"脱敏聚合事实"交给 LLM 生成自然回答
 * （不再受「允许发送明细」开关限制，使 AI 能灵活运用系统数据），并携带此前对话(history)以支持连续多轮。
 * 任一步失败都回退到本地答案（功能不中断）。
 */
export async function answerFinancialQuestion(
  q: string,
  opts: { history?: ChatMessageInput[] } = {}
): Promise<{ answer: string; source: 'local' | 'ai' }> {
  const trimmed = (q ?? '').trim();
  if (!trimmed) return { answer: '请输入要咨询的财务问题，例如「上个月餐饮花了多少」。', source: 'local' };
  const facts = await buildFacts(trimmed);
  // 无数据时给出明确提示，避免输出误导性的「合计 ¥0.00」明细
  if (facts.top.length === 0 && facts.total <= 0) {
    const dirLabel = facts.type === 'income' ? '收入' : '支出';
    return { answer: `${windowLabel(facts)}暂无「${dirLabel}」相关记录。请先记账或导入数据后再问。`, source: 'local' };
  }
  const local = textAnswer(facts, trimmed);

  const cfg = readAIConfig();
  if (cfg.enabled) {
    try {
      // 仅上送脱敏聚合事实（分类 + 金额），不上送单笔明细；历史消息亦先脱敏再上送
      const ctx =
        `${windowLabel(facts)}\n${facts.type === 'income' ? '收入' : '支出'}合计 ${money(facts.total)}\n` +
        `分类金额：${facts.top.map((c) => `${sanitizeForClassification(c.name)} ${money(c.total)}`).join('、')}\n` +
        `环比：${facts.mom.slice(0, 5).map((m) => `${sanitizeForClassification(m.name)} ${m.momPct > 0 ? '+' : ''}${m.momPct}%`).join('、')}`
          .replace(/\n+$/, '');
      // 附一份"系统数据概览"，让 AI 能结合整体灵活回答（仍全部为脱敏聚合，不含明细）
      const overview = await buildSystemOverview();
      const user = `问题：${trimmed}\n【当前问题数据】（脱敏聚合）：\n${ctx}\n【系统数据概览】（脱敏）：\n${overview}`;
      // 组装多轮消息：系统 → 历史(脱敏) → 当前问题+新事实
      const hist = (opts.history ?? []).map((h) => ({
        role: h.role,
        content: sanitizeForClassification(h.content),
      })) as ChatMessageInput[];
      const messages: ChatMessageInput[] = [{ role: 'system', content: FAQ_SYSTEM }, ...hist, { role: 'user', content: user }];
      const reply = await chat(messages);
      if (reply && reply.trim()) return { answer: reply.trim(), source: 'ai' };
    } catch {
      /* AI 失败 → 回退本地答案 */
    }
  }
  return { answer: local, source: 'local' };
}

function windowLabel(f: FaqFacts): string {
  return `时间：${f.range.from} ~ ${f.range.to}`;
}