// 更新检查（GitHub Releases）
// ---------------------------------------------------------------------------
// 设计（用户确认的方案）：
//   1) 更新仓库内置，用户不可修改——避免「填错仓库导致检查失效」这类支持成本；
//   2) 只认「正式版」：tag 必须是三段 x.y.z（可带 v 前缀）；四段测试版（1.0.0.1）
//      与带后缀的预发布（1.0.0-rc.1）一律跳过——与发布规则「stable 渠道只收无后缀
//      正式版」严格一致，确保任何用户都不会被引导安装半成品；
//   3) 网络请求只访问 GitHub 公开 API，不携带任何本机数据，不涉及隐私；
//   4) 检查入口有两处：关于页手动点击、启动时自动扫描（24h 节流）；发现新版本后
//      由用户确认（立即更新 / 稍后提醒 / 跳过此版本），绝不静默安装；
//   5) GitHub 不可达时的兜底（国内网络常见）：
//      - 检查带 15s 超时 + 错误归一化为友好文案（不暴露 undefined）；
//      - 失败不写自动扫描节流时间戳 → 下次启动自动重试；手动按钮随时可重试；
//      - 任何时候都可走「手动安装」路径：从下载页/他人转发/U盘等任意渠道获取
//        新版本安装包双击覆盖安装，NSIS 覆盖安装保留本机账本数据——应用内
//        一键更新需要网络，但手动更新永远可用。
import { getKV, setKV } from '@/api/kv';
import { httpFetch } from '@/lib/http';
// 纯函数统一放在 lib/version.ts（正式版过滤 + 版本比较），便于单测直接引用、无需加载 kv 依赖链
import { compareVersion, parseStableTag } from '@/lib/version';
import { APP_VERSION } from '@/lib/appVersion';
import { toast } from 'sonner';

/** 内置更新仓库（唯一来源；GitHub Releases 必须发正式版才能被检查到） */
export const UPDATE_REPO_SLUG = 'MH063/Personal-Budgeting';
/** Releases 页面（「立即更新」跳转目标：最新的正式发布） */
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO_SLUG}/releases/latest`;

/** 跳过版本的记录键（就不想提醒的某个版本，永久静默） */
const SKIP_VERSION_KEY = 'kv.update.skipVersion';
/** 上次自动检查时间戳（毫秒字符串），用于 24h 节流 */
const LAST_CHECK_KEY = 'kv.update.lastCheck';

/** 启动自动检查节流间隔：24 小时（进入应用时最多每天扫描一次） */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 更新检查超时（毫秒）：GitHub 不可达（国内网络常见）时 15s 内返回，避免界面长时间无反馈 */
const FETCH_TIMEOUT_MS = 15 * 1000;

/** 远端正式版信息 */
export interface ReleaseInfo {
  /** 正式三段版本号（已去掉 tag 的 v 前缀） */
  version: string;
  /** Release 页面地址 */
  url: string;
  /** 更新说明（截断，避免超长内容撑爆弹窗） */
  notes: string;
  /** 发布时间（ISO 字符串） */
  publishedAt: string;
}

/** 检查结果（kind 覆盖所有分支，界面据此给精确反馈） */
export type UpdateCheckResult =
  | { kind: 'available'; info: ReleaseInfo }
  | { kind: 'latest' }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

/**
 * 拉取最新正式版（GitHub 按创建时间倒序返回 Releases）：
 * 跳过 draft / prerelease / 非正式版 tag，返回第一个符合的发布；无正式发布返回 null。
 * 带超时控制：GitHub 不可达时 15s 内返回，失败由上层（friendlyUpdateError）归一化为友好提示。
 */
export async function fetchLatestStableRelease(): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await httpFetch(`https://api.github.com/repos/${UPDATE_REPO_SLUG}/releases?per_page=20`, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub 接口返回 HTTP ${res.status}`);
    const list = (await res.json()) as Array<{
      tag_name?: string;
      html_url?: string;
      body?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    if (!Array.isArray(list)) return null;
    for (const r of list) {
      if (r.draft || r.prerelease) continue;
      const v = parseStableTag(r.tag_name ?? '');
      if (!v) continue;
      return {
        version: v,
        url: String(r.html_url ?? UPDATE_RELEASES_PAGE),
        notes: String(r.body ?? '').slice(0, 800),
        publishedAt: String(r.published_at ?? ''),
      };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把更新相关异常归一化为「用户友好文案」，绝不再把技术细节 / undefined 暴露给用户。
 * 背景：检查与安装的请求都走 httpFetch（Tauri 下由 Rust 侧发出），失败原因五花八门
 *（DNS / 断网 / 超时 / GitHub 不可达），部分异常 message 为 undefined，历史出现过
 * 界面显示「检查更新失败：undefined」。这里统一分类：
 *   - 超时 / 取消（AbortError）→ 网络提示；
 *   - 网络类关键词 → 网络提示 + 手动安装出路；
 *   - 其它 → 简短描述，空值兜底。
 */
export function friendlyUpdateError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return '连接更新服务器超时，请检查网络后重试';
  }
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/fetch|network|dns|econn|timeout|timed ?out|temporarily|connect/i.test(raw)) {
    return '无法连接更新服务器（GitHub 可能暂时不可达），请检查网络后重试；也可前往下载页手动安装新版本';
  }
  return raw || '更新服务暂时不可用，请稍后重试';
}

