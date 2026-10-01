/**
 * 财务健康评分 + 省钱建议（healthScore）纯逻辑单元测试。
 * 覆盖：评分分档与正负因子、省钱建议的阈值与削减比例。
 */
import { describe, it, expect } from 'vitest';
import { computeHealthScore, suggestSavings, type HealthInput } from './healthScore';

const good: HealthInput = {
  savingsRate: 0.3, fixedRatio: 0.45, expenseHealth: 80,
  overBudget: 0, hasNegative: false, surplus: 2000, debtRatio: 0,
};

describe('computeHealthScore：财务健康评分', () => {
  it('健康画像得高分且为优秀', () => {
    const r = computeHealthScore(good);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.label).toBe('优秀');
  });

  it('入不敷出 + 超支 + 负余额 → 明显扣分', () => {
    const bad: HealthInput = {
      ...good,
      savingsRate: -0.1, surplus: -300, hasNegative: true, overBudget: 3, debtRatio: 0.7,
    };
    const r = computeHealthScore(bad);
    expect(r.score).toBeLessThan(60);
    expect(r.label).not.toBe('优秀');
    expect(r.factors.some((f) => f.delta < 0)).toBe(true);
  });

  it('始终收敛在 0~100 且非 NaN', () => {
    const r = computeHealthScore({ ...good, savingsRate: 99, fixedRatio: 0 });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('suggestSavings：个性化省钱建议', () => {
  it('弹性类目月均超阈值时给出减少可省的金额', () => {
    const series = [
      { name: '外卖', icon: '', color: '', values: [500, 600, 550] }, // 均值 550 ≥200
      { name: '房租', icon: '', color: '', values: [3000, 3000, 3000] }, // 刚性，不报
      { name: '购物', icon: '', color: '', values: [80, 90, 100] }, // 低于阈值
    ];
    const s = suggestSavings(series);
    expect(s.some((x) => x.scene === '外卖' && x.amountSaving > 0)).toBe(true);
    expect(s.some((x) => x.scene === '房租')).toBe(false); // 非弹性类目不报
  });

  it('大量结果截断到 5 条并按可省金额降序', () => {
    const series = ['外卖', '餐饮', '娱乐', '咖啡', '游戏', '购物', '零食'].map((name) => ({
      name, icon: '', color: '', values: [900, 900, 900],
    }));
    const s = suggestSavings(series);
    expect(s.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < s.length; i++) expect(s[i - 1].amountSaving).toBeGreaterThanOrEqual(s[i].amountSaving);
  });
});