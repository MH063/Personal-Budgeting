import { create } from 'zustand';
import { encryptText, decryptText } from '@/api/encrypt';
import { getRawKV, setKV, removeKV, hydrateKV } from '@/api/kv';
import { AI_CONFIG_KEY } from '@/lib/constants';
import {
  genId,
  getPreset,
  PROVIDER_PRESETS,
  fetchModels,
  type ProviderConfig,
  type ProviderPreset,
} from '@/api/providers';

export interface AIConfig {
  enabled: boolean;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 是否允许向 AI 服务发送交易明细（备注等）。默认关闭，只发汇总统计，隐私优先。 */
  allowDetail: boolean;
  /** 推理参数（全局，作用于所有聊天/补全调用） */
  temperature: number;
  topP: number | null;
  maxTokens: number | null;
}

const STORAGE_KEY = AI_CONFIG_KEY;

interface PersistedState {
  version: 2;
  enabled: boolean;
  allowDetail: boolean;
  activeProviderId: string;
  /** apiKey 字段不参与持久化（仅内存），只写 apiKeyEnc */
  providers: Array<Omit<ProviderConfig, 'apiKey'>>;
  /** 推理参数；load() 已统一回填默认值，故为非可选 */
  temperature: number;
  topP: number | null;
  maxTokens: number | null;
}

/** 从持久化数据剔除内存态明文 apiKey */
function stripKey(p: ProviderConfig): Omit<ProviderConfig, 'apiKey'> {
  const { apiKey: _omit, ...rest } = p;
  return rest;
}

/** 兼容旧的单配置结构 {enabled,baseURL,apiKey,model,allowDetail}，迁移为 providers[0] */
function legacyToProviders(old: Record<string, unknown>): PersistedState {
  const baseURL = typeof old.baseURL === 'string' ? old.baseURL : '';
  const apiKey = typeof old.apiKey === 'string' ? old.apiKey : '';
  const model = typeof old.model === 'string' ? old.model : '';
  const preset = PROVIDER_PRESETS.find((p) => baseURL.startsWith(p.defaultBaseUrl));
  const providerId = preset?.id ?? 'unknown';

  const provider: ProviderConfig = {
    id: genId(),
    name: preset?.name ?? '自定义',
    providerId,
    baseURL,
    apiKey,
    apiKeyEnc: '',
    model,
    status: apiKey ? 'ok' : 'unconfigured',
  };

  return {
    version: 2,
    enabled: Boolean(old.enabled),
    allowDetail: Boolean(old.allowDetail),
    activeProviderId: provider.id,
    providers: [stripKey(provider)],
    temperature: DEFAULT_AI_PARAMS.temperature,
    topP: DEFAULT_AI_PARAMS.topP,
    maxTokens: DEFAULT_AI_PARAMS.maxTokens,
  };
}

/** 默认推理参数 */
export const DEFAULT_AI_PARAMS = {
  temperature: 0.5,
  topP: null as number | null,
  maxTokens: null as number | null,
};

/** 从持久化字段解析某个推理参数；非法值回退到默认 */
function pickParam(p: Record<string, unknown>, key: string, fallback: number | null): number | null {
  const v = (p as Record<string, unknown>)[key];
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultsPersisted(): PersistedState {
  return {
    version: 2,
    enabled: false,
    allowDetail: false,
    activeProviderId: '',
    providers: [],
    temperature: DEFAULT_AI_PARAMS.temperature,
    topP: DEFAULT_AI_PARAMS.topP,
    maxTokens: DEFAULT_AI_PARAMS.maxTokens,
  };
}

function load(): PersistedState {
  try {
    // 从数据库 settings 表（kv.ai）读取，不再使用 localStorage
    const raw = getRawKV(STORAGE_KEY);
    if (!raw) return defaultsPersisted();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed.providers)) {
      return {
        version: 2,
        enabled: Boolean(parsed.enabled),
        allowDetail: Boolean(parsed.allowDetail),
        activeProviderId: typeof parsed.activeProviderId === 'string' ? parsed.activeProviderId : '',
        providers: parsed.providers as Array<Omit<ProviderConfig, 'apiKey'>>,
        temperature: pickParam(parsed, 'temperature', DEFAULT_AI_PARAMS.temperature) ?? DEFAULT_AI_PARAMS.temperature,
        topP: pickParam(parsed, 'topP', DEFAULT_AI_PARAMS.topP),
        maxTokens: pickParam(parsed, 'maxTokens', DEFAULT_AI_PARAMS.maxTokens),
      };
    }
    // 旧单配置 → 迁移
    return legacyToProviders(parsed);
  } catch {
    return defaultsPersisted();
  }
}

