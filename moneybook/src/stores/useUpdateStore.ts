// 更新检查 + 应用内一键更新的全局单例状态
// ---------------------------------------------------------------------------
// 「关于系统」页的手动检查与启动时的自动扫描共用同一个结果弹窗（UpdateDialog），
// 避免两处各自维护一套状态导致提示不一致。
// 自动扫描严格静默：无新版本、无发布、网络失败都不打扰用户；只有「有新正式版」
// 才会弹出确认框，由用户选择 立即更新 / 稍后提醒 / 跳过此版本。
// 「立即更新」为应用内真实更新：下载（带进度）→ Rust 侧签名校验 → 静默安装 →
// 自动重启（详见 lib/update.ts 的 installUpdate）；下载/安装期间禁止关闭弹窗，
// 防止打断关键流程。
import { create } from 'zustand';
import { toast } from 'sonner';
import {
  checkForUpdate,
  friendlyUpdateError,
  downloadUpdate,
  applyUpdate,
  markAutoChecked,
  shouldAutoCheck,
  type ReleaseInfo,
} from '@/lib/update';
import { formatAppVersion } from '@/lib/appVersion';
import { isTauriRuntime } from '@/lib/runtime';

/** 应用内更新的阶段状态机（UpdateDialog 按此渲染） */
export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'installing' | 'error';

interface UpdateStore {
  /** 结果弹窗是否打开 */
  open: boolean;
  /** 手动检查进行中（按钮 loading 态） */
  checking: boolean;
  /** 弹窗展示的新版本信息 */
  info: ReleaseInfo | null;
  /** 应用内更新阶段 */
  phase: UpdatePhase;
  /** 已下载字节数（downloading 阶段进度显示） */
  downloaded: number;
  /** 更新包总字节数（0 = 服务端未提供长度，仅展示已下载量） */
  total: number;
  /** 安装失败信息（phase === 'error' 时展示） */
  error: string | null;
  /** 关于页「检查更新」：全量反馈（发现新版本 / 已最新 / 尚无发布 / 失败） */
  checkManually: () => Promise<void>;
  /** 启动自动扫描：静默执行，仅在有新版时弹窗；24h 节流 */
  checkSilently: () => Promise<void>;
  /** 触发后台下载 */
  download: () => Promise<void>;
  /** 触发安装并重启 */
  apply: () => Promise<void>;
  /** 强制打开更新弹窗（例如点击顶部状态栏的准备就绪图标时） */
  openDialog: () => void;
  /** 关闭弹窗，支持后台化。如果在安装阶段则拦截关闭 */
  close: () => void;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  open: false,
  checking: false,
  info: null,
  phase: 'idle',
  downloaded: 0,
  total: 0,
  error: null,

  checkManually: async () => {
    if (get().checking) return;
    set({ checking: true });
    // eslint-disable-next-line no-console
    console.log('[update] 手动检查更新，本地版本', formatAppVersion());
    const r = await checkForUpdate();
    set({ checking: false });
    switch (r.kind) {
      case 'available':
        set({ open: true, info: r.info });
        if (get().phase === 'idle') toast.success(`发现新版本 V${r.info.version}`);
        break;
      case 'latest':
        toast.success(`当前已是最新版本 ${formatAppVersion()}`);
        break;
      case 'none':
        toast.info('暂未检测到正式发布版本，请稍后再试');
        break;
      case 'error':
        toast.error(r.message);
        break;
    }
  },

  checkSilently: async () => {
    if (!isTauriRuntime()) return;
    if (get().checking || get().open) return;
    if (!shouldAutoCheck()) return;
    const r = await checkForUpdate();
    if (r.kind === 'error') {
      // eslint-disable-next-line no-console
      console.warn('[update] 自动检查失败（静默）：', r.message);
      return;
    }
    markAutoChecked();
    if (r.kind === 'available') set({ open: true, info: r.info });
  },

  download: async () => {
    const { info, phase } = get();
    if (!info) return;
    // 防重复触发
    if (phase === 'downloading' || phase === 'ready' || phase === 'installing') return;
    set({ phase: 'downloading', downloaded: 0, total: 0, error: null });
    // eslint-disable-next-line no-console
    console.log('[update] 开始后台下载更新包 V' + info.version);
    try {
      await downloadUpdate(info.version, {
        onProgress: (downloaded, total) => set({ downloaded, total }),
        onReady: () => {
          set({ phase: 'ready' });
          toast.success('新版本已下载就绪，点击右上角图标即可安装');
        },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[update] 下载失败：', e);
      set({ phase: 'error', error: friendlyUpdateError(e) });
    }
  },

  apply: async () => {
    const { phase } = get();
    if (phase !== 'ready') return;
    set({ phase: 'installing' });
    try {
      await applyUpdate();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[update] 安装失败：', e);
      set({ phase: 'error', error: friendlyUpdateError(e) });
    }
  },

  openDialog: () => set({ open: true }),

  close: () => {
    const { phase } = get();
    // 安装进行中禁止关闭，避免应用状态不可知
    if (phase === 'installing') return;
    set({ open: false });
    // 若在空闲或报错状态，顺带重置（下载中或 ready 状态则保留进度）
    if (phase === 'idle' || phase === 'error') {
      set({ phase: 'idle', downloaded: 0, total: 0, error: null });
    }
  },
}));