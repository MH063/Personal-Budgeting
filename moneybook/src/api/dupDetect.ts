import dayjs from 'dayjs';
import { select } from './db';
import { chat } from './llm';
import { sanitizeForClassification } from '@/lib/sanitize';
import { readAIConfig } from '@/stores/useAIStore';
import { normalizeMerchant } from './merchantNorm';
import { currentLedgerId } from '@/lib/ledger';

/**
 * AI 异常 / 重复检测（疑似重复记账）
 * ---------------------------------------------------------------
 * 背景：确定性重复靠「订单号唯一」与导入指纹，识别不了「同一商户、金额相近/一致、
 *       但订单号不同（漏填/改号/分单）」的重复消费——这正是人工最容易看漏的重复记账来源。
 * 方案（纯本地规则 + 可选 AI 裁决）：
 *  - 本地先筛出「同商户(归一化)+金额一致/相近+短窗口期内」的候选对，确定性、可单测；
 *  - 默认给出本地启发式判定；用户按需点「AI 判定」：启用 AI 且允许明细时上云裁决
 *    『重复 vs 正常两笔』，未启用/失败时回退本地判定，功能始终可用。
 * 隐私边界：默认不上送任何明细；仅当用户主动触发 AI 判定且开启了「允许发送明细」时，
 * 文本才经 sanitizeForClassification 脱敏后上送（与 aiSuggest 口径一致）。
 */

/** 参与检测的一笔支出明细 */
export interface DupEntry {
  id: number;
  payee: string;
  note?: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
  orderNo?: string;
  merchantOrderNo?: string;
}

/** 一对疑似重复的候选（确定性筛出，未含判定） */
export interface DupPair {
  /** 行内唯一键（两笔 id 升序拼接），供前端去重/定位 */
  key: string;
  a: DupEntry;
  b: DupEntry;
  /** 两笔金额是否完全一致（±0.005 容差，兼容浮点存储） */
  sameAmount: boolean;
  /** 订单号不同（含「一笔有订单号一笔缺省」）→ 正是订单去重覆盖不到的盲区，加重疑似 */
  orderDiff: boolean;
}

/** 带判定的结果：dup=疑似重复记账，ok=正常两笔独立消费，uncertain=无法下结论待核查 */
export type DupVerdict = 'dup' | 'ok' | 'uncertain';

export interface DupSuspect extends DupPair {
  verdict: DupVerdict;
  /** 可靠度 0~1（启发式估算，非准确率；AI 判定后为模型置信） */
  reliability: number;
  reason: string;
  /** 判定来源：local 本地启发式 / ai 云端模型 */
  source: 'local' | 'ai';
}

const DEFAULT_WINDOW_DAYS = 3;
const DEFAULT_AMOUNT_RATIO = 0.05;
const MAX_CANDIDATES = 50;

/**
 * 确定性筛选「疑似重复」候选对（纯函数，可单测）：
 *  - 同一商户（normalizeMerchant 归一化，别名/括注视为同一商户）内两两比较；
 *  - 日期窗口期内（默认 3 天），金额相近（差 / 大值 ≤ 5%）；
 *  - 两笔订单号一致 → 已由「订单号去重」覆盖，跳过；
 *  - 金额为空/0 的无效行不参与。
 */