const persisted = load();

interface AIStore {
  enabled: boolean;
  allowDetail: boolean;
  activeProviderId: string;
  providers: ProviderConfig[];
  temperature: number;
  topP: number | null;
  maxTokens: number | null;
  addProvider: (preset: ProviderPreset) => string;
  /** 更新提供商。patch.apiKey 为明文时自动加密后再持久化；apiKey 仅存内存。 */
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => Promise<void>;
  removeProvider: (id: string) => boolean;
  setActiveProvider: (id: string) => void;
  setEnabled: (v: boolean) => void;
  setAllowDetail: (v: boolean) => void;
  /** 更新推理参数（temperature / topP / maxTokens），立即持久化 */
  setAiParams: (p: { temperature?: number; topP?: number | null; maxTokens?: number | null }) => void;
  /** 从数据库 settings 表重载偏好（由应用启动 hydrate 后调用，恢复持久化的凭证/参数） */
  hydrate: () => void;
  reset: () => void;
  /** 服务商真实模型列表缓存（按 providerId 索引；仅内存，不持久化，打开弹窗时拉取刷新） */
  modelCache: Record<string, string[]>;
  /** 拉取指定服务商的真实模型列表并缓存；失败时保留预设精选列表兜底，不打扰用户 */
  loadModels: (providerId: string, baseURL: string, apiKey: string) => Promise<void>;
}

/** 把持久化凭证映射为内存态 ProviderConfig（磁盘中不存明文 apiKey） */
function mapProviders(p: PersistedState): ProviderConfig[] {
  return (p.providers as ProviderConfig[]).map((c) => {
    const casted = c as ProviderConfig;
    // 磁盘中的 providerId 可能因预设调整失效，回退到陌生人；baseURL 缺失则回退默认
    const preset = getPreset(casted.providerId);
    return {
      ...casted,
      providerId: preset ? casted.providerId : 'unknown',
      baseURL: casted.baseURL || preset?.defaultBaseUrl || '',
      displayName: casted.displayName || casted.name || preset?.name || '自定义凭证',
      createdAt: casted.createdAt || '',
      apiKey: '',
    };
  });
}

