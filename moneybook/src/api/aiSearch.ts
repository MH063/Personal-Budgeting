import dayjs from 'dayjs';
import { readAIConfig } from '@/stores/useAIStore';
import { sanitizeForClassification } from '@/lib/sanitize';
import { chat } from './llm';

/**
 * AI 语义搜索交易
 * ---------------------------------------------------------------
 * 目标：支持自然语言找流水，如「上个月咖啡花了多少」「本周超过500的支出」。
 * 思路：先把自然语言解析成结构化过滤条件（时间/类型/分类/金额/关键词），
 *       再完全本地查询，因此只发"你的查询文本"给 LLM（可选），绝不上传交易数据。
 * 隐私：AI 只在「已启用」时用来解析查询（查询文本先经 maskSensitive 脱敏），
 *       实际命中结果在本地数据库查询，不发送任何用户流水。未配置 AI 时纯本地解析。
 */

/** 结构化的交易检索条件 */
export interface SemanticCriteria {
  type?: 'income' | 'expense' | 'transfer' | 'lend' | 'borrow';
  from?: string;
  to?: string;
  search?: string;
  categoryName?: string;
  minAmount?: number;
  maxAmount?: number;
  /** 给用户的解析说明（提示用了哪些词） */
  label: string;
}

const FILLER = ['我', '的', '了', '一共', '合计', '花费', '花掉', '花', '付', '笔', '交易', '流水', '记录', '看看', '查', '找', '有哪些', '给我', '多少', '多少钱'];

/** 时间为今天区间 */
function todayRange(): [string, string] {
  const t = dayjs().format('YYYY-MM-DD');
  return [t, t];
}

/** 解析自然语言 → 结构化查询条件（纯本地，无网络）。返回 null 表示几乎没识别到任何信息。 */
export function parseCriteriaLocal(nl: string, opts: { categoryNames: string[] }): SemanticCriteria {
  const t = String(nl ?? '').trim();
  const c: SemanticCriteria = { label: '按当前输入筛选' };

  // —— 时间短语——
  if (/(本月|这个月)/.test(t)) { c.from = dayjs().startOf('month').format('YYYY-MM-DD'); c.to = dayjs().endOf('month').format('YYYY-MM-DD'); }
  else if (/(?:上个月|上月)/.test(t)) { c.from = dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'); c.to = dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD'); }
  else if (/(本周|这周)/.test(t)) { c.from = dayjs().startOf('week').format('YYYY-MM-DD'); c.to = dayjs().endOf('week').format('YYYY-MM-DD'); }
  else if (/(今天|今日)/.test(t)) { [c.from, c.to] = todayRange(); }
  else if (/昨天|昨日/.test(t)) { c.from = dayjs().subtract(1, 'day').format('YYYY-MM-DD'); c.to = c.from; }
  else if (/今年/.test(t)) { c.from = dayjs().startOf('year').format('YYYY-MM-DD'); c.to = dayjs().endOf('year').format('YYYY-MM-DD'); }
  else if (/去年/.test(t)) { c.from = dayjs().subtract(1, 'year').startOf('year').format('YYYY-MM-DD'); c.to = dayjs().subtract(1, 'year').endOf('year').format('YYYY-MM-DD'); }

  // —— 类型 ——
  if (/支出|消费|花钱|花了|付款|买了/.test(t)) c.type = 'expense';
  else if (/收入|入账|进账|进款|工资/.test(t)) c.type = 'income';
  else if (/转账|转入|转出/.test(t)) c.type = 'transfer';

  // —— 分类（取命中最长的分类名）——
  const sortedCats = [...new Set(opts.categoryNames)].sort((a, b) => b.length - a.length);
  for (const name of sortedCats) {
    if (name && t.includes(name)) { c.categoryName = name; break; }
  }

  // —— 金额区间 ——
  const minM = t.match(/(?:大于|超过|以上|至少)\s*([\d.]+)/);
  const maxM = t.match(/(?:低于|小于|以内|以下|不超过|少于)\s*([\d.]+)/);
  if (minM) c.minAmount = Number(minM[1]);
  if (maxM) c.maxAmount = Number(maxM[1]);

  // —— 关键词：剔除已识别的分类/时间/类型/金额与填充词 ——
  let kw = t;
  if (c.categoryName) kw = kw.split(c.categoryName).join(' ');
  if (c.type) for (const w of ['支出', '消费', '花了', '付款', '买了', '收入', '入账', '进账', '工资', '转账', '转入', '转出', '花钱']) kw = kw.replace(w, ' ');
  for (const w of ['上月', '上个月', '本月', '这个月', '本周', '这周', '今天', '今日', '昨天', '昨日', '今年', '去年', '大于', '超过', '以上', '至少', '低于', '小于', '以内', '以下', '不超过', '少于']) kw = kw.replace(w, ' ');
  for (const w of FILLER) kw = kw.split(w).join(' ');
  kw = kw.replace(/\d+(\.\d+)?/g, ' ').replace(/[\s，。、；,.、]+/g, ' ').trim();
  if (kw) c.search = kw;
  else delete c.search;

  const hasSignal = c.type || c.from || c.categoryName || c.search || c.minAmount !== undefined || c.maxAmount !== undefined;
  return hasSignal ? c : { ...c, label: '未能解析出有效条件' };
}

