/**
 * 深度智能分析纯函数（analytics.ts）单元测试。
 * 覆盖：月度支出异常突增、单笔交易离群、最小二乘支出的回归预测三块。
 */
import { describe, it, expect } from 'vitest';
import {
  detectSpendingAnomalies, detectTransactionAnomalies, forecastMonthlyExpenses,
} from '@/lib/analytics';

describe('detectSpendingAnomalies：月度支出异常突增', () => {
  it('平稳序列不产生异常', () => {
    expect(detectSpendingAnomalies([100, 100, 100, 100], ['01', '02', '03', '04'])).toEqual([]);
  });

  it('相对历史均值提升 ≥1.5 倍判为 warning', () => {
    const out = detectSpendingAnomalies([100, 100, 250], ['01', '02', '03']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: '03', value: 250, level: 'warning' });
    expect(out[0].diffRatio).toBeGreaterThanOrEqual(1.5);
  });

  it('提升 ≥3 倍判为 danger', () => {
    const out = detectSpendingAnomalies([100, 100, 400], ['01', '02', '03']);
    expect(out[0].level).toBe('danger');
  });

  it('历史全为 0 而本期待售 ≥100 视为新增异常', () => {
    const out = detectSpendingAnomalies([0, 0, 120], ['01', '02', '03']);
    expect(out[0]).toMatchObject({ level: 'warning', baseline: 0 });
  });

  it('不足 3 期（无足够历史）不判定', () => {
    expect(detectSpendingAnomalies([100, 999])).toEqual([]);
  });
});

describe('detectTransactionAnomalies：单笔交易离群', () => {
  it('分类样本不足 3 笔不做离群判定', () => {
    const out = detectTransactionAnomalies([
      { categoryId: 1, categoryName: '餐饮', amount: 99999 },
      { categoryId: 1, categoryName: '餐饮', amount: 1 },
    ]);
    expect(out).toEqual([]);
  });

  it('金额 ≥ 该分类均值 + 2×标准差 且 ≥2 倍均值时为离群', () => {
    const txs = [
      { categoryId: 1, categoryName: '餐饮', amount: 30 },
      { categoryId: 1, categoryName: '餐饮', amount: 35 },
      { categoryId: 1, categoryName: '餐饮', amount: 28 },
      { categoryId: 1, categoryName: '餐饮', amount: 500 }, // 离群
    ];
    const out = detectTransactionAnomalies(txs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ categoryName: '餐饮', amount: 500 });
    expect(out[0].multiple).toBeGreaterThanOrEqual(2);
  });

  it('分类内无波动（标准差为 0）时不判离群', () => {
    const txs = Array.from({ length: 4 }, () => ({ categoryId: 2, categoryName: '水电', amount: 50 }));
    expect(detectTransactionAnomalies(txs)).toEqual([]);
  });

  it('未命中分类的离群点以「未分类」归组', () => {
    const txs = [
      { categoryId: null, categoryName: null, amount: 10 },
      { categoryId: null, categoryName: null, amount: 12 },
      { categoryId: null, categoryName: null, amount: 11 },
      { categoryId: null, categoryName: null, amount: 300 },
    ];
    expect(detectTransactionAnomalies(txs)[0].categoryName).toBe('未分类');
  });
});

describe('forecastMonthlyExpenses：支出回归预测', () => {
  it('空输入返回 flat 且为 0', () => {
    expect(forecastMonthlyExpenses([])).toEqual({ next: 0, slope: 0, direction: 'flat' });
  });

  it('上升趋势：direction=up 且预测值高于最后一期', () => {
    const f = forecastMonthlyExpenses([100, 120, 140, 160]);
    expect(f.direction).toBe('up');
    expect(f.next).toBeGreaterThan(160);
  });

  it('下降趋势：direction=down 且预测值低于首期', () => {
    const f = forecastMonthlyExpenses([200, 170, 140, 110]);
    expect(f.direction).toBe('down');
    expect(f.next).toBeLessThan(140);
  });

  it('波动很小时判为 flat', () => {
    const f = forecastMonthlyExpenses([100, 101, 100, 102]);
    expect(f.direction).toBe('flat');
  });
});