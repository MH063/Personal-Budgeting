/**
 * 周期记账引擎（recurring）纯逻辑单元测试。
 * 覆盖：computeNextOccurrence 的日/周/月/年前进与月末收敛、computeInitialNext 的丢回未来。
 */
import { describe, it, expect } from 'vitest';
import { computeNextOccurrence, computeInitialNext } from './recurring';

describe('computeNextOccurrence：下次触发日期计算', () => {
  it('日/周/月/年按间隔前进', () => {
    expect(computeNextOccurrence('2026-09-01', 'daily', 2)).toBe('2026-09-03');
    expect(computeNextOccurrence('2026-09-01', 'weekly', 1)).toBe('2026-09-08');
    expect(computeNextOccurrence('2026-09-15', 'monthly', 1)).toBe('2026-10-15');
    expect(computeNextOccurrence('2026-09-15', 'yearly', 1)).toBe('2027-09-15');
  });

  it('月末越界收敛（1/31 加一个月 → 2 月月末）', () => {
    expect(computeNextOccurrence('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
  });
});

describe('computeInitialNext：新建周期记账的首次触发', () => {
  it('开始日未到则用开始日；已过期则推进到今天或之后', () => {
    expect(computeInitialNext('2030-01-01', '2026-09-29', 'monthly', 1)).toBe('2030-01-01');
    // 开始日 8/1 已过去，每月一次 → 首次应 ≥ today(2026-09-29) 的最近一次
    const next = computeInitialNext('2026-08-01', '2026-09-29', 'monthly', 1);
    expect(next >= '2026-09-29').toBe(true);
  });
});