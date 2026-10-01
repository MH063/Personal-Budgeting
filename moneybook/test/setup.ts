/**
 * vitest 测试环境夹具。
 * Node 环境没有 window/localStorage/sessionStorage，这里用内存实现替身，
 * 让 useAIStore（持久化到 localStorage）与 encrypt（会话密钥存 sessionStorage）可测。
 * Web Crypto（subtle / getRandomValues / randomUUID）由 Node 原生提供，无需 mock。
 */

/** 简单内存版 Storage，仅实现用到的成员 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) as string : null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const g = globalThis as Record<string, unknown>;
if (!g.localStorage) (g as { localStorage: Storage }).localStorage = new MemoryStorage();
if (!g.sessionStorage) (g as { sessionStorage: Storage }).sessionStorage = new MemoryStorage();