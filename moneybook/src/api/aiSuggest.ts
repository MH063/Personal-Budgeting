import { readAIConfig } from '@/stores/useAIStore';
import { sanitizeForClassification } from '@/lib/sanitize';
import { chat } from './llm';
import { categorizeByRule, normalizeMerchant, loadUserRules } from './merchantNorm';

/**
 * AI 智能分类 / 账户推荐
 * ---------------------------------------------------------------
 * 目标：用户在记账或导入时，依据备注/收款方文本，自动推荐「分类 + 账户」，改善录入体验。
 *
 * 隐私边界（硬约束）：
 * 1. 仅当「已启用 AI 且开启了允许发送明细」时才调用云端 LLM，否则只用本地规则，零数据外泄。
 * 2. 即使上云，发给模型的文本也必须先经 sanitizeForClassification 脱敏（屏蔽手机/证件/卡号/邮箱/微信号等 PII）。
 * 3. 云端失败或未配置时自动回退到本地规则，保证功能始终可用。
 */

/** 本地关键词→默认分类规则（兜底，无需网络）。关键词见「规则列表」用于第一层匹配。 */
export interface LocalCategoryRule { keywords: string[]; category: string; }

export const LOCAL_CATEGORY_RULES: LocalCategoryRule[] = [
  { keywords: ['早餐', '午餐', '晚餐', '午饭', '晚饭', '早饭', '吃饭', '餐', '菜', '食', '奶茶', '咖啡', '饮品', '饮料', '外卖', '点餐', '小吃', '零食', '面'], category: '餐饮' },
  { keywords: ['地铁', '公交', '打车', '滴滴', '出租车', '加油', '停车', '高铁', '机票', '火车', '交通', '燃油', '高速', '充电'], category: '交通' },
  { keywords: ['超市', '购物', '买', '日用', '网购', '淘宝', '京东', '拼多多', '商场', '商店', '便利店', '百货'], category: '购物' },
  { keywords: ['房租', '租房', '物业', '水费', '电费', '燃气', '煤气', '宽带', '话费', '缴费', '话费充值', '水电'], category: '居住' },
  { keywords: ['电影', '娱乐', '游戏', 'KTV', '唱歌', '旅游', '门票', '演出', '视频会员', '会员'], category: '娱乐' },
  { keywords: ['医院', '药', '诊疗', '挂号', '诊所', '体检', '牙'], category: '医疗' },
  { keywords: ['工资', '奖金', '薪资', '报酬', '版税', '稿费', '分红', '利息', '退款', '报销'], category: '工资/收入' },
  { keywords: ['礼金', '红包', '礼物', '礼品', '随礼'], category: '人情' },
];

/** 本地第一层分类：命中任意关键词则返回该分类；否则 null。 */
export function classifyLocal(text: string): string | null {
  const t = String(text ?? '');
  for (const rule of LOCAL_CATEGORY_RULES) {
    if (rule.keywords.some((k) => t.includes(k))) return rule.category;
  }
  return null;
}

/** 本地账户匹配：账户名（归一化后）出现在文本中则命中。按长度降序优先更具体的账户名。 */
export function matchAccountLocal(text: string, accounts: Array<{ id: number; name: string }>): { id: number; name: string } | null {
  const t = String(text ?? '');
  const sorted = [...accounts].sort((a, b) => b.name.length - a.name.length);
  // 去空格/括号归一后做包含匹配，减少全角/半角差异
  const norm = (s: string) => s.replace(/[\s（）()]/g, '');
  const tn = norm(t);
  for (const a of sorted) {
    const an = norm(a.name);
    if (an && tn.includes(an)) return a;
  }
  return null;
}

/** 置信度分级（纯函数）：≥0.8 高、≥0.6 中、<0.6 低。低置信度应转人工核对而非硬推。 */
export function classifyConfidence(score: number): 'high' | 'medium' | 'low' {
  const s = Number(score);
  if (s >= 0.8) return 'high';
  if (s >= 0.6) return 'medium';
  return 'low';
}

/** 取推荐里置信度过低的项（纯函数）：返回 score < threshold 的候选名，供 UI 提示"待人工核对"。 */
export function lowConfidenceNames(result: { categories: CategoryCandidate[] }, threshold = 0.6): string[] {
  return result.categories.filter((c) => Number(c.score) < threshold).map((c) => c.name);
}

