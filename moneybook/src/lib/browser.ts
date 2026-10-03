import { toast } from 'sonner';
import { openExternal } from './update';

/**
 * 应用内置浏览器：在 Tauri 内新建/复用一个独立 WebviewWindow 打开外部链接
 * （如 GitHub Releases 下载页、AI 服务商 Key 获取页 / 文档页）。
 *
 * 背景：此前外链统一走 openExternal（Rust rundll32 唤起系统默认浏览器），
 * 部分环境点击无反应，且用户希望在应用内直接查看。内置浏览器方案：
 *  - Tauri 下：复用固定 label 的独立窗口（app-browser），重复点击只换地址不叠窗；
 *  - 非 Tauri（浏览器预览）：回退 window.open；
 *  - 内置窗口创建/导航失败：自动回退系统浏览器（openExternal），保证链接始终可达。
 * 窗口权限见 src-tauri/capabilities/default.json（core:window/core:webview 的 allow-create 等）。
 */
export async function openInAppBrowser(url: string): Promise<void> {
  if (!url) return;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const LABEL = 'app-browser';
  try {
    // Tauri 2 前端无「导航已有 WebviewWindow」的 API，故复用策略为：关掉旧窗再重建（点击频率低，重建成本可接受）。
    const existing = await WebviewWindow.getByLabel(LABEL);
    if (existing) {
      try { await existing.close(); } catch { /* 关闭失败则继续创建，新窗口 label 冲突会失败并回退 */ }
    }
    const win = new WebviewWindow(LABEL, {
      url,
      title: '外部网页',
      width: 980,
      height: 760,
      minWidth: 640,
      minHeight: 480,
      center: true,
      resizable: true,
    });
    // 创建成功/失败事件：失败（如权限缺失）则回退系统浏览器，链接仍可达
    win.once('tauri://created', async () => {
      try { await win.setFocus(); } catch { /* 聚焦失败不阻断 */ }
    });
    win.once('tauri://error', () => {
      void openExternal(url);
      toast.info('应用内置窗口打开失败，已改用系统浏览器打开。');
    });
  } catch (e) {
    console.warn('[内置浏览器] 打开失败，回退系统浏览器：', e);
    void openExternal(url);
  }
}
