import dayjs from 'dayjs';
import { readAIConfig, useAIStore } from '@/stores/useAIStore';
import { getKV, setKV } from './kv';
import { httpFetch, isAbortError, createTimeoutGuard } from '@/lib/http';
import { isTauriRuntime } from '@/lib/runtime';
import { getInsights, getCategoryDistribution, getNetWorth } from './stats';
import { select } from './db';
import { listTransactionsDetailed } from './transactions';
import { maskSensitive, sanitizeRow } from '@/lib/sanitize';
import { analyzeLocally, type LocalDiagnosis, type AnalysisDimension } from './analysis';
import type { FlowAnalysis, FlowDimension } from './moneyflow';
import { useKnowledgeStore } from '@/stores/useKnowledgeStore';
import { reconDiffSummary, type BankRow, type ReconItem } from './reconciliation';
import { currentLedgerId } from '@/lib/ledger';
import { estimateTokens, clipLinesToBudget } from '@/lib/tokenBudget';

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

/**
 * 请求超时保护（历史缺陷：chat/chatStream 此前无超时，服务端长时间无响应会让界面一直转圈）。
 * - CHAT_TIMEOUT_MS：非流式请求的总超时。LLM 完整生成可能较慢，给足 120s，避免误伤慢模型。
 * - STREAM_IDLE_TIMEOUT_MS：流式请求的「空闲超时」——只在长时间收不到任何数据片时判定超时；
 *   正常生成期间每收到一片就会刷新计时（见 chatStream 中 timeoutGuard.touch()），不会误伤长回答。
 * 注意：本模块内已有变量名 `guard`（系统提示消息），故超时守卫变量统一命名为 `timeoutGuard`。
 */
export const CHAT_TIMEOUT_MS = 120_000;
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** 构造超时提示文案（供 chat / chatStream 复用，保证文案一致） */
function timeoutMessage(stage: '响应' | '数据', ms: number, baseURL: string): string {
  return `AI 请求超时：${baseURL} 在 ${Math.round(ms / 1000)}s 内未返回${stage}，请检查网络或稍后重试`;
}

/** 单次请求的 max_tokens 上/下限保护：防止误配置过大导致服务端拒绝或超长计费 */
export const MAX_TOKENS_CAP = 32768;
const MAX_TOKENS_FLOOR = 1;

/** 规范化 max_tokens：非法（空/越界）时回退到 undefined，仍有上限保护 */
export function capMaxTokens(v: number | null | undefined): number | undefined {
  if (v == null || !Number.isFinite(v)) return undefined;
  return Math.min(Math.max(Math.floor(v), MAX_TOKENS_FLOOR), MAX_TOKENS_CAP);
}

/** 知识库拼入 system 提示的最大 token 预算（条目数不限，超出预算时只保留靠前条目） */
const KNOWLEDGE_TOKEN_BUDGET = 2000;

/** 知识库片段的固定标题（单独抽出，便于预算中计入其占用的 token） */
const KNOWLEDGE_HEADER =
  '\n\n【参考知识库】（当且仅当与用户问题相关时参考；与用户实际数据冲突时以用户数据为准；不得编造知识库之外的事实）：\n';

/**
 * 把知识库内容拼成可选的 system 提示片段（无条目时返回空串）。
 * 历史缺陷：此前直接拼接全部知识条目、无任何长度上限；知识库较大时会撑爆请求体。
 * 现按 token 预算裁剪，仅保留靠前条目并标注被省略的数量（详见 lib/tokenBudget.ts）。
 */