/** 分类候选 */
export interface CategoryCandidate { name: string; score: number; }
export interface SuggestResult {
  /** 认到的分类（可能为空） */
  categories: CategoryCandidate[];
  /** 认到的账户（可能为空） */
  account: { id: number; name: string; score: number } | null;
  /** 本次来源：'ai' 上云 / 'local' 仅本地 */
  source: 'ai' | 'local';
}

const CLASSIFY_SYSTEM =
  '你是一位记账分类助手。仅依据给定的消费描述文本，选出最可能对应的分类与账户。\n' +
  '只输出一个 JSON 数组，不要 markdown 围栏，不要任何解释：\n' +
  '[{"category":"分类名","score":0.9,"account":"账户名或null","account_score":0.9}]\n' +
  '要求：\n' +
  '1. category 只能来自下方「可选分类」清单，绝不可编造；如无把握可不给 account。\n' +
  '2. account 只能来自「可选账户」清单或为 null；不做猜测。\n' +
  '3. score / account_score 为 0~1 的可信度。\n' +
  '4. 只依据文本推断，不编造清单之外内容。';

interface AiRaw { category?: unknown; score?: unknown; account?: unknown; account_score?: unknown; }

/** 稳健解析 AI 返回的分类建议：剥离围栏、取首个数组，逐项过滤，上限 3 条。异常返回空数组。 */
export function parseAiSuggestion(raw: string): AiRaw[] {
  try {
    let t = String(raw ?? '').trim();
    t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return [];
    const parsed: unknown = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is AiRaw => !!x && typeof x === 'object').slice(0, 3);
  } catch {
    return [];
  }
}

/** 在开关与脱敏双重约束下，从一条消费文本给出分类与账户推荐。
 *  - enabled && allowDetail 时上云（文本先脱敏）；否则/失败 → 本地规则兜底。 */
export async function suggestForText(
  text: string,
  opts: { categories: string[]; accounts: Array<{ id: number; name: string }> },
  gate?: { enabled?: boolean; allowDetail?: boolean }
): Promise<SuggestResult> {
  const raw = (text ?? '').trim();
  if (!raw) return { categories: [], account: null, source: 'local' };

  // ① 用户自定义规则优先（规则 > 模型 > 默认）：命中分类则直接采用，不交给 AI/默认
  const userRules = loadUserRules();
  const ruleCat = categorizeByRule(raw, { rules: userRules });
  if (ruleCat) {
    const acc = matchAccountLocal(raw, opts.accounts);
    return {
      categories: [{ name: ruleCat.category, score: 1 }],
      account: acc ? { ...acc, score: 0.9 } : null,
      source: 'local',
    };
  }

  const config = readAIConfig();
  const canCloud = (gate?.enabled ?? config.enabled) && (gate?.allowDetail ?? config.allowDetail) && opts.categories.length > 0;

  if (canCloud) {
    try {
      const masked = sanitizeForClassification(raw); // 上云前强制脱敏
      const catList = [...new Set(opts.categories)].slice(0, 30).map((c, i) => `${i + 1}. ${c}`).join('\n');
      const accList = opts.accounts.map((a) => a.name).slice(0, 30).join('、') || '（无）';
      const user = `可选分类：\n${catList}\n可选账户：${accList}\n消费描述（已脱敏）：${masked}`;
      const reply = await chat([{ role: 'user', content: `${CLASSIFY_SYSTEM}\n\n${user}` }]);
      const parsed = parseAiSuggestion(reply);
      const categories: CategoryCandidate[] = [];
      for (const p of parsed) {
        const name = String(p.category ?? '').trim();
        if (!name || !opts.categories.includes(name)) continue;
        const score = Math.max(0, Math.min(1, Number(p.score) || 0.5));
        if (!categories.some((c) => c.name === name)) categories.push({ name, score });
      }
      const aiAccName = String(parsed[0]?.account ?? '').trim();
      const account = aiAccName ? (opts.accounts.find((a) => a.name === aiAccName) ?? null) : matchAccountLocal(raw, opts.accounts);
      if (categories.length) {
        return {
          categories: categories.slice(0, 3),
          account: account ? { ...account, score: Math.max(0, Math.min(1, Number(parsed[0]?.account_score) || 0.6)) } : null,
          source: 'ai',
        };
      }
    } catch {
      // 云端失败 → 回退本地规则，功能不中断
    }
  }

  // 本地兜底
  const cat = classifyLocal(raw);
  const acc = matchAccountLocal(raw, opts.accounts);
  return {
    categories: cat ? [{ name: cat, score: 0.8 }] : [],
    account: acc ? { ...acc, score: 0.9 } : null,
    source: 'local',
  };
}