export function detectDuplicateCandidates(
  entries: DupEntry[],
  opts: { windowDays?: number; amountRatio?: number; max?: number } = {}
): DupPair[] {
  const win = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const ratio = opts.amountRatio ?? DEFAULT_AMOUNT_RATIO;
  const max = opts.max ?? MAX_CANDIDATES;
  const out: DupPair[] = [];
  if (!entries.length) return out;

  // 按归一化商户分组（与商户归并口径一致）
  const byMerchant = new Map<string, DupEntry[]>();
  for (const e of entries) {
    if (!e.payee) continue;
    const name = normalizeMerchant(e.payee).name;
    if (!name) continue;
    const arr = byMerchant.get(name) ?? [];
    arr.push(e);
    byMerchant.set(name, arr);
  }

  for (const [, arr] of byMerchant) {
    const sorted = [...arr].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        // 按日期升序：超出窗口的后续对必然更远，直接剪枝
        if (dayjs(b.date).diff(dayjs(a.date), 'day') > win) break;
        const hi = Math.max(a.amount, b.amount);
        if (!(hi > 0)) continue;
        if (Math.abs(a.amount - b.amount) / hi > ratio) continue;
        // 订单号一致 → 已被确定性「订单号去重」覆盖，不属于本特征要捕捉的盲区
        const ao = (a.orderNo ?? '').trim();
        const bo = (b.orderNo ?? '').trim();
        if (ao && bo && ao === bo) continue;
        const sameAmount = Math.abs(a.amount - b.amount) <= 0.005;
        out.push({
          key: `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`,
          a,
          b,
          sameAmount,
          orderDiff: ao !== bo,
        });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** 本地启发式判定（纯函数）：同金额+订单号不同最可疑，其次同金额，金额相近则待核查。 */
export function toLocalSuspect(p: DupPair): DupSuspect {
  if (p.sameAmount && p.orderDiff) {
    return { ...p, verdict: 'dup', reliability: 0.75, reason: '同商户、同金额、订单号不同，短时出现两次，疑似重复记账', source: 'local' };
  }
  if (p.sameAmount) {
    return { ...p, verdict: 'dup', reliability: 0.6, reason: '同商户、同金额短时出现两次，疑似重复记账', source: 'local' };
  }
  return { ...p, verdict: 'uncertain', reliability: 0.5, reason: '同商户、金额相近短时出现两次，建议核对是否重复', source: 'local' };
}

/** 取近 months 个月支出明细（含导入数据）参与检测 */
export async function fetchExpensesForDup(months = 3): Promise<DupEntry[]> {
  const start = dayjs().subtract(months - 1, 'month').startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  return select<DupEntry>(
    `SELECT id, payee, note, amount, date, order_no AS "orderNo", merchant_order_no AS "merchantOrderNo"
     FROM transactions WHERE type='expense' AND date BETWEEN $1 AND $2 AND ledger_id = $3 ORDER BY date`,
    [start, end, currentLedgerId()]
  );
}

/** 汇总疑似重复报告（本地判定，不消耗 AI） */
export async function buildDupReport(months = 3): Promise<DupSuspect[]> {
  return detectDuplicateCandidates(await fetchExpensesForDup(months)).map(toLocalSuspect);
}

// ---------------------------------------------------------------------------
// AI 判定（可选上云）
// ---------------------------------------------------------------------------

const DUP_VERIFY_SYSTEM =
  '你是一位账单核对助手。仅依据给定的每一对待核对消费记录，判断它们是「同一笔消费被重复记账/重复扣费」还是「两笔正常的独立消费」。\n' +
  '只输出一个 JSON 数组，不要 markdown 围栏，不要任何解释：\n' +
  '[{"pair":0,"verdict":"dup","reason":"简短原因"}]\n' +
  'verdict 只能取 dup（疑似重复）或 ok（正常两笔独立消费）。\n' +
  '要求：商户相同、金额完全一致或极其相近、日期很近、订单号却不同 → 倾向 dup；金额/时间/备注明显是两笔独立消费 → 倾向 ok。';

export interface DupVerdictRaw { pair?: unknown; verdict?: unknown; reason?: unknown; }

/** 稳健解析 AI 返回的判定数组：剥离围栏、取首个数组，逐项过滤。异常返回空数组。 */
export function parseDupVerdicts(raw: string): DupVerdictRaw[] {
  try {
    let t = String(raw ?? '').trim();
    t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return [];
    const parsed: unknown = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is DupVerdictRaw => !!x && typeof x === 'object');
  } catch {
    return [];
  }
}

/**
 * 对候选对做 AI 判定：启用 AI 且允许明细时上云（文本先脱敏），否则/失败回退本地判定。
 * 返回与入参同序的判定结果；云端仅覆盖其显式给出的对（其余保留本地判定）。
 */
export async function aiVerifyDuplicates(
  pairs: DupPair[],
  gate?: { enabled?: boolean; allowDetail?: boolean }
): Promise<DupSuspect[]> {
  const locals = pairs.map(toLocalSuspect);
  const config = readAIConfig();
  const canCloud = (gate?.enabled ?? config.enabled) && (gate?.allowDetail ?? config.allowDetail) && pairs.length > 0;
  if (!canCloud) return locals;
  try {
    const list = pairs.map((p, i) => ({
      i,
      payee: p.a.payee,
      a: `${p.a.date} ¥${p.a.amount.toFixed(2)} 订单号:${p.a.orderNo ?? '无'}`,
      b: `${p.b.date} ¥${p.b.amount.toFixed(2)} 订单号:${p.b.orderNo ?? '无'}`,
    }));
    // 上云前强制脱敏（屏蔽手机/证件/卡号/邮箱等 PII），与 aiSuggest 口径一致
    const masked = sanitizeForClassification(JSON.stringify(list));
    const reply = await chat([{ role: 'user', content: `${DUP_VERIFY_SYSTEM}\n\n待核对记录：\n${masked}` }]);
    const parsed = parseDupVerdicts(reply);
    const next = locals.slice();
    for (const r of parsed) {
      const i = Number(r.pair);
      if (!Number.isInteger(i) || i < 0 || i >= next.length) continue;
      const v = String(r.verdict ?? '').trim();
      const why = String(r.reason ?? '').trim();
      if (v === 'dup') {
        next[i] = { ...next[i], verdict: 'dup', reliability: 0.9, source: 'ai', reason: `AI 判定疑似重复：${why || '同商户同金额近时出现'}` };
      } else if (v === 'ok') {
        next[i] = { ...next[i], verdict: 'ok', reliability: 0.85, source: 'ai', reason: `AI 判定为正常两笔：${why || '两笔独立消费'}` };
      }
    }
    return next;
  } catch {
    return locals; // 云端失败 → 回退本地判定，功能不中断
  }
}