/**
 * 检查更新（手动 / 自动共用）。
 * 顺序：拉取最新正式版 → 与本地版本比较 → 过滤「已跳过版本」。
 * 本地版本取 appVersion.ts 的三段（与安装包同步）；比较逻辑复用 compareVersion。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const info = await fetchLatestStableRelease();
    if (!info) return { kind: 'none' };
    if (compareVersion(info.version, APP_VERSION) <= 0) return { kind: 'latest' };
    if (getSkippedVersion() === info.version) return { kind: 'latest' }; // 已跳过：视为已是最新，不再打扰
    return { kind: 'available', info };
  } catch (e) {
    // 网络失败等异常统一归一化为友好文案（不暴露 undefined/技术细节），
    // 由界面提示用户「重试 / 前往下载页手动安装」——GitHub 不可达不影响手动更新路径
    return { kind: 'error', message: friendlyUpdateError(e) };
  }
}

/** 用户跳过某版本（永久静默该版本；后续更高版本仍会提醒） */
export function skipVersion(v: string): void {
  void setKV(SKIP_VERSION_KEY, v);
}

/** 读取已跳过的版本号（未设置返回空串） */
export function getSkippedVersion(): string {
  return getKV(SKIP_VERSION_KEY) || '';
}

/** 是否到达自动检查时间（24h 节流；时间戳缺失视为需要检查） */
export function shouldAutoCheck(): boolean {
  const last = Number(getKV(LAST_CHECK_KEY) || '0');
  if (!Number.isFinite(last) || last <= 0) return true;
  return Date.now() - last >= AUTO_CHECK_INTERVAL_MS;
}

/** 记录本次自动检查时间（节流锚点） */
export function markAutoChecked(): void {
  void setKV(LAST_CHECK_KEY, String(Date.now()));
}

/**
 * 在系统默认浏览器打开链接：Tauri 下走 Rust `open_url`（仅 https，防注入）；
 * 浏览器预览回退 window.open（预览环境无 IPC）。
 */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_url', { url });
  } catch (e) {
    toast.error(`打开链接失败：${(e as Error).message}`);
  }
}

// —— 应用内一键更新（下载 → 签名校验 → 安装 → 重启） ————————————————————

/** 应用内更新的阶段回调（驱动 UpdateDialog 的 UI 状态机） */
export interface UpdateInstallCallbacks {
  /** 下载进度：累计已下载字节 / 总字节（服务端未提供长度时 total 为 0） */
  onProgress?: (downloaded: number, total: number) => void;
  /** 下载完成、进入安装阶段（此后应用随时可能退出并由安装器重启） */
  onInstalling?: () => void;
}

/**
 * 应用内一键更新：在不离开本应用的情况下完成「下载 → 校验 → 安装 → 重启」。
 *
 * 安全链说明（为什么可以放心一键装）：
 *   1) 更新清单来自内置 endpoint（tauri.conf.json 的 plugins.updater.endpoints，
 *      指向 GitHub Release 中的 latest.json），请求由 Rust 侧发出，不受 WebView 限制；
 *   2) 安装包下载后由 Rust 侧用内置公钥（plugins.updater.pubkey）校验 minisign 签名，
 *      签名不符直接抛错 —— 任何伪造/篡改的包都不可能被安装；
 *   3) expectedVersion 是弹窗展示的版本（来自 GitHub API 检查结果）。正常发布流程下
 *      两者必然一致（同一次 CI 从同一 Release 生成清单与安装包）；若不一致说明发布
 *      数据不同步，此时拒绝安装并提示手动下载，避免「展示版本与实装版本不符」。
 *
 * 平台行为：
 *   - Windows：downloadAndInstall 启动 NSIS 安装器后本进程自动退出，安装器装完
 *     自动重启（插件默认 restartAfterInstall=true），后续 relaunch() 不会被执行；
 *   - macOS/Linux：下载安装后由本函数调用 relaunch() 重启进入新版本。
 *
 * 非 Tauri 环境（浏览器预览）抛「不支持」错误，由调用方回退到「前往下载页」。
 */
export async function installUpdate(
  expectedVersion: string,
  callbacks: UpdateInstallCallbacks = {},
): Promise<void> {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) throw new Error('当前环境不支持应用内更新，请前往下载页手动安装');
  // 动态导入：仅在真正执行安装时才加载插件模块（浏览器预览零副作用）
  const [{ check }, { relaunch }] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ]);
  const update = await check();
  if (!update) {
    throw new Error('更新源暂未就绪（未获取到可安装的更新包），请稍后重试或前往下载页');
  }
  if (update.version !== expectedVersion) {
    // 拿到资源但不安装：显式释放 Rust 侧持有的更新资源，避免泄漏
    await update.close();
    throw new Error(
      `更新源版本不一致（页面 V${expectedVersion} / 更新源 V${update.version}），请前往下载页手动安装`,
    );
  }
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        callbacks.onProgress?.(downloaded, total);
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        callbacks.onProgress?.(downloaded, total);
        break;
      case 'Finished':
        callbacks.onInstalling?.();
        break;
    }
  });
  // Windows 上安装器启动后本进程已退出，走不到这里；macOS/Linux 在此重启进入新版本
  await relaunch();
}