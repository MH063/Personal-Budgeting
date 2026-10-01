/**
 * 多源大模型提供商预设与模型列表拉取。
 * 仅供「AI 设置」页面使用，不涉及隐私数据与联网脱敏逻辑。
 */
import { httpFetch } from '@/lib/http';

export interface ProviderPreset {
  id: string;
  name: string;
  /** 官方「获取 API Key」页面 */
  apiKeyUrl: string;
  /** 官方文档地址 */
  docUrl: string;
  /** 标准 Base URL（必须是该提供商真实可用的接口前缀） */
  defaultBaseUrl: string;
  /** 模型列表端点（相对 defaultBaseUrl 的路径，不带前导斜杠语义） */
  modelListEndpoint: string;
  /** 鉴权头前缀：'Bearer' / 'x-api-key' / ''(无需鉴权) */
  authHeaderPrefix: string;
  /** 推荐的默认模型（无模型时预填，任意新服务商通用） */
  defaultModel?: string;
  /** 对没有公开 /models 接口、或实时拉取失败的提供商，提供的静态/精选模型列表 */
  models?: string[];
  /** 同服务商的多种兼容 Base URL 形态（如 DeepSeek 的 OpenAI 兼容 / Anthropic 兼容）。
   *  首项应为 defaultBaseUrl；选择服务商时自动填充居首项，可在设置页下拉切换。 */
  baseUrlVariants?: { label: string; url: string }[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docUrl: 'https://api-docs.deepseek.com/zh-cn/',
    defaultBaseUrl: 'https://api.deepseek.com',
    modelListEndpoint: '/models',
    authHeaderPrefix: 'Bearer',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    baseUrlVariants: [
      { label: 'OpenAI 兼容', url: 'https://api.deepseek.com' },
      { label: 'Anthropic 兼容', url: 'https://api.deepseek.com/anthropic' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    docUrl: 'https://platform.openai.com/docs',
    defaultBaseUrl: 'https://api.openai.com',
    modelListEndpoint: '/v1/models',
    authHeaderPrefix: 'Bearer',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  {
    id: 'qwen',
    name: '通义千问',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    docUrl: 'https://help.aliyun.com/zh/model-studio',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelListEndpoint: '/models',
    authHeaderPrefix: 'Bearer',
    defaultModel: 'qwen-plus',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
  },
  {
    id: 'zhipu',
    name: '智谱',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docUrl: 'https://open.bigmodel.cn/dev/api',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelListEndpoint: '',
    authHeaderPrefix: 'Bearer',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4-air', 'glm-4-long'],
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    apiKeyUrl: 'https://ollama.com',
    docUrl: 'https://github.com/ollama/ollama/blob/main/README.md',
    defaultBaseUrl: 'http://localhost:11434',
    modelListEndpoint: '/api/tags',
    authHeaderPrefix: '',
    defaultModel: 'llama3.1',
    models: ['llama3.1', 'qwen2.5', 'deepseek-r1', 'gemma3', 'mistral'],
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export interface ProviderConfig {
  id: string;
  /** 提供商预设名（如 DeepSeek），与 displayName 分开，便于按类型识别 */
  name: string;
  /** 用户可自定义的显示名称（同服务商可建多条凭证时区分，如「DeepSeek Flash」） */
  displayName?: string;
  providerId: string;
  baseURL: string;
  /** 加密后的 Key（ivBase64.payloadBase64），持久化用；永不以明文落盘 */
  apiKeyEnc?: string;
  /** 内存中的明文 Key，仅存在于运行时，绝不持久化 */
  apiKey?: string;
  model: string;
  status: 'unconfigured' | 'testing' | 'ok' | 'error';
  statusText?: string;
  /** 创建时间 ISO 字符串，凭证目录按此排序 */
  createdAt?: string;
}

export function genId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 拉取指定提供商的模型列表，5s 本地超时。
 * - OpenAI 系（openai/qwen/deepseek）：GET `{base}<endpoint>` → { data:[{id}] }
 * - ollama：GET `{base}/api/tags` → { models:[{name}] }
 * - 无公开 /models 的提供商（如智谱）：直接返回预设静态列表。
 * 实时拉取失败时，若预设提供精选列表则回退到该列表（返回并带提示），否则抛出带状态码与提示的 Error。
 */
export async function fetchModels(
  baseURL: string,
  apiKey: string,
  preset: ProviderPreset
): Promise<{ models: string[]; fallback?: boolean }> {
  const fallback = (): { models: string[]; fallback: boolean } => ({
    models: preset.models ? [...preset.models] : [],
    fallback: !!preset.models,
  });

  if (preset.models && preset.models.length && !preset.modelListEndpoint) {
    // 无 /models 端点，直接返回静态精选列表
    return { models: [...preset.models] };
  }

  const base = baseURL.trim().replace(/\/+$/, '');
  const url = `${base}${preset.modelListEndpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (preset.authHeaderPrefix && apiKey) {
    headers.Authorization = `${preset.authHeaderPrefix} ${apiKey}`;
  }

  try {
    // 经统一 httpFetch：Tauri 桌面由 Rust 侧发出请求，避免 WebView CORS/CSP 拦截
    const res = await httpFetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}：${res.status === 401 || res.status === 403
          ? '请检查 Key 是否有效或是否有权限访问模型列表。'
          : '无法获取模型列表，请检查 Base URL 是否正确。'}`
      );
    }
    const json = await res.json();
    const models = parseModels(json);
    if (models.length) return { models };
    // 实时返回为空 → 回退精选列表
    return fallback();
  } catch (e) {
    if (e instanceof Error && /^HTTP \d+/.test(e.message)) {
      return fallback();
    }
    if ((e as Error).name === 'AbortError') {
      return fallback();
    }
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 openai 风格 /models 与 ollama /api/tags 两种返回 */
function parseModels(json: unknown): string[] {
  const anyJson = json as {
    data?: unknown[];
    models?: unknown[];
  };
  if (Array.isArray(anyJson?.data)) {
    const ids = anyJson.data
      .map((m) => (m as { id?: unknown })?.id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length) return ids;
  }
  if (Array.isArray(anyJson?.models)) {
    const names = anyJson.models
      .map((m) => {
        const mm = m as { name?: unknown; model?: unknown };
        return typeof mm.name === 'string' ? mm.name : typeof mm.model === 'string' ? mm.model : '';
      })
      .filter((v): v is string => v.length > 0);
    if (names.length) return names;
  }
  return [];
}

/**
 * 获取某服务商可选的所有 Base URL 形态。
 * 若预设未声明 baseUrlVariants，则回退为仅「默认」一项目（url 即 defaultBaseUrl），保证全局行为一致。
 */
export function getBaseUrlVariants(preset?: ProviderPreset): { label: string; url: string }[] {
  if (preset?.baseUrlVariants?.length) return preset.baseUrlVariants;
  return preset ? [{ label: '默认', url: preset.defaultBaseUrl }] : [];
}

/**
 * 根据 Base URL 前缀反向识别服务商 id。
 * 命中 defaultBaseUrl 或任一 baseUrlVariants 前缀即判定归属；无法命中返回 null（视为自定义地址）。
 * 用于对手动修改的地址给出「已偏离 / 按自定义处理」的轻提示。
 */
export function detectProviderId(baseURL: string): string | null {
  const url = baseURL.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  for (const p of PROVIDER_PRESETS) {
    if (url.startsWith(p.defaultBaseUrl)) return p.id;
    if (p.baseUrlVariants?.some((v) => url.startsWith(v.url))) return p.id;
  }
  return null;
}