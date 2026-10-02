import { create } from 'zustand';
import { toast } from 'sonner';
import { useAIStore } from '@/stores/useAIStore';
import { getRawKV, setKV, removeKV, hydrateKV } from '@/api/kv';
import type { AnalysisDimension } from '@/api/analysis';

/** 打开弹窗时可携带的分析锚点（来自月度体检：用户选定的月份与维度） */
export interface AssistantAnchor {
  month: string;
  dim: AnalysisDimension;
}

/** 对话消息（定义在 store：切换 Tab 或关闭弹窗后仍保留，支撑真正的连续对话） */
export interface AssistantChatMsg {
  role: 'user' | 'assistant';
  content: string;
  /** 回答来源标注：本地规则 / AI */
  source?: 'local' | 'ai';
  /** 流式生成中 */
  pending?: boolean;
}

/**
 * 全局 AI 助手弹窗的单例状态。
 * 全应用只挂载一个 AI 对话实例（AppShell 内），任何页面通过 openAssistant() 打开。
 * 合并动机：此前仪表盘 AI 助手、智能洞察「财务问答」、月度体检「AI 深度分析」各自
 * 独立调用 LLM，同一问题多处触发会重复消耗 Tokens；统一收敛为一个对话弹窗后，
 * 连续对话共享上下文，避免重复调用与重复计费。
 *
 * 持久化约定：对话历史按项目统一规则存入数据库 settings 表（kv 前缀），
 * 不使用 localStorage（见 api/kv.ts 头注释）；刷新 / 重启后由 hydrateChat() 恢复，
 * 用户未点「清空」时对话不丢。
 */
interface AiAssistantState {
  open: boolean;
  /** 最近一次打开时携带的分析锚点；关闭后清空（下次打开不携带旧月份） */
  anchor: AssistantAnchor | null;
  /** 对话历史提升到 store：ChatTab 会随 Tab 切换/弹窗关闭被卸载，放组件内会丢历史 */
  msgs: AssistantChatMsg[];
  setMsgs: (updater: AssistantChatMsg[] | ((prev: AssistantChatMsg[]) => AssistantChatMsg[])) => void;
  clearMsgs: () => void;
  openAssistant: (anchor?: AssistantAnchor) => void;
  closeAssistant: () => void;
  /** 从数据库恢复对话历史（幂等；由 AI 助手弹窗挂载时调用） */
  hydrateChat: () => Promise<void>;
}

/** settings 表 kv 键：AI 助手对话历史（与其它偏好项同前缀规则，落库不落 localStorage） */
const CHAT_KV_KEY = 'ai-assistant.msgs';
/** 持久化上限：最多保留最近 50 条，防止数据库行过大 */
const MAX_MSGS = 50;

/** 持久化前收口：生成中的消息标为「（已停止生成）」，避免刷新后残留打字光标 */
function settlePending(msgs: AssistantChatMsg[]): AssistantChatMsg[] {
  return msgs
    .map((m) => (m.pending ? { ...m, content: m.content || '（已停止生成）', pending: false } : m))
    .slice(-MAX_MSGS);
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
/** 防抖落库：流式更新期间合并写入 settings 表，避免每次增量触发一次数据库写 */
function schedulePersist(msgs: AssistantChatMsg[]) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void setKV(CHAT_KV_KEY, JSON.stringify(settlePending(msgs)));
  }, 300);
}

export const useAiAssistantStore = create<AiAssistantState>((set) => ({
  open: false,
  anchor: null,
  msgs: [],
  setMsgs: (updater) =>
    set((s) => {
      const msgs =
        typeof updater === 'function'
          ? (updater as (prev: AssistantChatMsg[]) => AssistantChatMsg[])(s.msgs)
          : updater;
      // 更新后防抖写库（settings 表），保证刷新后对话不丢
      schedulePersist(msgs);
      return { msgs };
    }),
  clearMsgs: () => {
    // 清空时同步取消待写定时器并从数据库删除，保证「清空」后重启也不再出现旧对话
    if (persistTimer) clearTimeout(persistTimer);
    void removeKV(CHAT_KV_KEY);
    set({ msgs: [] });
  },
  /**
   * 打开助手前先校验 AI 是否「已开启且已配置凭证」：
   * 未配置好时不打开弹窗，仅提示用户去设置页开启（用户反馈：未启用时打开助手没有意义）。
   * 守卫统一放在 store 层，顶栏按钮、全局快捷键、各页面入口一并生效。
   */
  openAssistant: (anchor) => {
    const ai = useAIStore.getState();
    // 生效凭证口径与 readAIConfig 保持一致：显式激活，或未显式选择时回退到第一条
    const active = ai.providers.find((p) => p.id === ai.activeProviderId) ?? ai.providers[0];
    if (!ai.enabled) {
      toast.info('AI 助手尚未开启：请先在「设置 → AI 助手」中打开开关并配置凭证');
      return;
    }
    if (!active?.apiKey) {
      toast.info('AI 凭证未配置完成：请先在「设置 → AI 助手」中填写接口地址与密钥');
      return;
    }
    set({ open: true, anchor: anchor ?? null });
  },
  closeAssistant: () => set({ open: false, anchor: null }),
  hydrateChat: async () => {
    // 先确保 kv 缓存已从数据库载入（幂等；App 启动时可能也在载入），再同步读取恢复
    await hydrateKV();
    const raw = getRawKV(CHAT_KV_KEY);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as AssistantChatMsg[];
      if (Array.isArray(saved) && saved.length) {
        set({ msgs: settlePending(saved) });
      }
    } catch {
      // 历史数据损坏时静默丢弃，不影响本次会话
    }
  },
}));
