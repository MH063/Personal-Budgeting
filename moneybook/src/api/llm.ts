import dayjs from 'dayjs';
import { readAIConfig } from '@/stores/useAIStore';
import { httpFetch, isAbortError, isTauriRuntime } from '@/lib/http';
import { getInsights, getCategoryDistribution, getNetWorth } from './stats';
import { select } from './db';
import { listTransactionsDetailed } from './transactions';
import { maskSensitive, sanitizeRow } from '@/lib/sanitize';
import { analyzeLocally, type LocalDiagnosis, type AnalysisDimension } from './analysis';
import type { FlowAnalysis, FlowDimension } from './moneyflow';
import { useKnowledgeStore } from '@/stores/useKnowledgeStore';

/**
 * 隐私与安全说明（调用方必须遵守）：
 * 1. API Key 仅保存在本机数据库 settings 表（kv.ai，密文），绝不写日志、绝不出现在 prompt 中。
 * 2. 请求只发送到用户自填的 baseURL 端点，除该端点外不会把任何数据发给第三方。
 * 3. 默认只发送「统计汇总」数据（金额合计、占比、规则结论），不发送交易备注等明细，
 *    除非用户在设置中显式开启 allowDetail，并且该次调用确实需要明细时才附带。
 * 4. 开启 allowDetail 时，明细备注仍必须经过 maskSensitive / sanitizeRow 脱敏后才能上送，
 *    禁止把任何可能含个人隐私的原文直接拼入 prompt。
 */

// 注入到每次请求系统提示中的安全约束，降低模型泄露/输出个人信息的风险
const PRIVACY_GUARD = `安全约束（必须遵守）：
- 你只依据用户本次提供的汇总数据作答，不得编造不存在的数据。
- 不得索取、复述或记录任何 API Key、账号密码等凭证信息。
- 未提供具体明细时，不要臆测或编造个人消费记录的细节，只能用汇总口径表述。
- 回答简洁、可执行，使用简体中文。`;

const NO_AUTH_ERROR = '未启用或未配置 AI：请先在「设置 → AI 助手」填写接口地址、模型与 Key。';

/** 单次请求的 max_tokens 上/下限保护：防止误配置过大导致服务端拒绝或超长计费 */
export const MAX_TOKENS_CAP = 32768;
const MAX_TOKENS_FLOOR = 1;

/** 规范化 max_tokens：非法（空/越界）时回退到 undefined，仍有上限保护 */
export function capMaxTokens(v: number | null | undefined): number | undefined {
  if (v == null || !Number.isFinite(v)) return undefined;
  return Math.min(Math.max(Math.floor(v), MAX_TOKENS_FLOOR), MAX_TOKENS_CAP);
}

/** 把知识库内容拼成可选的 system 提示片段（无条目时返回空串） */
function knowledgeBlock(): string {
  const es = useKnowledgeStore.getState().entries;
  const content = es
    .map((e) => (e.title.trim() || e.content.trim()) && `【${e.title.trim() || '未命名知识'}】\n${e.content.trim()}`)
    .filter(Boolean)
    .join('\n\n');
  if (!content) return '';
  return (
    '\n\n【参考知识库】（当且仅当与用户问题相关时参考；与用户实际数据冲突时以用户数据为准；不得编造知识库之外的事实）：\n' +
    content
  );
}

/** 系统提示 = 隐私约束 + 知识库 */
function buildSystemContent(): string {
  return PRIVACY_GUARD + knowledgeBlock();
}

/**
 * 用「指定配置」测试连通性（不改动任何已保存数据）。
 * 「测试连接」按钮用它实现「只测试、不写入」：用表单当前值构造临时配置直接请求，
 * 点「保存」才真正写入 store / 数据库（历史缺陷：测试会先保存表单）。
 * 说明：测试连接属于「配置凭证」环节，不要求全局「启用 AI 助手」开关已打开；
 * 真正的 AI 调用（chat / chatStream）仍受 enabled 约束，避免未启用时被调用。
 */
