/**
 * 债务偿还模拟纯函数单元测试。
 * 覆盖：雪球/雪崩结清顺序、零利率下的守恒、加速还款收益对比、无法结清的保护、空输入。
 */
import { describe, it, expect } from 'vitest';
import { simulateDebtPayoff, comparePayoff } from '@/lib/debtSim';
import type { DebtInput } from '@/lib/debtSim';

/** 构造一笔欠款的便捷函数 */
function debt(overrides: Partial<DebtInput> & Pick<DebtInput, 'id' | 'balance'>): DebtInput {
  return { name: `债${overrides.id}`, apr: 0, minPayment: 0, ...overrides };
}

describe('simulateDebtPayoff：无息场景与结清顺序', () => {
  it('雪球策略先清最小余额债务，且零利率下总还款=本金之和', () => {
    const debts = [
      debt({ id: 1, balance: 1000, minPayment: 100 }),
      debt({ id: 2, balance: 300, minPayment: 50 }),
    ];
    const r = simulateDebtPayoff(debts, 0, 'snowball');
    expect(r.cleared).toBe(true);
    expect(r.months).toBe(9);
    expect(r.totalInterest).toBe(0);
    expect(r.totalPaid).toBe(1300);
    expect(r.payoffOrder).toEqual([2, 1]);
    expect(r.timeline[r.timeline.length - 1].totalBalance).toBe(0);
  });

  it('空欠款列表：0 个月、已结清、零支出', () => {
    const r = simulateDebtPayoff([], 100, 'snowball');
    expect(r.months).toBe(0);
    expect(r.cleared).toBe(true);
    expect(r.totalPaid).toBe(0);
    expect(r.perDebt).toEqual([]);
  });
});

describe('simulateDebtPayoff：有息场景与策略对比', () => {
  const debts: DebtInput[] = [
    debt({ id: 1, name: '小额低息', balance: 500, apr: 5, minPayment: 50 }),
    debt({ id: 2, name: '大额高息', balance: 2000, apr: 24, minPayment: 100 }),
  ];

  it('雪崩策略优先清高利率债务（顺序不同）', () => {
    // 设计：小额债务利率更低、大额债务利率更高，且额外还款充足——
    // 雪球会先清「余额更小」的 id=1，雪崩会先清「利率更高」的 id=2。
    const two: DebtInput[] = [
      debt({ id: 1, name: '小额低息', balance: 1500, apr: 5, minPayment: 50 }),
      debt({ id: 2, name: '大额高息', balance: 2000, apr: 24, minPayment: 100 }),
    ];
    const snow = simulateDebtPayoff(two, 500, 'snowball');
    const aval = simulateDebtPayoff(two, 500, 'avalanche');
    expect(snow.payoffOrder[0]).toBe(1);
    expect(aval.payoffOrder[0]).toBe(2);
    // 雪崩的总利息不高于雪球
    expect(aval.totalInterest).toBeLessThanOrEqual(snow.totalInterest);
    expect(aval.cleared).toBe(true);
  });

  it('追加额外还款可省利息、缩短周期', () => {
    const base = simulateDebtPayoff(debts, 0, 'avalanche');
    const boosted = simulateDebtPayoff(debts, 200, 'avalanche');
    const cmp = comparePayoff(base, boosted);
    expect(cmp.interestSaved).toBeGreaterThan(0);
    expect(cmp.monthsSaved).toBeGreaterThan(0);
  });
});

describe('simulateDebtPayoff：保护与边界', () => {
  it('最低还款不足以覆盖当月利息 → 无法结清（months=-1、cleared=false）', () => {
    // 月利率 3% → 1000 元每月利息 30 元，但只还 10 元 → 余额持续增长
    const r = simulateDebtPayoff([debt({ id: 1, balance: 1000, apr: 36, minPayment: 10 })], 0, 'avalanche');
    expect(r.cleared).toBe(false);
    expect(r.months).toBe(-1);
    expect(r.perDebt[0].months).toBe(-1);
  });

  it('余额<=0 的欠款被忽略', () => {
    const r = simulateDebtPayoff([debt({ id: 9, balance: 0, minPayment: 100 })], 0, 'snowball');
    expect(r.months).toBe(0);
    expect(r.perDebt).toEqual([]);
  });

  it('comparePayoff 在基准未结清时不计节省月数', () => {
    const stuck = simulateDebtPayoff([debt({ id: 1, balance: 1000, apr: 36, minPayment: 10 })], 0, 'avalanche');
    const done = simulateDebtPayoff([debt({ id: 1, balance: 1000, apr: 36, minPayment: 10 })], 5000, 'avalanche');
    const cmp = comparePayoff(stuck, done);
    expect(cmp.monthsSaved).toBe(0);
  });
});
