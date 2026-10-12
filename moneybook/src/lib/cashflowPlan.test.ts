/**
 * 现金流场景预测纯函数单元测试。
 * 覆盖：基础推演、收入变化、一次性收支、入不敷出识别、跨年月份、空输入边界。
 */
import { describe, it, expect } from 'vitest';
import { simulateCashflow } from '@/lib/cashflowPlan';

describe('simulateCashflow：基础推演', () => {
  it('按分类基线 + 分类变化率计算支出，并按月累计结余', () => {
    const r = simulateCashflow({
      startYm: '2026-01',
      months: 3,
      incomeBase: 10000,
      expenseItems: [
        { name: '餐饮', base: 3000, deltaPct: 0 },
        { name: '购物', base: 2000, deltaPct: 10 },
      ],
      extraMonthlySaving: 500,
    });
    expect(r.rows).toHaveLength(3);
    // 支出 = 3000 + 2000×1.1 = 5200；净 = 10000 − 5200 − 500 = 4300
    expect(r.rows[0].expense).toBe(5200);
    expect(r.rows[0].net).toBe(4300);
    expect(r.rows[0].cumulative).toBe(4300);
    expect(r.rows[2].cumulative).toBe(12900);
    expect(r.endBalance).toBe(12900);
    expect(r.totalSaving).toBe(1500);
    expect(r.deficitMonths).toEqual([]);
  });

  it('收入变化百分比作用于基线收入', () => {
    const r = simulateCashflow({
      startYm: '2026-01', months: 1, incomeBase: 1000, incomeDeltaPct: 10,
      expenseItems: [{ name: '餐饮', base: 200, deltaPct: 0 }],
    });
    expect(r.rows[0].income).toBe(1100);
    expect(r.rows[0].net).toBe(900);
  });

  it('跨年月份连续推演（11 月 → 次年 2 月）', () => {
    const r = simulateCashflow({ startYm: '2026-11', months: 4, incomeBase: 0, expenseItems: [] });
    expect(r.rows.map((x) => x.ym)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('simulateCashflow：一次性收支与入不敷出', () => {
  it('一次性支出并入当月支出，累计结余转负即计入 deficitMonths', () => {
    const r = simulateCashflow({
      startYm: '2026-01',
      months: 3,
      incomeBase: 1000,
      expenseItems: [{ name: '餐饮', base: 1500, deltaPct: 0 }],
      oneOffs: [{ ym: '2026-02', amount: -2000, label: '换电脑' }],
    });
    expect(r.rows[0].cumulative).toBe(-500);
    expect(r.rows[1].expense).toBe(3500);
    expect(r.rows[1].oneOffNote).toBe('换电脑');
    expect(r.rows[2].cumulative).toBe(-3500);
    expect(r.deficitMonths).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r.minCumulative).toBe(-3500);
    expect(r.minYm).toBe('2026-03');
  });

  it('一次性收入作为当月收入加项', () => {
    const r = simulateCashflow({
      startYm: '2026-01', months: 1, incomeBase: 100, expenseItems: [],
      oneOffs: [{ ym: '2026-01', amount: 500, label: '年终奖' }],
    });
    expect(r.rows[0].income).toBe(600);
    expect(r.rows[0].net).toBe(600);
  });
});

describe('simulateCashflow：边界', () => {
  it('months=0 返回空结果', () => {
    const r = simulateCashflow({ startYm: '2026-01', months: 0, incomeBase: 1000, expenseItems: [] });
    expect(r.rows).toEqual([]);
    expect(r.endBalance).toBe(0);
    expect(r.minYm).toBe('2026-01');
  });

  it('负的额外储蓄按 0 处理', () => {
    const r = simulateCashflow({
      startYm: '2026-01', months: 1, incomeBase: 100, expenseItems: [], extraMonthlySaving: -50,
    });
    expect(r.rows[0].saving).toBe(0);
    expect(r.rows[0].net).toBe(100);
  });
});
