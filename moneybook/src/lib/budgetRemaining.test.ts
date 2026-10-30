import { describe, it, expect } from 'vitest';
import { computeSpendable, markShadowedBudgets } from './budgetRemaining';

describe('computeSpendable：本月剩余可花', () => {
  it('存在总预算时以总预算为准，已用取总预算行', () => {
    const r = computeSpendable(
      [
        { category_id: null, budget_amount: 5000, actual: 2000 },
        { category_id: 1, budget_amount: 1000, actual: 800 },
      ],
      '2026-10-15'
    );
    expect(r.scope).toBe('total');
    expect(r.totalBudget).toBe(5000);
    expect(r.spent).toBe(2000);
    expect(r.remaining).toBe(3000);
    expect(r.hasBudget).toBe(true);
  });

  it('只有分类预算时按分类合计，已用为各分类实际之和', () => {
    const r = computeSpendable(
      [
        { category_id: 1, budget_amount: 1000, actual: 300 },
        { category_id: 2, budget_amount: 500, actual: 200 },
      ],
      '2026-10-10'
    );
    expect(r.scope).toBe('category');
    expect(r.totalBudget).toBe(1500);
    expect(r.spent).toBe(500);
    expect(r.remaining).toBe(1000);
  });

  it('无预算时不伪造数据（hasBudget=false，额度为 0）', () => {
    const r = computeSpendable([], '2026-10-10');
    expect(r.hasBudget).toBe(false);
    expect(r.scope).toBe('none');
    expect(r.totalBudget).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('超支时剩余为负且标记 overBudget', () => {
    const r = computeSpendable([{ category_id: null, budget_amount: 1000, actual: 1200 }], '2026-10-20');
    expect(r.remaining).toBe(-200);
    expect(r.overBudget).toBe(true);
  });

  it('剩余天数含今天：10 月 15 日 → 17 天', () => {
    const r = computeSpendable([{ category_id: null, budget_amount: 1700, actual: 0 }], '2026-10-15');
    expect(r.daysLeft).toBe(17);
    expect(r.perDay).toBe(100);
  });

  it('当月最后一天剩余天数按 1 天计', () => {
    const r = computeSpendable([{ category_id: null, budget_amount: 300, actual: 0 }], '2026-10-31');
    expect(r.daysLeft).toBe(1);
    expect(r.perDay).toBe(300);
  });
});

describe('markShadowedBudgets：总预算覆盖下的分类明细', () => {
  it('存在总预算时，分类预算行被标记为 shadowed', () => {
    const rows = markShadowedBudgets([
      { category_id: null, budget_amount: 5000, actual: 2000 },
      { category_id: 1, budget_amount: 1000, actual: 800 },
    ]);
    expect(rows[0].shadowed).toBe(false);
    expect(rows[1].shadowed).toBe(true);
  });

  it('没有总预算时，分类预算行都是独立额度（shadowed=false）', () => {
    const rows = markShadowedBudgets([
      { category_id: 1, budget_amount: 1000, actual: 300 },
      { category_id: 2, budget_amount: 500, actual: 200 },
    ]);
    expect(rows.every((r) => r.shadowed === false)).toBe(true);
  });

  it('空数组不报错并返回空数组', () => {
    expect(markShadowedBudgets([])).toEqual([]);
  });
});
