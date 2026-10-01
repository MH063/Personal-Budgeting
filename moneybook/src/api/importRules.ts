import { getKV, setKV } from './kv';
import type { ImportRule } from './import';

/**
 * 账单导入「资金流向判定规则」的持久化（用户可编辑）。
 * ---------------------------------------------------------------
 * 原则与商户归并规则一致：规则能解决的就不用 AI。
 *  - 用户规则 > 内置账单启发式（还款/退款/提现/收支方向）。
 *  - 规则仅存本机（settings 表，`kv.importRules`），无网络。
 *  - 命中即按其判定类型/账户/分类，可解释、可复现，避免每次导入都手工纠正同一类消费。
 */
export const IMPORT_RULES_KV_KEY = 'kv.importRules';

/** 规则允许的目标类型（与导入可产生的交易类型一致） */
const RULE_TYPES: ImportRule['type'][] = ['income', 'expense', 'transfer', 'repay_in'];

/** 校验并归一化用户规则：丢弃缺 match/非法类型项，不抛错（解析失败返回 []）。 */
export function parseImportRules(raw: unknown): ImportRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportRule[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const match = String(r.match ?? '').trim();
    if (!match) continue;
    const t = String(r.type ?? '') as ImportRule['type'];
    const type = RULE_TYPES.includes(t) ? t : 'expense';
    out.push({
      match,
      type,
      account: String(r.account ?? '').trim() || undefined,
      toAccount: String(r.toAccount ?? '').trim() || undefined,
      category: String(r.category ?? '').trim() || undefined,
      enabled: r.enabled !== false,
    });
  }
  return out;
}

/** 读取用户规则（同步，来自启动时 hydrateKV 载入的内存缓存；库中为 JSON 字符串）。 */
export function loadImportRules(): ImportRule[] {
  try {
    const raw = getKV(IMPORT_RULES_KV_KEY);
    return raw ? parseImportRules(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** 持久化用户规则（写 settings 表 `kv.importRules`）。 */
export function saveImportRules(rules: ImportRule[]): void {
  void setKV(IMPORT_RULES_KV_KEY, JSON.stringify(parseImportRules(rules)));
}