function knowledgeBlock(): string {
  const es = useKnowledgeStore.getState().entries;
  const items = es
    .map((e) => ((e.title.trim() || e.content.trim()) ? `【${e.title.trim() || '未命名知识'}】\n${e.content.trim()}` : ''))
    .filter(Boolean) as string[];
  if (!items.length) return '';
  const { text, omitted } = clipLinesToBudget(items, KNOWLEDGE_TOKEN_BUDGET, {
    headerTokens: estimateTokens(KNOWLEDGE_HEADER),
    separator: '\n\n',
  });
  return KNOWLEDGE_HEADER + text + (omitted > 0 ? `\n\n（另有 ${omitted} 条知识因超出长度限制未随请求发送。）` : '');
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
      throw new Error(`连接失败：${describeAiHttpError(res.status, baseURL)}（HTTP ${res.status}）`);
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

/**
 * 本地 AI 用量统计（零成本方案）：
 * 各厂商的「已使用金额/请求次数」没有统一的公开查询接口，且查询余额本身免费，
 * 因此请求次数与 Tokens 改为在每次 chat/chatStream 成功后本地累计（kv.aiUsage），
 * 凭证目录据此展示「调用次数 / 累计 Tokens / 本月 Tokens」，无需联网查询、不产生费用。
 * 按生效凭证 id 聚合，切换凭证即分开统计。
 */
export interface AiUsageStat {
  requests: number;
  tokens: number;
  /** 当前统计月（YYYY-MM）：跨月时本月 Tokens 归零重计 */
  month: string;
  monthTokens: number;
}

const AI_USAGE_KV_KEY = 'kv.aiUsage';

/** 读取某凭证的本地用量统计；无记录时返回全 0 基线（不抛错）。 */
export function loadAiUsage(providerId: string): AiUsageStat {
  const zero: AiUsageStat = { requests: 0, tokens: 0, month: dayjs().format('YYYY-MM'), monthTokens: 0 };
  try {
    const all = JSON.parse(String(getKV(AI_USAGE_KV_KEY) ?? 'null')) as Record<string, AiUsageStat> | null;
    return all?.[providerId] ?? zero;
  } catch {
    return zero;
  }
}

/** 成功响应后累计一次请求与 Tokens；usage 缺失时仅记请求次数（统计失败不影响主流程）。 */
export function recordAiUsage(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
  try {
    const s = useAIStore.getState();
    const pid = s.activeProviderId || s.providers[0]?.id;
    if (!pid) return;
    const now = dayjs().format('YYYY-MM');
    const cur = loadAiUsage(pid);
    const tokens = usage?.total_tokens ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0));
    const next: AiUsageStat = {
      requests: cur.requests + 1,
      tokens: cur.tokens + tokens,
      month: now,
      monthTokens: cur.month === now ? cur.monthTokens + tokens : tokens,
    };
    const all = JSON.parse(String(getKV(AI_USAGE_KV_KEY) ?? 'null')) as Record<string, AiUsageStat> | null ?? {};
    setKV(AI_USAGE_KV_KEY, JSON.stringify({ ...all, [pid]: next }));
  } catch { /* 用量统计失败不阻塞调用主流程 */ }
}

/**
 * 错误码 → 中文原因映射（按服务商特化）。
 * 依据各厂商官方错误码文档：
 * - DeepSeek：400 格式错误 / 401 认证失败 / 402 余额不足 / 422 参数错误 / 429 请求速率达到上限 / 500 服务器故障 / 503 服务器繁忙
 * - Anthropic Claude：400 请求格式 / 401 认证失败 / 402 计费异常 / 403 权限不足 / 404 资源不存在 / 409 冲突 / 413 请求过大 / 429 限流或额度上限 / 500 内部错误 / 504 超时 / 529 过载
 * - OpenAI 及 OpenAI 兼容服务：400 参数错误 / 401 认证失败 / 402 余额不足 / 403 权限不足 / 404 接口或模型不存在 / 409 冲突 / 413 请求过大 / 422 参数语义错误 / 429 限流或额度用尽 / 500 内部错误 / 502 网关 / 503 不可用 / 504 超时
 * 未列出的状态码回退为「HTTP xxx」原文，不编造原因。
 */
