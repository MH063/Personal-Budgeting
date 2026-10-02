import { getKV, setKV } from './kv';
import type { ImportRule, ImportRow, ImportTxType } from './import';

/**
 * 账单导入「资金流向判定规则」的持久化（用户可编辑）。
 * ---------------------------------------------------------------
 * 原则与商户归并规则一致：规则能解决的就不用 AI。
 *  - 用户规则 > 内置账单启发式（还款/退款/提现/收支方向）。
 *  - 规则仅存本机（settings 表，`kv.importRules`），无网络。
 *  - 命中即按其判定类型/账户/分类，可解释、可复现，避免每次导入都手工纠正同一类消费。
 *  - 「导入规则自动学习」：用户在导入预览/导入后核对里手动修正归类后，
 *    自动沉淀为规则（幂等合并、纯本地、可编辑/停用），下次同类流水免手工纠正。
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

// ==================== 导入规则自动学习 ====================
// 用户在导入预览 / 导入后核对里手动修正归类后，自动沉淀为资金流向规则（可编辑/停用）。
// 纯本地实现，不调用 AI；规则生成遵守「宁缺毋滥」：关键词过短、命中文案类通用词、
// 或无法定位到具体商户/资金流时一律不学，避免生成过宽规则误伤后续导入。

/**
 * 通用词黑名单：关键词命中任一（包含匹配）即视为「无法定位特定商户/资金流」，
 * 拒绝沉淀为规则。此类文案多半由内置识别分支（还款/退款/提现等）处理，或过于泛化。
 */
const GENERIC_RULE_KEYWORDS = [
  '转账', '转帐', '收款', '付款', '支付', '消费', '支出', '收入', '还款', '退款', '提现',
  '手续费', '服务费', '利息', '红包', '优惠', '订单', '订单号', '交易', '到账', '入账',
  '结余', '余额', '其他', '一般', '线下', '线上', '扫码', '刷卡', '未知', '未识别',
  '合计', '总计', '账单', '清零', '查账', '银行卡', '信用卡', '花呗', '白条', '微信', '支付宝', '零钱', 'pos',
] as const;

/**
 * 从单段文本中提取可作为规则关键词的商户主体。
 * 处理：去尾部括注（如「(个人)」「(1055)」）、截取首个分隔段（备注常拼接商品+订单信息）、
 * 去尾部数字与「订单/单号」流水标识；过短/纯符号/命中通用词返回 null。
 */
function extractRuleKeyword(text: string): string | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 去尾部括注：商户名后的门店/备注括注对匹配无增益（如「瑞幸咖啡(北京店)」）
  let base = t.replace(/[（(][^)）]*[)）]\s*$/, '').trim();
  // 截取首个分隔段：备注常是「商户名+订单信息」拼接，取第一个分隔符前的主体
  base = base.split(/[，,。.、;；—\-_|]/)[0].trim();
  // 去尾部流水标识与纯数字尾巴（订单号等对匹配无增益）
  base = base.replace(/\d+$/, '').trim();
  base = base.replace(/(订单号|订单|单号|编号|流水号)$/, '').trim();
  if (base.length < 2) return null;            // 过短无法定位
  if (/^[\d\s,.\-—、_，。]+$/.test(base)) return null; // 纯数字/符号
  const low = base.toLowerCase();
  for (const g of GENERIC_RULE_KEYWORDS) {
    if (g.length >= 2 && low.includes(g)) return null;
  }
  return base;
}

/**
 * 从导入行提取可作为规则关键词的文本：优先「收款方/商户」（最稳定），
 * 无或不合格时退回「备注/商品说明」；都提取不出返回 null。
 */
export function pickRuleKeyword(row: ImportRow): string | null {
  const candidates = [String(row.payee ?? '').trim(), String(row.note ?? '').trim()].filter(Boolean);
  for (const text of candidates) {
    const kw = extractRuleKeyword(text);
    if (kw) return kw;
  }
  return null;
}

/**
 * 判断一次「用户手动修正」是否值得沉淀为规则。
 * 类型/账户/转入账户/分类任一与解析原值不同，或把被跳过的中性行手动恢复为收支，即为有效修正。
 * @param opts.ignoreAccount 整批「归入账户」的批量覆盖不算逐商户修正，忽略账户差异，避免一次学出一大片。
 */
export function shouldLearnCorrection(
  orig: ImportRow,
  cur: ImportRow,
  opts: { ignoreAccount?: boolean } = {}
): boolean {
  if (orig._skippedReason && !cur._skippedReason) return true; // 手动恢复被规则跳过的行
  if (cur.type !== orig.type) return true;
  if (!opts.ignoreAccount && cur.account !== orig.account) return true;
  if (cur.toAccount !== orig.toAccount) return true;
  if (cur.category !== orig.category) return true;
  return false;
}

/** 一次可学习的修正：match 为规则关键词，其余为「用户实际改动过」的字段（沿用解析值的字段不写入规则）。 */
export interface LearnedRuleCandidate {
  /** 规则关键词（商户名/说明主体） */
  match: string;
  /** 修正后的交易类型 */
  type: ImportTxType;
  /** 修正后的账户名（仅用户改动时提供） */
  account?: string;
  /** 修正后的转入账户名（仅转账且用户改动时提供） */
  toAccount?: string;
  /** 修正后的分类名（仅用户改动时提供） */
  category?: string;
}

/**
 * 把一次修正合并进既有规则集（幂等、可复现）：
 * - 同关键词规则已存在且启用 → 就地更新其类型/账户/转入账户/分类（只覆盖本次改动的字段，保留用户其余配置）；
 * - 已停用的规则视为用户显式关闭 → 不更新、不复活（尊重用户选择，静默跳过）；
 * - 不存在 → 追加一条新规则；
 * - 修正后类型非转账时清掉陈旧转入账户，避免旧规则残留误导后续导入。
 * @returns 新规则集 + 是否真的发生变更（未变则原引用原样返回）。
 */
export function learnRuleFromCorrection(
  existing: ImportRule[],
  c: LearnedRuleCandidate
): { rules: ImportRule[]; changed: boolean } {
  const match = c.match.trim();
  if (!match) return { rules: existing, changed: false };
  const idx = existing.findIndex((r) => r && r.match === match);
  if (idx >= 0) {
    const cur = existing[idx];
    // 停用是用户显式选择，自动学习不覆盖、不复活
    if (cur.enabled === false) return { rules: existing, changed: false };
    const next: ImportRule = {
      ...cur,
      type: c.type,
      enabled: true,
      ...(c.account?.trim() ? { account: c.account.trim() } : {}),
      ...(c.toAccount?.trim() ? { toAccount: c.toAccount.trim() } : {}),
      ...(c.category?.trim() ? { category: c.category.trim() } : {}),
    };
    // 修正后非转账：转账语义不再成立，清掉陈旧的转入账户
    if (c.type !== 'transfer') next.toAccount = undefined;
    const same =
      cur.enabled === true && cur.type === next.type && (cur.account ?? undefined) === next.account &&
      (cur.toAccount ?? undefined) === next.toAccount && (cur.category ?? undefined) === next.category;
    if (same) return { rules: existing, changed: false };
    const rules = existing.slice();
    rules[idx] = next;
    return { rules, changed: true };
  }
  const fresh: ImportRule = {
    match,
    type: c.type,
    account: c.account?.trim() || undefined,
    toAccount: c.type === 'transfer' ? (c.toAccount?.trim() || undefined) : undefined,
    category: c.category?.trim() || undefined,
    enabled: true,
  };
  return { rules: [...existing, fresh], changed: true };
}