/** 稳健解析 AI 返回的检索条件 JSON；异常返回 null */
export function parseAiCriteria(raw: string): Partial<SemanticCriteria> | null {
  try {
    let t = String(raw ?? '').trim();
    t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    const o = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
    const out: Partial<SemanticCriteria> = {};
    if (['income', 'expense', 'transfer'].includes(String(o.type)) && !['undefined', 'null', ''].includes(String(o.type))) out.type = o.type as SemanticCriteria['type'];
    if (typeof o.from === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.from)) out.from = o.from.slice(0, 10);
    if (typeof o.to === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.to)) out.to = o.to.slice(0, 10);
    if (typeof o.search === 'string' && o.search) out.search = String(o.search);
    if (typeof o.categoryName === 'string' && o.categoryName && o.categoryName !== 'null') out.categoryName = String(o.categoryName);
    if (Number.isFinite(Number(o.minAmount))) out.minAmount = Number(o.minAmount);
    if (Number.isFinite(Number(o.maxAmount))) out.maxAmount = Number(o.maxAmount);
    return (out.search || out.categoryName || out.from || out.type || out.minAmount !== undefined || out.maxAmount !== undefined) ? out : null;
  } catch {
    return null;
  }
}

const SEARCH_SYSTEM =
  '你是交易检索条件解析器。把用户的自然语言查询，转成一个 JSON 对象：\n' +
  '{"type":"expense|income|transfer|null","from":"YYYY-MM-DD|null","to":"YYYY-MM-DD|null","search":"核心关键词或null","categoryName":"只能从给定分类清单中选择，或 null","minAmount":数字或null,"maxAmount":数字或null}\n' +
  '只输出 JSON，不要解释、不要 markdown 围栏。search 给出最能代表用户意图的 1~3 个词（去掉语气与换算词），若无可为 null。';

/**
 * 语义搜索：优先本地解析；若已启用 AI，则把（脱敏的）查询文本交给模型解析结构，失败回退本地。
 * 命中结果的查询完全在本地，绝不上送交易数据。
 */
export async function parseSearchQuery(
  nl: string,
  deps: { categoryNames: string[] },
  gate?: { enabled?: boolean }
): Promise<SemanticCriteria> {
  const local = parseCriteriaLocal(nl, deps);
  const config = readAIConfig();
  if (gate?.enabled ?? config.enabled) {
    try {
      const masked = sanitizeForClassification(nl); // 查询文本脱敏后上送
      const catList = deps.categoryNames.length
        ? `${deps.categoryNames.slice(0, 30).join('、')}`
        : '（无）';
      const reply = await chat([{ role: 'user', content: `${SEARCH_SYSTEM}\n可选分类：${catList}\n查询：${masked}` }]);
      const ai = parseAiCriteria(reply);
      if (ai) {
        // AI 给的关键词若包含分类名，则顺带到 categoryName；合并到本地结果（本地覆盖优先保证关键词含义）
        return {
          ...local,
          type: ai.type ?? local.type,
          from: ai.from ?? local.from,
          to: ai.to ?? local.to,
          categoryName: ai.categoryName && deps.categoryNames.includes(ai.categoryName) ? ai.categoryName : local.categoryName,
          minAmount: ai.minAmount ?? local.minAmount,
          maxAmount: ai.maxAmount ?? local.maxAmount,
          search: ai.search && !deps.categoryNames.includes(ai.search) ? ai.search : local.search,
          label: `已用【${(ai.categoryName ?? local.categoryName ?? '全部分类')} · ${ai.from && ai.to && ai.from !== ai.to ? `${ai.from}~${ai.to}` : (ai.from ?? local.from ?? '全部时间')}】`,
        };
      }
    } catch {
      // AI 失败 → 用本地结果
    }
  }
  return local;
}

// dayjs 需要 week 插件以支持 startOf('week')；此处只作类型的编译期引用（运行时已全局 dayjs）。
void dayjs;