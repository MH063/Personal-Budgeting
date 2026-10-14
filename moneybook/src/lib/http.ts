/**
 * 统一外部 HTTP 客户端
 * ------------------------------------------------------------------
 * 背景（问题根因）：「测试连接 / 刷新模型 / 查询余额」需要直连用户自填的第三方大模型
 * 接口（如 api.deepseek.com）。在 Tauri 桌面 WebView 中，直接用浏览器 fetch 会被两层
 * 机制拦截，表现为 "Failed to fetch" 且界面无法区分原因：
 *   1. CORS —— 多数大模型 API 不返回 Access-Control-Allow-Origin，浏览器直接拒绝响应；
 *   2. CSP  —— tauri.conf.json 的 default-src 'self' 未放行外部 connect-src。
 * 因此桌面运行时统一改走 @tauri-apps/plugin-http：请求由 Rust 侧（reqwest）发出，
 * 不受 CORS/CSP 约束；浏览器预览环境仍回退全局 fetch。
 * 注意：回退分支保留是为了浏览器预览与本地单测（providers.test.ts 依赖 stubGlobal('fetch')）。
 */

import { isTauriRuntime } from './runtime';

/**
 * 判断是否为「请求取消」错误。
 * 浏览器原生抛出 DOMException(AbortError)；Tauri 插件抛出 message 为 'Request cancelled'
 * 的普通 Error（见 @tauri-apps/plugin-http 源码常量），两者需统一识别。
 */
export function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  const err = e as { name?: string; message?: string };
  if (err.name === 'AbortError') return true;
  return /^request cancelled$/i.test(err.message ?? '');
}

/**
 * 统一 fetch 入口：Tauri 桌面走 Rust 侧插件（绕过 CORS/CSP），其他环境回退浏览器原生 fetch。
 * - 插件模块用动态 import，保证浏览器 / 单测环境不加载 Tauri 依赖；
 * - 回退分支每次动态读取 globalThis.fetch，兼容测试中的 vi.stubGlobal('fetch', ...)；
 * - 发出阶段的「取消」错误统一规范为 AbortError，便于上层静默处理用户取消。
 */
export async function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    try {
      return (await tauriFetch(input, init)) as Response;
    } catch (e) {
      if (isAbortError(e)) throw new DOMException('请求已取消', 'AbortError');
      // 关键位置日志：请求由 Rust 侧发出，失败原因（scope 未授权/网络不通/DNS）在此可见
      console.warn('[http] Rust 侧请求失败：', input, e);
      throw e;
    }
  }
  try {
    return await globalThis.fetch(input, init);
  } catch (e) {
    if (!isAbortError(e)) console.warn('[http] 浏览器请求失败（预览环境可能受 CORS 限制）：', input, e);
    throw e;
  }
}

/**
 * 「超时 + 外部取消」复合信号守卫。
 *
 * 背景（问题根因）：AI 对话请求此前没有超时，一旦服务端长时间不响应，界面会一直转圈无法恢复。
 * 这里统一提供超时能力，并额外区分两种中止语义，便于上层给出不同提示：
 *   - 超时中止（timedOut=true）→ 提示「请求超时，请重试」；
 *   - 外部取消（timedOut=false 但 signal 已 abort，如用户点停止/切换会话）→ 静默按取消处理。
 *
 * 实现说明：刻意不使用 `AbortSignal.timeout` / `AbortSignal.any`——部分 WebView（旧版 Windows
 * WebView2、旧版 macOS WKWebView）与旧 Node 尚未实现，直接调用会抛 TypeError；改用
 * AbortController + setTimeout 自行组合，兼容性最好。
 */
export interface TimeoutGuard {
  /** 传给 fetch 的信号（同时承载「超时中止」与「外部取消」） */
  signal: AbortSignal;
  /** 是否由超时触发中止（true=超时；false 且 signal.aborted 则为外部取消） */
  timedOut: () => boolean;
  /** 重置计时器：流式场景每次收到数据时调用，实现「空闲超时」而非「总时长超时」 */
  touch: () => void;
  /** 清理计时器与外部监听（请求结束务必调用，避免定时器泄漏） */
  cleanup: () => void;
}

/**
 * 构建可超时、可外部取消的 AbortSignal。
 * @param timeoutMs 超时毫秒数（对流式请求即「空闲超时」阈值）
 * @param external  外部取消信号（可选，用户停止/切换会话时级联中止本次请求）
 */
export function createTimeoutGuard(timeoutMs: number, external?: AbortSignal): TimeoutGuard {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // 计时到点：标记超时并中止请求
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  // 外部取消 → 级联中止（不计入超时，保留「用户取消」语义）
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  arm();

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    touch: () => { if (!timedOut) arm(); },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}