export function describeAiHttpError(status: number, baseURL: string): string {
  const host = String(baseURL ?? '').toLowerCase();
  // Anthropic /messages 端点（含 Claude）
  if (host.includes('anthropic') || host.includes('claude')) {
    const map: Record<number, string> = {
      400: '请求格式错误',
      401: '认证失败：API Key 无效、已吊销或已过期',
      402: '计费信息异常：请检查付款方式',
      403: '权限不足：Key 无权限访问该资源',
      404: '资源不存在：请检查接口地址与模型名',
      409: '请求冲突：资源被并发修改或已存在',
      413: '请求体过大：超出 32MB 上限',
      429: '请求速率或额度上限：已命中限流或月度额度',
      500: '服务器内部错误：请稍后重试',
      504: '处理超时：请改用流式或缩短请求',
      529: '服务过载：服务器繁忙，请稍后重试',
    };
    return map[status] ?? `HTTP ${status}`;
  }
  // DeepSeek（官方错误码表）
  if (host.includes('deepseek')) {
    const map: Record<number, string> = {
      400: '格式错误：请求体格式不符合要求',
      401: '认证失败：API Key 错误，请检查后重试',
      402: '账号余额不足：请确认余额并前往充值',
      422: '参数错误：请求体参数有误',
      429: '请求速率达到上限：TPM 或 RPM 超限，请合理规划请求速率',
      500: '服务器故障：请等待后重试',
      503: '服务器繁忙：服务器负载过高，请稍后重试',
    };
    return map[status] ?? `HTTP ${status}`;
  }
  // OpenAI 及 OpenAI 兼容服务
  const map: Record<number, string> = {
    400: '参数错误：请求体格式或字段不符合要求',
    401: '认证失败：API Key 无效，请检查后重试',
    402: '余额不足：账号额度已用尽，请充值',
    403: '权限不足：Key 无权限访问该资源',
    404: '接口或模型不存在：请检查接口地址与模型名',
    409: '请求冲突：请检查请求状态',
    413: '请求体过大：超出接口大小上限',
    422: '参数错误：请求体参数语义不符合要求',
    429: '请求速率或额度上限：已限流或余额/用量用尽',
    500: '服务器内部错误：请稍后重试',
    502: '网关错误：请稍后重试',
    503: '服务不可用：请稍后重试',
    504: '处理超时：请稍后重试',
  };
  return map[status] ?? `HTTP ${status}`;
}

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 可重试错误（网络错误 / HTTP 429 / 5xx）。
 * 背景（历史缺陷）：chat 此前一次失败即抛错，偶发的网络抖动或服务端 5xx 会直接失败，
 * 而这类错误天然具备「重试即可成功」的性质，故新增有限重试（见 chat 重试循环）。
 */
class RetryableChatError extends Error {}
/** 不可重试错误（认证/参数等 4xx、响应格式异常、用户取消）：直接抛出，不发起重试 */
class FatalChatError extends Error {}

/** 非流式 chat 的最大重试次数（不含首次请求）：仅在可重试错误时按指数退避重试 */
export const CHAT_MAX_RETRIES = 2;
/** 重试退避基数（毫秒）：第 n 次重试等待 base × 3^(n-1)，即 500ms → 1500ms */
const CHAT_RETRY_BASE_MS = 500;

/** 计算第 retryIndex 次重试（从 1 计）的退避时长 */
function chatRetryDelayMs(retryIndex: number): number {
  return CHAT_RETRY_BASE_MS * 3 ** (retryIndex - 1);
}

/**
 * 可被外部取消打断的退避等待：正常到点 resolve；等待期间用户取消则 reject('已取消')，
 * 使重试循环立即终止，不会在用户已放弃后仍继续发请求。
 */
