/**
 * 知识库 store：维护若干「参考知识/规则」文本条目，持久化于 localStorage。
 * 这些条目会在构建 AI 请求的 system 消息时拼入（见 llm.ts），作用于所有对话/补全，
 * 作为 AI 分析的参考资料。仅本地保存，绝不外发到除所配置 AI 端点以外的任何地方。
 */
import { create } from 'zustand';
import { getRawKV, setKV, removeKV, hydrateKV } from '@/api/kv';
import { KNOWLEDGE_KEY } from '@/lib/constants';

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

const STORAGE_KEY = KNOWLEDGE_KEY;

interface KnowledgeStore {
  entries: KnowledgeEntry[];
  add: (entry: Omit<KnowledgeEntry, 'id' | 'updatedAt'>) => string;
  update: (id: string, patch: Partial<Pick<KnowledgeEntry, 'title' | 'content'>>) => void;
  remove: (id: string) => void;
  /** 从数据库 settings 表重载知识条目（应用启动 hydrate 后调用） */
  hydrate: () => void;
  reset: () => void;
}

function genId(): string {
  return (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ??
    `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function load(): KnowledgeEntry[] {
  try {
    // 从数据库 settings 表（kv.knowledge）读取，不再使用 localStorage
    const raw = getRawKV(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as KnowledgeEntry[]).filter(
      (e) => e && typeof e.title === 'string' && typeof e.content === 'string'
    );
  } catch {
    return [];
  }
}

const persisted = load();

function persist(get: () => KnowledgeStore) {
  try {
    // 写入数据库 settings 表（异步落库；失败不影响本次会话）
    setKV(STORAGE_KEY, JSON.stringify(get().entries));
  } catch {
    /* 存储失败不影响本次会话 */
  }
}

export const useKnowledgeStore = create<KnowledgeStore>((set, get) => ({
  entries: persisted,

  add: (entry) => {
    const id = genId();
    const item: KnowledgeEntry = {
      ...entry,
      id,
      updatedAt: new Date().toISOString(),
    };
    set((s) => ({ entries: [...s.entries, item] }));
    persist(get);
    return id;
  },

  update: (id, patch) => {
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id
          ? { ...e, ...patch, updatedAt: new Date().toISOString() }
          : e
      ),
    }));
    persist(get);
  },

  remove: (id) => {
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    persist(get);
  },

  hydrate: () => {
    set({ entries: load() });
  },

  reset: () => {
    removeKV(STORAGE_KEY);
    set({ entries: [] });
  },
}));