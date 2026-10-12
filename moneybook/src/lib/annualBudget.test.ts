/**
 * 年度预算总览纯函数单元测试。
 * 覆盖：进度/节奏比/年末外推三态、无预算与年初边界、月度分解（均分/权重/合计守恒）。
 */
import { describe, it, expect } from 'vitest';
import { computeAnnualProgress, splitAnnualToMonthly } from '@/lib/annualBudget';

describe('computeAnnualProgress：年度进度与外推', () => {
  it('半年用掉 60% → 节奏比 1.2、掉队、年末外推翻倍', () => {
    const p = computeAnnualProgress({ monthsElapsed: 6, actualToDate: 6000, budgetTotal: 10000 });
    expect(p.timeRatio).toBe(0.5);
    expect(p.usedRatio).toBe(0.6);
    expect(p.paceRatio).toBe(1.2);
    expect(p.forecastYearEnd).toBe(12000);
    expect(p.forecastRemaining).toBe(-2000);
    expect(p.offTrack).toBe(true);
  });

  it('半年只用掉 40% → 节奏比 0.8、未掉队、年末有结余', () => {
    const p = computeAnnualProgress({ monthsElapsed: 6, actualToDate: 4000, budgetTotal: 10000 });
    expect(p.paceRatio).toBe(0.8);
    expect(p.forecastYearEnd).toBe(8000);
    expect(p.forecastRemaining).toBe(2000);
    expect(p.offTrack).toBe(false);
  });

  it('未设预算：消耗进度为 0、永不掉队', () => {
    const p = computeAnnualProgress({ monthsElapsed: 6, actualToDate: 3000, budgetTotal: 0 });
    expect(p.usedRatio).toBe(0);
    expect(p.paceRatio).toBe(0);
    expect(p.offTrack).toBe(false);
  });

  it('年初（0 个月）：不做外推，避免除零', () => {
    const p = computeAnnualProgress({ monthsElapsed: 0, actualToDate: 0, budgetTotal: 10000 });
    expect(p.timeRatio).toBe(0);
    expect(p.forecastYearEnd).toBe(0);
    expect(p.forecastRemaining).toBe(10000);
    expect(p.offTrack).toBe(false);
  });

  it('已过月数超出全年被裁剪到 12；负实际按 0 处理', () => {
    const p = computeAnnualProgress({ monthsElapsed: 99, actualToDate: -5, budgetTotal: 12000 });
    expect(p.timeRatio).toBe(1);
    expect(p.usedRatio).toBe(0);
    expect(p.forecastYearEnd).toBe(0);
  });

  it('特定周期（totalMonths=3）时间进度按季度折算', () => {
    const p = computeAnnualProgress({ monthsElapsed: 1, totalMonths: 3, actualToDate: 1200, budgetTotal: 3000 });
    expect(p.timeRatio).toBe(0.33);
    expect(p.usedRatio).toBe(0.4);
    expect(p.paceRatio).toBe(1.2);
    expect(p.forecastYearEnd).toBe(3600);
    expect(p.offTrack).toBe(true);
  });
});

describe('splitAnnualToMonthly：年度额度按月分解', () => {
  it('默认 12 个月均分，合计严格守恒', () => {
    const arr = splitAnnualToMonthly(1200);
    expect(arr).toHaveLength(12);
    expect(arr.every((v) => v === 100)).toBe(true);
  });

  it('除不尽时末月修正，合计仍等于总额', () => {
    const arr = splitAnnualToMonthly(1000);
    expect(arr).toHaveLength(12);
    const sum = Math.round(arr.reduce((s, v) => s + v, 0) * 100) / 100;
    expect(sum).toBe(1000);
    expect(arr[0]).toBe(83.33);
    expect(arr[11]).toBe(83.37);
  });

  it('按权重分配（权重长度决定月数）', () => {
    const arr = splitAnnualToMonthly(1200, [1, 1, 2]);
    expect(arr).toEqual([300, 300, 600]);
  });

  it('权重全为 0 时退化为均分', () => {
    const arr = splitAnnualToMonthly(900, [0, 0, 0]);
    expect(arr).toEqual([300, 300, 300]);
  });
});
