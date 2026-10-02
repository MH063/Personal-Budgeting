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
  installUpdate,
  markAutoChecked,
  shouldAutoCheck,
  type ReleaseInfo,
} from '@/lib/update';
import { formatAppVersion } from '@/lib/appVersion';

/** 应用内更新的阶段状态机（UpdateDialog 按此渲染） */
export type UpdatePhase = 'idle' | 'downloading' | 'installing' | 'error';

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
  /** 立即更新（应用内）：下载 → 签名校验 → 安装 → 自动重启 */
  install: () => Promise<void>;
  /** 关闭弹窗；下载/安装进行中不生效（防打断），否则顺带重置更新状态 */
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
    // 关键位置日志：便于排查「检查更新无反应」类问题
    // eslint-disable-next-line no-console
    console.log('[update] 手动检查更新，本地版本', formatAppVersion());
    const r = await checkForUpdate();
    set({ checking: false });
    switch (r.kind) {
      case 'available':
        set({ open: true, info: r.info });
        toast.success(`发现新版本 V${r.info.version}`);
        break;
      case 'latest':
        toast.success(`当前已是最新版本 ${formatAppVersion()}`);
        break;
      case 'none':
        toast.info('暂未检测到正式发布版本，请稍后再试');
        break;
      case 'error':
        // message 已是友好文案（含重试/手动安装出路），直接展示，不再拼缀技术细节
        toast.error(r.message);
        break;
    }
  },

  checkSilently: async () => {
    // 浏览器预览环境（非 Tauri）下 GitHub 更新接口不可达且无法应用内更新，
    // 直接跳过自动扫描，避免控制台出现 net::ERR_FAILED 噪音（打包为桌面应用后才会真正检查）。
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) return;
    // 已有弹窗/正在检查时不重复发起；未到 24h 节流窗口直接跳过
    if (get().checking || get().open) return;
    if (!shouldAutoCheck()) return;
    const r = await checkForUpdate();
    // 网络失败：不打扰用户、也不写节流时间戳——下次启动会自然重试
    if (r.kind === 'error') {
      // eslint-disable-next-line no-console
      console.warn('[update] 自动检查失败（静默）：', r.message);
      return;
    }
    markAutoChecked();
    if (r.kind === 'available') set({ open: true, info: r.info });
  },

  install: async () => {
    const { info, phase } = get();
    if (!info) return;
    // 防重复触发：下载中/安装中再次点击直接忽略
    if (phase === 'downloading' || phase === 'installing') return;
    set({ phase: 'downloading', downloaded: 0, total: 0, error: null });
    // 关键位置日志：便于排查「点更新后无反应 / 卡住」类问题
    // eslint-disable-next-line no-console
    console.log('[update] 开始应用内更新，目标版本 V' + info.version);
    try {
      await installUpdate(info.version, {
        onProgress: (downloaded, total) => set({ downloaded, total }),
        onInstalling: () => set({ phase: 'installing' }),
      });
      // 走到这里说明进程未随安装重启（异常兜底路径）：回到空闲态，由用户决定后续
      set({ phase: 'idle' });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[update] 应用内更新失败：', e);
      // 错误归一化为友好文案（不暴露 undefined / 技术细节），供弹窗错误态展示
      set({ phase: 'error', error: friendlyUpdateError(e) });
    }
  },

  close: () => {
    const { phase } = get();
    // 下载/安装进行中禁止关闭：中途关闭会让用户误以为更新已取消（实际下载仍在继续），
    // 且 Windows 安装器一旦启动应用本就会退出，此时「关闭」并无实际意义
    if (phase === 'downloading' || phase === 'installing') return;
    set({ open: false, phase: 'idle', downloaded: 0, total: 0, error: null });
  },
}));