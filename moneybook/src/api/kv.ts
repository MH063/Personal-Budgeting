/**
 * 应用级键值存储（数据库版）：取代 localStorage。
 *
 * 本系统最终运行在本机桌面（Tauri + SQLite），因此所有偏好项（主题、AI 配置、
 * 知识库、分析维度记忆、设备指纹、备份标记等）一律存入数据库 settings 表，
 * 不再使用 localStorage。
 *
 * 设计要点：
 *  - 内存缓存：settings 表为异步读取，因此首启先 hydrateKV() 把 `kv.%` 前缀的
 *    行一次性载入内存 cache；业务侧用同步的 getKV() 读取，避免同步 store 初始化复杂度。
 *  - 写穿：setKV() 先更新内存缓存（保证本次会话可见），随后异步写库（失败仅告警，不回滚内存）。
 *  - 幂等：hydrateKV() 多次调用安全（内部缓存 Promise）。
 */
import { execute, select } from './db';

/** 判断是否处于 Tauri 桌面运行时（无原生桥时跳过真实落库，仅维护内存缓存，供单测使用） */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 内存缓存：key → value（仅含 `kv.%` 前缀的 settings 行） */
const cache = new Map<string, string>();
/** 首次 hydrate 的 Promise，保证并发调用只触发一次载入 */
let hydration: Promise<void> | null = null;

/** 是否已完成（或正在完成）从数据库载入缓存 */
export function isKVReady(): boolean {
  return hydration !== null;
}

/** 从 settings 表一次性载入全部偏好项到内存缓存（幂等） */
export function hydrateKV(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    if (!isTauriRuntime()) {
      // 非桌面运行时（如单测环境）无数据库，保持空缓存
      cache.clear();
      return;
    }
    try {
      const rows = await select<{ key: string; value: string }>(
        `SELECT key, value FROM settings WHERE key LIKE 'kv.%'`
      );
      cache.clear();
      for (const r of rows) cache.set(r.key, r.value);
      // eslint-disable-next-line no-console
      console.log('[kv] 已从数据库载入偏好项：', cache.size, '条');
    } catch (e) {
      // 数据库未就绪（如极端首启时序）时降级为空缓存，不阻塞启动
      // eslint-disable-next-line no-console
      console.error('[kv] 载入偏好项失败，本次会话使用默认值', e);
    }
  })();
  return hydration;
}

/** 同步读取偏好项；未载入或不存在时返回默认值 */
export function getKV(key: string, def: string = ''): string {
  return cache.get(key) ?? def;
}

/** 读取原始字符串（无默认值），供测试/调试检查持久化的原始内容 */
export function getRawKV(key: string): string | null {
  return cache.has(key) ? cache.get(key) as string : null;
}

/** 写穿：更新内存缓存 + 异步写库。返回是否落库成功——写库失败时回滚内存到旧值并返回 false，
 * 避免「界面显示已保存、重启后丢失」的假保存；调用方可根据返回值提示用户。 */
export async function setKV(key: string, value: string): Promise<boolean> {
  const prev = cache.get(key);
  cache.set(key, value);
  if (!isTauriRuntime()) return true;
  try {
    await execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = $2`,
      [key, value]
    );
    return true;
  } catch (e) {
    // 写库失败：回滚内存缓存到旧值，保持「内存 ↔ 数据库」一致
    if (prev === undefined) cache.delete(key); else cache.set(key, prev);
    // eslint-disable-next-line no-console
    console.error(`[kv] 写入偏好项 ${key} 失败（已回滚）：`, e);
    return false;
  }
}

/** 删除偏好项（内存 + 数据库）。写库失败时回滚内存并返回 false。 */
export async function removeKV(key: string): Promise<boolean> {
  const prev = cache.get(key);
  cache.delete(key);
  if (!isTauriRuntime()) return true;
  try {
    await execute(`DELETE FROM settings WHERE key = $1`, [key]);
    return true;
  } catch (e) {
    // 删除失败：恢复内存缓存
    if (prev !== undefined) cache.set(key, prev);
    // eslint-disable-next-line no-console
    console.error(`[kv] 删除偏好项 ${key} 失败（已回滚）：`, e);
    return false;
  }
}

/** 内部缓存访问器：供测试断言持久化内容时使用 */
export const _kvCache = cache;