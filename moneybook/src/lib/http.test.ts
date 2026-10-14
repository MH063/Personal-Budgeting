/**
 * createTimeoutGuard（「超时 + 外部取消」复合信号）单元测试。
 * 覆盖：超时中止、外部取消、touch 刷新空闲计时、cleanup 防泄漏、继承已取消状态。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTimeoutGuard } from './http';

describe('createTimeoutGuard：超时与外部取消的复合信号', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('计时到点后中止信号，且 timedOut() 标记为 true', () => {
    vi.useFakeTimers();
    const g = createTimeoutGuard(1000);
    expect(g.signal.aborted).toBe(false);
    expect(g.timedOut()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(g.timedOut()).toBe(true);
    expect(g.signal.aborted).toBe(true);
    g.cleanup();
  });

  it('外部取消也会中止信号，但不算作超时', () => {
    vi.useFakeTimers();
    const ext = new AbortController();
    const g = createTimeoutGuard(10_000, ext.signal);
    ext.abort();
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(false);
    g.cleanup();
  });

  it('touch() 刷新空闲计时，长回答不会被误判超时', () => {
    vi.useFakeTimers();
    const g = createTimeoutGuard(1000);
    vi.advanceTimersByTime(900);
    g.touch(); // 收到数据：刷新计时
    vi.advanceTimersByTime(900);
    expect(g.signal.aborted).toBe(false); // 900 + 900 若未刷新早已超时
    vi.advanceTimersByTime(200);
    expect(g.signal.aborted).toBe(true); // 刷新后满 1000ms 才真正超时
    g.cleanup();
  });

  it('cleanup() 后计时器不再触发，避免定时器泄漏', () => {
    vi.useFakeTimers();
    const g = createTimeoutGuard(1000);
    g.cleanup();
    vi.advanceTimersByTime(5000);
    expect(g.signal.aborted).toBe(false);
    expect(g.timedOut()).toBe(false);
  });

  it('传入已取消的外部信号时立即中止（继承既有取消状态）', () => {
    const ext = new AbortController();
    ext.abort();
    const g = createTimeoutGuard(10_000, ext.signal);
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(false);
    g.cleanup();
  });
});