function persist(get: () => AIStore) {
  const s = get();
  const out: PersistedState = {
    version: 2,
    enabled: s.enabled,
    allowDetail: s.allowDetail,
    activeProviderId: s.activeProviderId,
    providers: s.providers.map(stripKey),
    temperature: s.temperature,
    topP: s.topP,
    maxTokens: s.maxTokens,
  };
  try {
    // 写入数据库 settings 表（异步落库；失败不影响本次会话）
    setKV(STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* 存储失败不影响本次会话 */
  }
}

export const useAIStore = create<AIStore>((set, get) => ({
    enabled: persisted.enabled,
    allowDetail: persisted.allowDetail,
    activeProviderId: persisted.activeProviderId,
    temperature: persisted.temperature,
    topP: persisted.topP,
    maxTokens: persisted.maxTokens,
    providers: mapProviders(persisted),
    modelCache: {},

    addProvider: (preset) => {
      const id = genId();
      const now = new Date().toISOString();
      const provider: ProviderConfig = {
        id,
        name: preset.name,
        displayName: preset.name,
        providerId: preset.id,
        baseURL: preset.defaultBaseUrl,
        apiKey: '',
        apiKeyEnc: '',
        model: '',
        status: 'unconfigured',
        createdAt: now,
      };
      // 新增凭证不再自动设为「当前使用」（用户要求）：用哪个模型由用户后续显式选择，
      // 避免配置尚未完成的凭证被立刻用于 AI 调用；未显式选择时 readAIConfig 回退到
      // 目录中最早创建的一条（providers[0]），因此新增凭证不会改变既有生效项。
      set((s) => ({ providers: [...s.providers, provider] }));
      persist(get);
      return id;
    },

    updateProvider: async (id, patch) => {
      const store = get();
      const idx = store.providers.findIndex((p) => p.id === id);
      if (idx === -1) return;
      const cur = store.providers[idx];

      let apiKeyEnc = cur.apiKeyEnc;
      let apiKey = cur.apiKey;
      if ('apiKey' in patch) {
        apiKey = patch.apiKey ?? '';
        apiKeyEnc = apiKey ? await encryptText(apiKey) : '';
      }

      const next: ProviderConfig = {
        ...cur,
        ...patch,
        apiKey,
        apiKeyEnc,
      };
      set((s) => ({
        providers: s.providers.map((p) => (p.id === id ? next : p)),
      }));
      persist(get);
    },

    removeProvider: (id) => {
      const store = get();
      const target = store.providers.find((p) => p.id === id);
      if (!target) return false;
      // 凭证目录 + 激活指针：真正生效的一条（显式激活，或未显式选择时回退的 providers[0]）
      // 在存在其他凭证时不可删除（需先切换到其他凭证），防止误删导致「当前无可用模型」。
      // 仅当这是唯一凭证时才允许删除（回到空配置，等价于重置）。
      // 保护口径必须与界面「当前」标签 / readAIConfig 的回退逻辑一致。
      const effectiveActiveId = store.activeProviderId || store.providers[0]?.id || '';
      if (store.providers.length > 1 && id === effectiveActiveId) return false;
      set((s) => {
        const providers = s.providers.filter((p) => p.id !== id);
        const activeProviderId = s.activeProviderId === id
          ? (providers[0]?.id ?? '')
          : s.activeProviderId;
        return { providers, activeProviderId };
      });
      persist(get);
      return true;
    },

    setActiveProvider: (id) => {
      set({ activeProviderId: id });
      persist(get);
    },

    setEnabled: (v) => {
      set({ enabled: v });
      persist(get);
    },

    setAllowDetail: (v) => {
      set({ allowDetail: v });
      persist(get);
    },

    setAiParams: (p) => {
      set((s) => ({
        temperature: p.temperature ?? s.temperature,
        topP: 'topP' in p ? p.topP : s.topP,
        maxTokens: 'maxTokens' in p ? p.maxTokens : s.maxTokens,
      }));
      persist(get);
    },

    hydrate: () => {
      // 应用启动载入偏好后调用：用持久化数据重建内存态（apiKey 仍留内存由下方解密流程回填）
      const p = load();
      set({
        enabled: p.enabled,
        allowDetail: p.allowDetail,
        activeProviderId: p.activeProviderId,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        providers: mapProviders(p),
      });
    },

    reset: () => {
      removeKV(STORAGE_KEY);
      set({ ...defaultsPersisted() } as unknown as Partial<AIStore>);
      // 重置后同时清空 providers 内存态
      set({ providers: [] });
    },

    loadModels: async (providerId, baseURL, apiKey) => {
      // 实时拉取服务商模型列表；结果覆盖该 providerId 的缓存（下拉据此展示真实模型）。
      // 无凭证 / 预设缺失 / 网络失败时静默保留精选列表兜底，不影响弹窗使用。
      const preset = getPreset(providerId);
      if (!preset) return;
      try {
        const { models } = await fetchModels(baseURL, apiKey, preset);
        if (models.length) {
          set((s) => ({ modelCache: { ...s.modelCache, [providerId]: models } }));
        }
      } catch {
        // 拉取失败：保持既有缓存或精选列表，静默处理
      }
    },
  }));

// 初始化后异步解密：把持久化的 apiKeyEnc 解密回内存明文，供 readAIConfig 同步读取
setTimeout(() => {
  (async () => {
    await hydrateKV();
    // 延迟一次以吸收首启 hydrate 后 store 初始值（首次即默认值），先用持久化数据重建再解密
    await Promise.resolve();
    const s = useAIStore.getState();
    s.hydrate();
    for (const p of useAIStore.getState().providers) {
      if (p.apiKeyEnc && !p.apiKey) {
        decryptText(p.apiKeyEnc)
          .then((k) => useAIStore.getState().updateProvider(p.id, { apiKey: k }))
          .catch(() => {
            // 解密失败（例如旧会话密钥已清空）则丢弃，等待重新填写
          });
      }
    }
  })();
}, 0);

/** 供非 React 模块（api/llm）同步读取最新配置，避免引入 store 依赖导致循环引用 */
export function readAIConfig(): AIConfig {
  const s = useAIStore.getState();
  const active = s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
  return {
    enabled: s.enabled,
    baseURL: active?.baseURL ?? '',
    apiKey: active?.apiKey ?? '',
    model: active?.model ?? '',
    allowDetail: s.allowDetail,
    temperature: s.temperature ?? DEFAULT_AI_PARAMS.temperature,
    topP: s.topP,
    maxTokens: s.maxTokens,
  };
}