function backoffSleep(ms: number, external?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (external?.aborted) { reject(new Error('已取消')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('已取消')); };
    const timer = setTimeout(() => {
      external?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    external?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 单次非流式请求（含独立超时守卫）。
 * 失败时按错误性质抛出：RetryableChatError（可重试）/ FatalChatError（不可重试）。
 * 说明：不把响应正文里的敏感信息回传到界面；状态码映射为中文原因（见 describeAiHttpError）。
 */
async function chatOnce(
  baseURL: string,
  apiKey: string,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal }
): Promise<string> {
  // 超时守卫：超时中止与用户取消语义分开（见 createTimeoutGuard 注释）
  const timeoutGuard = createTimeoutGuard(CHAT_TIMEOUT_MS, opts.signal);
  try {
    const res = await httpFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: timeoutGuard.signal,
    });
    if (!res.ok) {
      const msg = `AI 服务返回错误：${describeAiHttpError(res.status, baseURL)}（HTTP ${res.status}）`;
      // 仅 429（限流）与 5xx（服务端故障）值得重试；其余 4xx 多为参数/认证问题，重试无意义
      if (res.status === 429 || res.status >= 500) throw new RetryableChatError(msg);
      throw new FatalChatError(msg);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new FatalChatError('AI 服务返回格式异常');
    // 本地用量统计：成功响应后累计请求次数与 Tokens（见 recordAiUsage 注释，零成本）
    recordAiUsage(data?.usage);
    return text.trim();
  } catch (e) {
    // 已判定的业务错误原样抛出，避免被下面的网络错误分支误判为可重试
    if (e instanceof RetryableChatError || e instanceof FatalChatError) throw e;
    if (timeoutGuard.timedOut()) throw new RetryableChatError(timeoutMessage('响应', CHAT_TIMEOUT_MS, baseURL));
    if (isAbortError(e) || opts.signal?.aborted) throw new FatalChatError('已取消');
    throw new RetryableChatError(`网络错误：无法连接到 ${baseURL}（${(e as Error).message}）`);
  } finally {
    timeoutGuard.cleanup();
  }
}

/**
 * 非流式对话：失败时按「可重试错误」做有限次指数退避重试（最多 CHAT_MAX_RETRIES 次）。
 * 重试边界（刻意保守，避免无意义重发与重复计费）：
 *   - 重试：网络错误、HTTP 429、5xx；
 *   - 不重试：其余 4xx（参数/认证问题）、响应格式异常、用户主动取消（opts.signal.aborted）。
 * 每次重试都新建超时守卫，保证单次请求独立计时，重试之间不影响超时语义。
 */
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

  let lastErr: Error = new Error('AI 请求失败');
  for (let attempt = 0; attempt <= CHAT_MAX_RETRIES; attempt++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    // 首次请求不等待；重试前按指数退避等待（退避期间被取消则直接终止）
    if (attempt > 0) {
      const waitMs = chatRetryDelayMs(attempt);
      console.warn(`[llm] chat 第 ${attempt} 次重试，退避 ${waitMs}ms 后发送`);
      await backoffSleep(waitMs, opts.signal);
    }
    try {
      return await chatOnce(baseURL, c.apiKey, body, opts);
    } catch (e) {
      lastErr = e as Error;
      if (!(e instanceof RetryableChatError) || attempt >= CHAT_MAX_RETRIES) throw e;
      // 关键位置日志：便于在控制台观察重试过程与失败原因
      console.warn(`[llm] chat 请求失败（第 ${attempt + 1} 次），将重试：`, lastErr.message);
    }
  }
  throw lastErr;
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
  // 请求流式响应中附带 usage（OpenAI 系标准扩展，用于本地用量统计）。
  // 兼容性兜底（历史缺陷：此前无条件添加，遇到不认该字段的服务商会整个流式请求失败）：
  // 若服务商因该字段返回 400，则去掉该字段重发一次；此时无 usage 返回，recordAiUsage 已做缺失容错。
  body.stream_options = { include_usage: true };

  let res: Response;
  // 超时守卫：流式采用「空闲超时」，每收到一片数据即刷新计时（见下方 timeoutGuard.touch()）
  const timeoutGuard = createTimeoutGuard(STREAM_IDLE_TIMEOUT_MS, opts.signal);
  try {
    res = await httpFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
      signal: timeoutGuard.signal,
    });
    if (res.status === 400 && 'stream_options' in body) {
      delete body.stream_options;
      // 关键位置日志：便于区分「服务商不兼容 stream_options」与其它 400 原因
      console.warn('[llm] 服务商未接受 stream_options，已去掉该字段重试流式请求');
      res = await httpFetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify(body),
        signal: timeoutGuard.signal,
      });
    }
  } catch (e) {
    timeoutGuard.cleanup();
    if (timeoutGuard.timedOut()) throw new Error(timeoutMessage('响应', STREAM_IDLE_TIMEOUT_MS, baseURL));
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`网络错误：无法连接到 ${baseURL}（${(e as Error).message}）`);
  }
  if (!res.ok || !res.body) {
    timeoutGuard.cleanup();
    throw new Error(`AI 服务返回错误：${describeAiHttpError(res.status, baseURL)}（HTTP ${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  // 流式响应末尾（stream_options.include_usage）附带的用量信息，供本地统计
  let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      timeoutGuard.touch(); // 收到数据：刷新空闲计时，避免长回答被误判超时
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
          if (j?.usage) streamUsage = j.usage;
        } catch {
          /* 忽略无法解析的碎片 */
        }
      }
    }
  } catch (e) {
    // 先判超时：空闲超时会以 AbortError 形式抛出，须与「用户取消」区分
    if (timeoutGuard.timedOut()) throw new Error(timeoutMessage('数据', STREAM_IDLE_TIMEOUT_MS, baseURL));
    // 读取阶段取消：Tauri 插件抛 'Request cancelled' 普通 Error，统一规范为 AbortError
    // 供调用方识别「用户取消」而非网络故障（含中止/切换对话等场景）
    if (isAbortError(e) && !(e instanceof DOMException)) {
      throw new DOMException('请求已取消', 'AbortError');
    }
    throw e;
  } finally {
    reader.releaseLock();
    timeoutGuard.cleanup();
  }
  // 本地用量统计：流式完成后累计请求次数与 Tokens（见 recordAiUsage 注释，零成本）
  recordAiUsage(streamUsage);
  return full.trim();
}

/** 明细行上送的 token 预算：明细备注长度不可控，除条数上限（40 条）外再做预算裁剪 */
const DETAIL_TOKEN_BUDGET = 2000;

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
      // 明细行长度不可控（备注可能很长），除条数上限外再做 token 预算裁剪，避免撑爆请求体
      const { text, omitted } = clipLinesToBudget(lines, DETAIL_TOKEN_BUDGET);
      ctx += '\n【最近交易明细（已脱敏）】\n' + text;
      if (omitted > 0) ctx += `\n（另有 ${omitted} 条明细因超出长度限制未发送）`;
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

// =====================================================================
// AI 对账差异解释：当对账存在差异（未配对 / 金额不符 / 余额差额非零）时，
// 把「差异构成」组装成脱敏上下文交给 AI 说明「差在哪」（漏记/重复/金额不符等），
// 并给出排查建议。隐私边界：摘要/备注/账户名统一经 maskSensitive 脱敏后才上送，
// 仅发送汇总与少量示例，绝不发送完整交易列表。
// =====================================================================

/** AI 对账差异解释的系统提示：只依据给定差异事实归因，不编造。 */
export const RECON_DIFF_SYSTEM =
  '你是银行对账差异分析助手。以下是某账户一次对账产生的差异汇总（摘要/备注均经脱敏，不含个人可识别信息）。请：\n' +
  '1. 用通俗语言说明「钱对不上」的可能原因（漏记、重复记账、金额不符、日期偏差、跨期、手续费/汇率、拆分未配对等），逐条说明依据；\n' +
  '2. 指出最可能的 1-2 个原因并解释为什么；\n' +
  '3. 给出可执行的排查/处理建议（如核对某笔、补录、调整分类或金额）。\n' +
  '只依据给定数据推理，不编造具体交易或数字；回答简洁、条理清晰，使用简体中文。';

/** 把某条银行流水行从 bank_row JSON 中安全解析（坏行返回 null）。 */
function parseBankRowSafe(item: Pick<ReconItem, 'bank_row'>): BankRow | null {
  try { return JSON.parse(item.bank_row) as BankRow; } catch { return null; }
}

/**
 * 组装「对账差异」的脱敏上下文（纯数据收集，不调用 LLM）。
 * 三类差异均只取前若干条作为示例（防 token 过大）；摘要/备注/账户名统一经 maskSensitive 脱敏。
 */
export async function buildReconDiffContext(recId: number): Promise<string> {
  const [rec] = await select<{
    account_name: string | null; period_start: string | null; period_end: string | null;
    opening_balance: number; bank_balance: number | null; calc_balance: number | null; diff_total: number;
  }>(
    `SELECT a.name AS account_name, r.period_start, r.period_end,
            r.opening_balance, r.bank_balance, r.calc_balance, r.diff_total
     FROM reconciliations r LEFT JOIN accounts a ON r.account_id = a.id
     WHERE r.id = $1 AND r.ledger_id = $2`,
    [recId, currentLedgerId()]
  );
  if (!rec) return '';
  const diff = await reconDiffSummary(recId);

  const money = (v: number) => `¥${v.toFixed(2)}`;
  const fmtBank = (m: ReconItem) => {
    const b = parseBankRowSafe(m);
    if (!b) return '（解析失败的流水行）';
    const amt = b.income > 0 ? `+${money(b.income)}` : `-${money(b.expense)}`;
    return `${maskSensitive(b.summary || '（无摘要）')} ${amt}（${b.date}）`;
  };

  // 各类差异示例行的 token 预算：单行摘要可能很长（如银行流水备注），
  // 除条数上限（各 10 条）外再做预算裁剪，避免三类示例叠加后撑爆请求体
  const SAMPLE_TOKEN_BUDGET = 600;
  /** 把示例数组按 token 预算裁剪并用「；」拼接，超出部分标注省略条数 */
  const clipExamples = (arr: string[]) => {
    const { text, omitted } = clipLinesToBudget(arr, SAMPLE_TOKEN_BUDGET, { separator: '；' });
    return text + (omitted > 0 ? `…（另有 ${omitted} 条未列出）` : '');
  };

  let s = `【银行对账·差异说明】账户 ${maskSensitive(rec.account_name ?? '')}，期间 ${rec.period_start ?? '-'} ~ ${rec.period_end ?? '-'}\n`;
  s += `期初 ${money(rec.opening_balance)}，推算余额 ${rec.calc_balance != null ? money(rec.calc_balance) : '未计算'}，银行余额 ${rec.bank_balance != null ? money(rec.bank_balance) : '未填写'}，差额 ${money(rec.diff_total)}。\n`;

  s += `\n银行有·本地无：共 ${diff.bankUnmatched.length} 条` +
    (diff.bankUnmatched.length ? `，示例：${clipExamples(diff.bankUnmatched.slice(0, 10).map(fmtBank))}` : '') + '\n';
  s += `本地有·银行无：共 ${diff.localUnmatchedTotal} 条` +
    (diff.localUnmatched.length ? `，示例：${clipExamples(diff.localUnmatched.slice(0, 10).map((t) => `${maskSensitive(t.tx_note ?? '（无备注）')} ${money(Math.abs(t.tx_amount ?? 0))}（${t.tx_date ?? '-'}）`))}` : '') + '\n';
  s += `金额不符：共 ${diff.amountMismatch.length} 条` +
    (diff.amountMismatch.length ? `，示例：${clipExamples(diff.amountMismatch.slice(0, 10).map(fmtBank))}` : '') + '\n';

  s += '\n（以上摘要/备注已脱敏，仅含汇总与示例；请据此说明差异可能原因与处理建议，不要编造未提供的交易。）';
  return s;
}

/** 生成确定性的本地兜底文案（不依赖 LLM）：列出差异构成 + 通用排查建议。 */
export function buildReconDiffLocalText(args: {
  bankUnmatchedN: number;
  localUnmatchedN: number;
  amountMismatchN: number;
}): string {
  const parts: string[] = [];
  if (args.bankUnmatchedN > 0) parts.push(`银行有·本地无 ${args.bankUnmatchedN} 条（可能漏记本地交易）`);
  if (args.localUnmatchedN > 0) parts.push(`本地有·银行无 ${args.localUnmatchedN} 条（可能本地多记或银行未入账）`);
  if (args.amountMismatchN > 0) parts.push(`金额不符 ${args.amountMismatchN} 条（可能金额录入有误或手续费/汇率差异）`);
  const head = parts.length ? `本次对账差异构成：${parts.join('、')}。` : '本次对账没有未配对或金额不符的差异。';
  return (
    head + '\n建议排查：\n' +
    '1. 先核对「银行有·本地无」的流水是否漏记，必要时补录本地交易；\n' +
    '2. 再核对「本地有·银行无」是否重复记账或银行未入账，确认后删除或调整；\n' +
    '3. 「金额不符」请逐笔比对原交易金额，注意手续费/汇率/四舍五入等差异；\n' +
    '4. 仍有差异时，可核对期间外的前后交易是否跨期。\n' +
    '（提示：开启 AI 并配置凭证后，可让 AI 结合差异明细给出更具体的归因与建议。）'
  );
}

/**
 * AI 对账差异解释入口：先本地统计给出确定性文案；已启用 AI 时把脱敏差异上下文交给 LLM
 * 生成更自然的归因与建议，任一步失败都回退本地文案（功能不中断）。
 */
export async function explainReconDiff(recId: number): Promise<{ text: string; source: 'ai' | 'local' }> {
  const diff = await reconDiffSummary(recId);
  const local = buildReconDiffLocalText({
    bankUnmatchedN: diff.bankUnmatched.length,
    localUnmatchedN: diff.localUnmatchedTotal,
    amountMismatchN: diff.amountMismatch.length,
  });

  const cfg = readAIConfig();
  if (cfg.enabled) {
    try {
      const ctx = await buildReconDiffContext(recId);
      if (ctx) {
        const reply = await chat([
          { role: 'system', content: RECON_DIFF_SYSTEM },
          { role: 'user', content: ctx },
        ]);
        if (reply && reply.trim()) return { text: reply.trim(), source: 'ai' };
      }
    } catch {
      // AI 失败 → 回退本地文案，功能不中断
    }
  }
  return { text: local, source: 'local' };
}