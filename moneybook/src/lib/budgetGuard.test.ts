/**
 * 预算余量计算纯函数单元测试。
 * 覆盖：超支/接近上限/正常三态判定、总预算兜底、空行/无预算处理。
 */
import { describe, it, expect } from 'vitest';
import { computeBudgetUsage, getUsageForCategory, budgetWarnMessage, BUDGET_WARN_PERCENT, usageStatusLabel } from '@/lib/budgetGuard';
import type { BudgetVsActualAdvancedRow } from '@/api/stats';

function row(overrides: Partial<BudgetVsActualAdvancedRow>): BudgetVsActualAdvancedRow {
  return {
    id: 1, category_id: 1, category_name: '餐饮', category_icon: '🍜',
    period: 'monthly', period_amount: 100, rolled_in: 0, actual: 50, usable: 100,
    rollover_source: null, status: 'ok',
    ...overrides,
  };
}

describe('computeBudgetUsage：状态判定', () => {
  it('实际≥可用 → over（超支红点）', () => {
    const rows = [row({ usable: 100, actual: 120, status: 'over' })];
    const u = computeBudgetUsage(rows).get(1)!;
    expect(u.status).toBe('over');
    expect(u.remaining).toBe(-20);
    expect(u.percent).toBe(120);
  });

  it('占用达到阈值但未超支 → warn（接近上限黄点）', () => {
    const rows = [row({ usable: 100, actual: 85, status: 'ok' })];
    const u = computeBudgetUsage(rows).get(1)!;
    expect(u.status).toBe('warn');
    expect(u.percent).toBeGreaterThanOrEqual(BUDGET_WARN_PERCENT);
  });

  it('占用未达阈值 → ok（正常）', () => {
    const rows = [row({ usable: 100, actual: 40, status: 'ok' })];
    expect(computeBudgetUsage(rows).get(1)!.status).toBe('ok');
  });

  it('无预算但发生支出 → 视为超支提醒', () => {
    const rows = [row({ usable: 0, actual: 30 })];
    expect(computeBudgetUsage(rows).get(1)!.status).toBe('over');
  });

  it('空数组 → 空映射', () => {
    expect(computeBudgetUsage([]).size).toBe(0);
  });
});

describe('getUsageForCategory：总预算兜底', () => {
  it('有分类预算时命中该分类', () => {
    const map = computeBudgetUsage([row({ category_id: 2, usable: 50, actual: 10 })]);
    const u = getUsageForCategory(map, 2);
    expect(u?.usable).toBe(50);
  });

  it('该分类未设预算时回退到总预算（null 键）', () => {
    const map = computeBudgetUsage([row({ category_id: null, usable: 500, actual: 200 })]);
    const u = getUsageForCategory(map, 7);
    expect(u?.usable).toBe(500);
  });

  it('均无命中 → 返回 null', () => {
    expect(getUsageForCategory(new Map(), 3)).toBeNull();
  });
});

describe('usageStatusLabel：文案', () => {
  it('映射超支/接近上限/正常', () => {
    expect(usageStatusLabel('over')).toBe('超支');
    expect(usageStatusLabel('warn')).toBe('接近上限');
    expect(usageStatusLabel('ok')).toBe('正常');
  });
});

describe('budgetWarnMessage：记账页强提醒文案（只提醒、不禁止）', () => {
  it('超支返回含超支金额与可用/已支出的文案', () => {
    const msg = budgetWarnMessage({ status: 'over', hasBudget: true, usable: 100, actual: 123.4, remaining: -23.4, percent: 123.4 });
    expect(msg).toContain('已超支 ¥23.40');
    expect(msg).toContain('可用 ¥100.00');
    expect(msg).toContain('已支出 ¥123.40');
  });

  it('接近上限返回占用百分比文案', () => {
    const msg = budgetWarnMessage({ status: 'warn', hasBudget: true, usable: 100, actual: 85, remaining: 15, percent: 85 });
    expect(msg).toContain('85%');
    expect(msg).toContain('即将用尽');
  });

  it('状态为 ok 时返回空串（无提醒）', () => {
    expect(budgetWarnMessage({ status: 'ok', hasBudget: true, usable: 100, actual: 10, remaining: 90, percent: 10 })).toBe('');
  });

  it('文案中绝不含"禁止/无法记账"等阻断类措辞', () => {
    const over = budgetWarnMessage({ status: 'over', hasBudget: true, usable: 100, actual: 150, remaining: -50, percent: 150 });
    expect(over).not.toMatch(/禁止|拦截|无法记账|打住/);
  });
});