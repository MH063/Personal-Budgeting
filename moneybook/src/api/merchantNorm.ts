import { getKV, setKV } from './kv';

/**
 * 商户标准化 + 用户规则优先级引擎（AI + 规则混合的可解释第一层）
 * ---------------------------------------------------------------
 * 原则：规则能解决的就不用 AI。
 *  - 用户自定义规则 > 内置同义别名 > 原文（学习模型/AI 只在规则未命中时兜底）。
 *  - 命中规则时返回"依据"，供界面解释"为什么这样归类/归并"，可一键收到反馈。
 *  - 规则仅存本机（settings 表，kv.merchantRules），无网络。
 */
export const RULES_KV_KEY = 'kv.merchantRules';

export interface UserRule {
  /** merchant_renamed：把命中的商户/收款方归并到 to；categorize：把命中文本归到某分类 */
  kind: 'merchant_renamed' | 'categorize';
  /** 匹配词（精确或包含），如 "麦当劳" / "星巴克" */
  match: string;
  /** merchant_renamed 的目标规范名 或 categorize 的目标分类名 */
  to: string;
  enabled: boolean;
}

/** 内置同义别名：常见多写法归并为同一规范商户（演示 + 默认覆盖，用户规则优先于它） */
export const BUILTIN_MERCHANT_ALIASES: Record<string, string[]> = {
  麦当劳: ['金拱门', "McDonald's", '麦当劳餐厅'],
  肯德基: ['KFC', '肯德基宅急送'],
  星巴克: ['Starbucks', '星巴克咖啡'],
  瑞幸: ['Luckin', '瑞幸咖啡'],
  美团: ['美团外卖', '美团到店', '美团优选'],
  饿了么: ['饿了么外卖', 'Ele.me'],
  滴滴: ['滴滴出行', '滴滴打车'],
  携程: ['携程旅行', 'Ctrip'],
};

/** 内置规则校验：kind 合法、match/to 非空；解析失败返回 []（不抛错）。 */
export function parseUserRules(raw: unknown): UserRule[] {
  if (!Array.isArray(raw)) return [];
  const out: UserRule[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const kind = r.kind === 'categorize' ? 'categorize' : r.kind === 'merchant_renamed' ? 'merchant_renamed' : null;
    const match = String(r.match ?? '').trim();
    const to = String(r.to ?? '').trim();
    if (!kind || !match || !to) continue;
    out.push({ kind, match, to, enabled: r.enabled !== false });
  }
  return out;
}

export interface NormContext {
  rules?: UserRule[];
}

/**
 * 读取用户规则（同步，来自启动时 hydrateKV 缓存的内存；库中为 JSON 字符串）。
 * 历史缺陷（防回归）：曾直接 `parseUserRules(getKV(...))`——getKV 返回的是 JSON 字符串，
 * 而 parseUserRules 只接受数组，导致读回永远为空数组（界面「添加后列表不出现、统计恒为 0」）。
 * 与 importRules.ts 的 loadImportRules 保持一致：先取出原始字符串再 JSON.parse。
 */
export function loadUserRules(): UserRule[] {
  try {
    const raw = getKV(RULES_KV_KEY);
    return raw ? parseUserRules(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** 持久化用户规则 */
export function saveUserRules(rules: UserRule[]): void {
  const valid = parseUserRules(rules);
  setKV(RULES_KV_KEY, JSON.stringify(valid));
}

/** 归一商户：先应用用户 merchant_renamed 规则，再内置同义别名；返回规范名与依据。 */
export function normalizeMerchant(raw: string, ctx: NormContext = {}): { name: string; via: string } {
  const name = String(raw ?? '').trim();
  if (!name) return { name, via: '无' };
  // 1) 用户规则（merchant_renamed 且启用）
  for (const r of (ctx.rules ?? []) as UserRule[]) {
    if (r.kind === 'merchant_renamed' && r.enabled && name.includes(r.match)) {
      return { name: r.to, via: `自定义规则「${r.match}」` };
    }
  }
  // 2) 内置同义别名
  for (const [canonical, variants] of Object.entries(BUILTIN_MERCHANT_ALIASES)) {
    if (variants.some((v) => name.toLowerCase().includes(v.toLowerCase()))) {
      return { name: canonical, via: '内置同义' };
    }
  }
  return { name, via: '原文' };
}

/** 分类规则判定：用户 categorize 规则里超query 命中者；交给 AI/默认前先用它，保证"用户规则优先"。 */
export function categorizeByRule(text: string, ctx: NormContext = {}): { category: string; via: string } | null {
  const t = String(text ?? '');
  for (const r of (ctx.rules ?? []) as UserRule[]) {
    if (r.kind === 'categorize' && r.enabled && t.includes(r.match)) {
      return { category: r.to, via: `规则「${r.match}」` };
    }
  }
  return null;
}

/** 查找某规则并返回其索引（用于 UI 编辑/删除），找不到返回 -1。 */
export function findRuleIndex(rules: UserRule[], id: number): number {
  return id >= 0 && id < rules.length ? id : -1;
}