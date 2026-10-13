/**
 * 运行时环境检测（全应用唯一实现）。
 * ---------------------------------------------------------------------------
 * 背景（历史重复）：此前「是否 Tauri 桌面运行时」的判断以不同写法散落在十余个文件里
 * （kv / db / startup / export / http / ocr / update / browser / useUpdateStore 及各设置页），
 * 既有 `'__TAURI_INTERNALS__' in window` 也有 `window.__TAURI_INTERNALS__ !== undefined` 两种口径。
 * 口径分裂直接导致过真实故障（如偏好持久化路径判断不一致），故收敛到此处唯一实现。
 *
 * 为什么记忆化：`__TAURI_INTERNALS__` 由 Tauri 在 WebView 启动时注入，进程生命周期内不变，
 * 缓存一次可省去高频调用（db 的每次 select/execute）重复探测；与旧 db.isBrowserPreview 语义一致。
 *
 * 语义：
 *  - isTauriRuntime()   —— 桌面运行时（存在 IPC 全局对象），数据库/原生能力可用；
 *  - isBrowserPreview() —— 纯浏览器 vite 预览，数据库不可达时各 API 降级为空态。
 */

let cached: boolean | null = null;

/** 是否处于 Tauri 桌面运行时（存在 IPC 全局对象 `__TAURI_INTERNALS__`）。 */
export function isTauriRuntime(): boolean {
  if (cached === null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cached = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
  }
  return cached;
}

/** 是否处于纯浏览器预览（非 Tauri 桌面运行时）。 */
export function isBrowserPreview(): boolean {
  return !isTauriRuntime();
}