export async function validateConfigWith(cfg: { baseURL: string; apiKey: string; model: string }): Promise<string> {
  if (!cfg.baseURL || !cfg.model || !cfg.apiKey) {
    throw new Error('未配置 AI：请填写接口地址、模型与 Key。');
  }
  const { baseURL, model } = normalizeBaseURL(cfg.baseURL, cfg.model);
  let ok = false;
  try {
    const res = await httpFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    ok = res.ok;
    if (!ok) {
      const t = await res.text().catch(() => '');
      // 不输出响应体中的敏感信息，仅提示状态码
      throw new Error(`连接失败：HTTP ${res.status}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('连接失败')) throw e;
    // 桌面端经 Rust 侧直连不受 CORS 限制；浏览器预览仍可能被跨域拦截，提示需区分
    const hint = isTauriRuntime() ? '请检查接口地址与网络后重试' : '浏览器预览环境可能受跨域(CORS)限制，请在桌面版测试';
    throw new Error(`无法连接 ${baseURL}：${hint}。（${(e as Error).message}）`);
  }
  return ok ? '连接成功' : '连接失败：HTTP 异常';
}

/**
 * 归一化接口地址并确定模型名。
 * fallbackModel 供 validateConfigWith 传入「表单当前模型」使用——
 * 测试连接必须用表单里的值，不能回落到已保存配置的模型（否则测的不是用户填的东西）。
 * 不传时读取当前生效配置的模型（chat / chatStream 的既有行为，保持不变）。
 */
function normalizeBaseURL(raw: string, fallbackModel?: string): { baseURL: string; model: string } {
  const base = raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const model = (fallbackModel ?? readAIConfig().model).trim();
  return { baseURL: base, model };
}

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function chat(messages: ChatMessageInput[], opts: { signal?: AbortSignal } = {}): Promise<string> {
  const c = readAIConfig();
  if (!c.enabled || !c.baseURL || !c.model || !c.apiKey) throw new Error(NO_AUTH_ERROR);
  const { baseURL, model } = normalizeBaseURL(c.baseURL);

  const guard: ChatMessageInput = { role: 'system', content: buildSystemContent() };
  // 推理参数来自配置（参数面板化），为空时保持不传交由服务端默认
  const body: Record<string, unknown> = {
    model,
    messages: [guard, ...messages],
    temperature: c.temperature ?? 0.4,
  };
  if (c.topP != null) body.top_p = c.topP;
  const capped = capMaxTokens(c.maxTokens);
  if (capped != null) body.max_tokens = capped;

  let res: Response;
  try {
    res = await httpFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('已取消');
    throw new Error(`网络错误：无法连接到 ${baseURL}（${(e as Error).message}）`);
  }
  if (!res.ok) {
    // 不把响应正文里的敏感信息回传到界面
    throw new Error(`AI 服务返回错误：HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('AI 服务返回格式异常');
  return text.trim();
}

/** 流式对话：逐片回调内容（SSE 风格，兼容 OpenAI 系接口）。隐私约束与 chat 一致。 */
export async function chatStream(
  messages: ChatMessageInput[],
  opts: { onDelta: (piece: string) => void; signal?: AbortSignal }
): Promise<string> {
  const c = readAIConfig();
  if (!c.enabled || !c.baseURL || !c.model || !c.apiKey) throw new Error(NO_AUTH_ERROR);
  const { baseURL, model } = normalizeBaseURL(c.baseURL);

  const guard: ChatMessageInput = { role: 'system', content: buildSystemContent() };
  // 推理参数来自配置（参数面板化），为空时保持不传交由服务端默认
  const body: Record<string, unknown> = {
    model,
    messages: [guard, ...messages],
    temperature: c.temperature ?? 0.4,
    stream: true,
  };
  if (c.topP != null) body.top_p = c.topP;
  const capped = capMaxTokens(c.maxTokens);
  if (capped != null) body.max_tokens = capped;

  let res: Response;
  try {
    res = await httpFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`网络错误：无法连接到 ${baseURL}（${(e as Error).message}）`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`AI 服务返回错误：HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            full += delta;
            opts.onDelta(delta);
          }
        } catch {
          /* 忽略无法解析的碎片 */
        }
      }
    }
  } catch (e) {
    // 读取阶段取消：Tauri 插件抛 'Request cancelled' 普通 Error，统一规范为 AbortError
    // 供调用方识别「用户取消」而非网络故障（含中止/切换对话等场景）
    if (isAbortError(e) && !(e instanceof DOMException)) {
      throw new DOMException('请求已取消', 'AbortError');
    }
    throw e;
  } finally {
    reader.releaseLock();
  }
  return full.trim();
}

/**
 * 构建「统计汇总」上下文（不含明细备注）。
 * allowDetail 开启时，可额外附带该月支出明细备注汇总。
 */
export async function buildAggregateContext(anchorYm: string = dayjs().format('YYYY-MM')): Promise<string> {
  const c = readAIConfig();
  const curStart = dayjs(`${anchorYm}-01`).format('YYYY-MM-DD');
  const curEnd = dayjs(curStart).endOf('month').format('YYYY-MM-DD');
  const ins = await getInsights(anchorYm);
  const exp = await getCategoryDistribution('expense', curStart, curEnd);
  const inc = await getCategoryDistribution('income', curStart, curEnd);
  const nw = await getNetWorth();

  const topExp = exp.slice(0, 8).map((e) => `${e.icon}${e.name} ¥${e.total.toFixed(2)}`).join('、') || '无';
  const topInc = inc.slice(0, 5).map((e) => `${e.icon}${e.name} ¥${e.total.toFixed(2)}`).join('、') || '无';

  let ctx =
    `【${anchorYm} 收支汇总】\n` +
    `收入 ¥${ins.income.toFixed(2)}，支出 ¥${ins.expense.toFixed(2)}，结余 ¥${ins.surplus.toFixed(2)}，储蓄率 ${(ins.savingsRate * 100).toFixed(1)}%，支出健康度 ${ins.score}/100（${ins.scoreLabel}）。\n` +
    `支出分类TOP：${topExp}\n` +
    `收入分类TOP：${topInc}\n` +
    `净资产：总资产 ¥${nw.totalAssets.toFixed(2)}，总负债 ¥${nw.totalLiab.toFixed(2)}，净资产 ¥${nw.netWorth.toFixed(2)}。\n` +
    `规则型提醒${ins.rules.length ? '：' + ins.rules.map((r) => `${r.title}（${r.detail}）`).join('；') : '：无'}`;

  // 仅当用户在设置中显式开启「允许发送明细」时才附带明细。
  // 明细统一经 sanitizeRow 脱敏后才上送，绝不透出原文备注/账户名/完整日期等可识别信息。
  if (c.allowDetail) {
    const rows = await listTransactionsDetailed({ from: curStart, to: curEnd, limit: 40 });
    if (rows.length) {
      const lines = rows.map((r) =>
        sanitizeRow({ date: r.date, amount: r.amount, note: r.note, categoryName: r.category_name })
      );
      ctx += '\n【最近交易明细（已脱敏）】\n' + lines.join('\n');
      ctx += '\n（以上明细备注已做脱敏处理，不含真实手机号、证件号、银行卡、邮箱、地址等个人信息，请仅依据脱敏后的分类与金额作答）';
    }
  }
  return ctx;
}

const FLOW_DIM_LABEL: Record<FlowDimension, string> = {
  category: '分类',
  account: '账户',
  tag: '标签',
  week: '周',
  amount: '金额区间',
  type: '收支类型',
};

/**
 * 构建「资金去向·上云分析」上下文 —— 云端路线，强制脱敏。
 * ---------------------------------------------------------------
 * 入参 analysis 是本地按维度算好的汇总；此函数只发送「维度名 + 金额/占比」，
 * 任何维度名都经过 maskSensitive 脱敏，且**绝不包含**单笔备注、账户余额或完整日期。
 * 本地工具的展示仍使用原始 data（见 moneyflow.getMoneyFlowAnalysis），不受本函数影响。
 */
export function buildMoneyFlowContext(analysis: FlowAnalysis): string {
  const dimLabel = FLOW_DIM_LABEL[analysis.dimension] ?? '未知维度';
  const pct = (v: number) => (analysis.totalExpense > 0 ? ((v / analysis.totalExpense) * 100).toFixed(1) : '0.0');

  let s = `【资金去向分析·汇总】按「${dimLabel}」维度统计，时间 ${analysis.from} 至 ${analysis.to}（仅为汇总口径，无单笔明细）。\n`;
  s += `收入合计 ¥${analysis.totalIncome.toFixed(2)}，支出合计 ¥${analysis.totalExpense.toFixed(2)}。\n`;
  s += '\n支出去向（按金额降序）：\n';
  const exps = analysis.items.filter((i) => i.expense > 0).sort((a, b) => b.expense - a.expense);
  for (const it of exps.slice(0, 15)) {
    s += `- ${maskSensitive(it.label)}：支出 ¥${it.expense.toFixed(2)}，占比 ${pct(it.expense)}%\n`;
  }
  const incs = analysis.items.filter((i) => i.income > 0).sort((a, b) => b.income - a.income);
  if (incs.length) {
    s += '\n收入来源（按金额降序）：\n';
    for (const it of incs.slice(0, 10)) s += `- ${maskSensitive(it.label)}：收入 ¥${it.income.toFixed(2)}\n`;
  }
  s += '\n（备注：以上维度名已做脱敏处理，仅含分类/账户维度的汇总金额，请基于此分析资金去向并给出建议。不要编造未提供的数据。）';
  return s;
}

export const MONEY_FLOW_SYSTEM =
  '你是个人财务顾问。请依据给定的「资金去向汇总」分析我的钱主要花在哪、收入的来源构成，指出值得关注的维度（如占比最高、增长明显的去向），并按优先级给出 3-5 条具体、可执行的省钱/理财建议。语言简洁、条理清晰。';

// =====================================================================
// AI 升级：在本地诊断之上做「更深一层」的分析（AI 明确强于本地规则）
// =====================================================================
// 本地自主分析（analysis.ts）只产出确定性的量化指标与规则化建议；
// 这里把这些指标作为「线索」拼进上下文，让 AI 在此基础上做：
//   归因解释（为什么）、跨维度关联、风险推演、优先级权衡、可执行方案、
//   前瞻规划。这构成了对本地能力的清晰超越，同时只上送脱敏汇总，不含明细。
/** 把本地诊断转为「脱敏后的结构化上下文」供 AI 上云分析。维度名统经 maskSensitive。
 *  调用本地自主分析引擎 analyzeLocally，并复用 UI 当前选中的维度 dimension，
 *  确保 AI 与本地面板基于同一版「去向分析」。 */
export async function buildDiagnosisContext(
  ym: string = dayjs().format('YYYY-MM'),
  dimension: AnalysisDimension = 'category'
): Promise<{ diagnosis: LocalDiagnosis; text: string }> {
  const d = await analyzeLocally(ym, { dimension });
  const money = (v: number) => `¥${v.toFixed(2)}`;

  let s = `【财务诊断·${ym}·本地自动分析结果（按维度：${dimension}）】\n`;
  s += `收支：收入 ${money(d.income)}，支出 ${money(d.expense)}，结余 ${money(d.surplus)}，储蓄率 ${(d.savingsRate * 100).toFixed(1)}%。\n`;
  s += `结构：刚性支出占比 ${(d.fixedRatio * 100).toFixed(0)}%（${money(d.fixedExpense)}），弹性支出 ${money(d.flexibleExpense)}。\n`;
  s += `支出去向TOP（已脱敏名）：` +
    (d.topExpense.length ? d.topExpense.map((c) => `${maskSensitive(c.name)} ${money(c.total)}（${c.ratio}%）`).join('、') : '无') + '\n';
  s += `收入来源：` +
    (d.incomeTop.length ? d.incomeTop.map((c) => `${maskSensitive(c.name)} ${money(c.total)}（${c.ratio}%）`).join('、') + (d.singleIncomeRisk ? '（存在单一来源依赖风险）' : '') : '无') + '\n';
  if (d.expMomPct !== null) s += `走势：支出环比 ${d.expMomPct > 0 ? '+' : ''}${d.expMomPct}%${d.expYoYPct !== null ? `，同比 ${d.expYoYPct > 0 ? '+' : ''}${d.expYoYPct}%` : ''}。\n`;
  if (d.netWorthChangePct !== null) s += `净资产：较上月 ${d.netWorthDelta >= 0 ? '+' : ''}${money(d.netWorthDelta)}（${d.netWorthChangePct}%）。\n`;
  s += `预算：${d.budgetOverCount} 项超支，${d.budgetAlertCount} 项接近上限。\n`;
  s += `本地已识别问题：${d.advice.length ? d.advice.map((a) => a.title).join('；') : '无明显异常'}。\n`;
  s += `（备注：以上为本地汇总口径，维度名已脱敏，不含单笔明细。请在本地结论基础上做更深入的解释、权衡与前瞻，不要编造未提供的数据。）`;
  return { diagnosis: d, text: s };
}

/** AI 财务体检：在本地诊断之上做深度综合评价与分级行动方案 */
export const DIAGNOSIS_SYSTEM =
  '你是一名资深个人财务顾问。以下给出了本机的量化诊断数据。你的任务是在这些结论之上做更深一层、比规则更高的分析，输出一份结构化「财务体检报告」：\n' +
  '1. 现状解读：用通俗语言解释收支、储蓄、结构、集中度等各指标背后的含义与成因（为什么、意味着什么）。\n' +
  '2. 三大亮点 & 三大风险：结合数据指出值得肯定的地方与需要警惕的风险点，每点说明依据。\n' +
  '3. 分级行动建议：按「高优先 / 中优先 / 低优先」给出 5-8 条具体、可执行、可量化的行动项（含预期效果）。\n' +
  '4. 前瞻规划：基于节奏给出下个月的合理支出区间与储蓄目标，并给出 1-2 条中长期建议。\n' +
  '要求：只依据给定数据推理，不编造；语言简洁、条理清晰、重点突出，简体中文。';

/** AI 预算建议：为各分类推荐预算额度
 *  隐私边界：分类以不透明编号「分类#N」指代，模型必须原样回显编号，
 *  由本地在用户确认后把编号映射回真实分类 id 写入，因此真实分类名绝不发送到云端。
 */
export const BUDGET_SYSTEM =
  '你是个人财务预算规划师。依据给定的预算建议数据，为支出最高的分类推荐下个月（当前账本月）的合理月度预算额度。\n' +
  '你必须严格只输出一个 JSON 数组：不要包含 markdown 代码围栏、不要任何解释性文字或前后缀。\n' +
  '数组元素为对象，形如：{"token":"分类#1","amount":1500,"basis":"约占上月支出30%，建议持平"}。\n' +
  '要求：\n' +
  '1. 只对数据中出现的「分类#N」编号输出建议，token 必须与给定的编号完全一致，不得自行发明新编号或新分类。\n' +
  '2. amount 必须为正数，表示该分类下个月的建议月度预算金额（元）。\n' +
  '3. 为支出最高的若干分类（建议覆盖所有给出的编号）各推荐一个额度，避免重复 token。\n' +
  '4. basis 用简体中文简要给出推荐依据（例如基于历史占比/趋势）。\n' +
  '5. 只依据给定数据，不编造未提供的分类或数据。';

export interface BudgetRecommendation {
  token: string;
  amount: number;
  basis: string;
}

/**
 * 稳健地从 AI 文本中提取第一个 JSON 数组并校验为预算建议列表。
 * 会剥离 ```json 围栏、定位首个 '[' 与匹配的 ']'，逐项校验并过滤非法项，上限 20 条。
 * 任何异常都返回空数组，绝不抛出。
 */
export function parseBudgetRecommendations(raw: string): BudgetRecommendation[] {
  try {
    let t = String(raw ?? '').trim();
    t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return [];
    const parsed: unknown = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const out: BudgetRecommendation[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const token = String(rec.token ?? '').trim();
      const amount = Number(rec.amount);
      const basis = String(rec.basis ?? '').trim();
      if (!token || !Number.isFinite(amount) || amount <= 0) continue;
      out.push({ token, amount, basis });
      if (out.length >= 20) break;
    }
    return out;
  } catch {
    return [];
  }
}

export interface BudgetProposalItem {
  /** 映射到的真实支出分类 id；null 表示总预算（无分类） */
  categoryId: number | null;
  categoryName: string;
  amount: number;
  basis: string;
}

/**
 * 构建「预算建议」的委派上下文（不上传真实分类名）。
 * 依赖 analyzeLocally 得到收支/储蓄等数值，另取本月支出分类分布取 TOP 分类；
 * 每个分类用不透明编号「分类#N」指代，并返回 编号 → 真实分类 的本地映射表，供写入时回填。
 * 云端只收到编号与金额，真实分类名仅存在于本地 itemsMap。
 */
export async function buildBudgetProposal(
  ym: string = dayjs().format('YYYY-MM')
): Promise<{ text: string; itemsMap: Record<string, BudgetProposalItem> }> {
  const d = await analyzeLocally(ym);
  const curStart = dayjs(`${ym}-01`).format('YYYY-MM-DD');
  const curEnd = dayjs(curStart).endOf('month').format('YYYY-MM-DD');
  const expCats = await getCategoryDistribution('expense', curStart, curEnd);
  const catRows = await select<{ id: number; name: string }>(
    `SELECT id, name FROM categories WHERE type='expense'`
  );
  const idByName = new Map(catRows.map((r) => [r.name, r.id]));

  const top = expCats.slice(0, 8);
  const money = (v: number) => `¥${v.toFixed(2)}`;

  const itemsMap: Record<string, BudgetProposalItem> = {};
  let lines = '';
  top.forEach((c, i) => {
    const token = `分类#${i + 1}`;
    const ratio = d.expense > 0 ? ((c.total / d.expense) * 100).toFixed(1) : '0.0';
    lines += `- ${token}：支出 ${money(c.total)}（占比 ${ratio}%）\n`;
    itemsMap[token] = {
      categoryId: idByName.get(c.name) ?? null,
      categoryName: c.name,
      amount: c.total,
      basis: '',
    };
  });

  const text =
    `【${ym} 预算建议数据】（分类以不透明编号「分类#N」代替，仅用于指代，不泄露真实分类名）\n` +
    `收入 ${money(d.income)}，支出 ${money(d.expense)}，结余 ${money(d.surplus)}，储蓄率 ${(d.savingsRate * 100).toFixed(1)}%。\n` +
    `本月支出最高的分类（按金额降序）：\n${lines || '无支出分类数据'}\n` +
    `（请严格按系统提示的 JSON 数组格式输出预算建议，且必须引用上述给出的编号。）`;

  return { text, itemsMap };
}

/** AI 下月预测 / 预警 */
export const FORECAST_SYSTEM =
  '你是一名个人财务分析师。请依据给定的诊断与历史走势数据，预测下一个月：\n' +
  '1. 预计支出区间（给出保守/中性/激进三档及理由）；\n' +
  '2. 预计现金流入与结余，判断是否会入不敷出；\n' +
  '3. 现金流/超支风险预警：指出最可能超预算或产生突发压力的分类与应对预案。\n' +
  '只依据给定数据合理推断，明确标注不确定性，不编造；简洁、可执行，简体中文。';