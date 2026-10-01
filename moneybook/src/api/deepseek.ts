/**
 * DeepSeek 专属接口封装。
 * ------------------------------------------------------------------
 * 仅在当前凭证的 Base URL 指向 DeepSeek（api.deepseek.com）时可用，本模块只做
 * 网络封装，具体界面在「设置 → AI 助手」与「AI 助手」组件中调用。
 *
 * 已封装能力：
 *   - 查询余额：            GET  /user/balance
 *   - FIM 补全（Beta）：     POST /beta/completions
 *
 * 说明：原「知识库 / 文件管理（/files）」封装已移除——参考文档改为「本地文档统一」方案
 * （见设置页知识库区块）：文档内容存本机、随 AI 请求注入系统提示，全服务商一致生效，
 * 不再依赖 DeepSeek 云端文件接口，也避免把参考文档上传到服务商云端。
 *
 * 关于上下文缓存（kv_cache）：DeepSeek 的「磁盘上下文缓存」是**自动生效**的，
 * 无需任何额外的显式请求或参数。只要连续请求复用相同的前缀（例如固定的
 * system prompt、参考文档内容片段），服务端就会自动命中缓存并降本提速，
 * 命中情况可从每次响应头 x-cache、usage 中观察。因此本项目不单独提供调用接口。
 *
 * 关于 Responses API（POST /responses）：本记账应用的 AI 用法是「把本地统计汇总
 * 一次性喂给模型 → 生成诊断/建议/预测」的单轮富上下文问答，并不需要多步工具调用、
 * 服务端会话状态或文件搜索。Responses API 面向的是复杂 Agent 场景，对本工具边际
 * 价值极低，且 DeepSeek 主接口对其稳定支持存疑，故**不接入也不封装**，避免引入
 * 不会调用的死代码与双倍维护成本。
 *
 * 说明：本模块所有请求均经统一 `httpFetch`（src/lib/http.ts）。桌面端由 Rust 侧发出，
 * 不受 WebView CORS/CSP 限制；浏览器预览环境回退原生 fetch，可能受服务商 CORS 策略限制。
 */
import { readAIConfig } from '@/stores/useAIStore';
import { httpFetch } from '@/lib/http';

/** 判断某 Base URL 是否指向 DeepSeek（余额/文件管理仅 DeepSeek 提供） */
export function isDeepSeekHost(baseURL: string): boolean {
  return /deepseek/i.test(baseURL);
}

/** 取当前激活凭证的 DeepSeek 鉴权信息；非 DeepSeek 或无配置返回 null */
function deepSeekAuth(): { baseURL: string; apiKey: string } | null {
  const c = readAIConfig();
  if (!isDeepSeekHost(c.baseURL) || !c.apiKey) return null;
  return { baseURL: c.baseURL.trim().replace(/\/+$/, ''), apiKey: c.apiKey };
}

/** 统一的错误提示：不把响应正文的敏感信息回传，仅给状态码/网络原因 */
function reqError(base: string, res: Response): Error {
  return new Error(`请求失败：HTTP ${res.status}（${base}）`);
}

async function jsonOrThrow<T>(res: Response, base: string): Promise<T> {
  if (!res.ok) throw reqError(base, res);
  return res.json() as Promise<T>;
}

// =====================================================================
// 1. 查询余额  GET /user/balance
// =====================================================================
export interface DeepSeekBalanceInfo {
  currency: string;
  /** 总余额 */
  total_balance: string;
  /** 赠送额度余额 */
  granted_balance: string;
  /** 充值余额 */
  topped_up_balance: string;
}
export interface DeepSeekBalance {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}

/** 查询额度余额。仅 DeepSeek 凭证可用；返回 null 表示当前凭证不是 DeepSeek 或未配置 Key。 */
export async function fetchBalance(): Promise<DeepSeekBalance | null> {
  const a = deepSeekAuth();
  if (!a) {
    console.warn('[deepseek] 非 DeepSeek 凭证或无 Key，跳过余额查询');
    return null;
  }
  const url = `${a.baseURL}/user/balance`;
  const res = await httpFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${a.apiKey}` },
  });
  const data = await jsonOrThrow<DeepSeekBalance>(res, url);
  console.log('[deepseek] 查询余额成功', data);
  return data;
}

// =====================================================================
// 2. FIM 补全（Beta）  POST /beta/completions
// =====================================================================
export interface FIMRequest {
  /** 需要补全的前缀（必填） */
  prompt: string;
  /** 可选的后续后缀；提供后模型在中间补全（infill） */
  suffix?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

export interface FIMResult {
  text: string;
  finishReason?: string;
  model?: string;
}

export interface FIMCompletionChoice {
  index: number;
  text: string;
  finish_reason?: string;
}
export interface FIMCompletion {
  id?: string;
  model?: string;
  choices: FIMCompletionChoice[];
}

/** 使用 FIM 接口让模型补全文本（续写/中段插入）。实时失败抛出带提示的错误。 */
export async function completeFIM(req: FIMRequest): Promise<FIMResult> {
  const c = readAIConfig();
  const a = deepSeekAuth();
  if (!a) throw new Error('请在设置中配置且激活 DeepSeek 凭证后使用补全');
  if (!req.model) req.model = c.model;
  const url = `${a.baseURL}/beta/completions`;
  const body = {
    model: req.model || 'deepseek-chat',
    prompt: req.prompt,
    ...(req.suffix ? { suffix: req.suffix } : {}),
    max_tokens: req.max_tokens ?? 128,
    temperature: req.temperature ?? 0.5,
    ...(req.top_p != null ? { top_p: req.top_p } : {}),
  };
  const res = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await jsonOrThrow<FIMCompletion>(res, url);
  const text = (data.choices?.[0]?.text ?? '').trim();
  if (!text) throw new Error('POST /beta/completions 返回空文本');
  console.log('[deepseek] FIM 补全成功', { len: text.length });
  return { text, finishReason: data.choices?.[0]?.finish_reason, model: data.model };
}