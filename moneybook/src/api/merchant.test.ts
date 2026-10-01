/**
 * 商户画像（merchant）纯逻辑单元测试。
 * 覆盖：按收款方聚合的总支出/笔数/平均/最近/主导分类、忽略无收款方与非法金额。
 */
import { describe, it, expect } from 'vitest';
import { aggregateMerchants, type MerchantRow } from './merchant';

const mk = (payee: string, amount: number, date: string, categoryName: string | null = '餐饮'): MerchantRow => ({ payee, amount, date, categoryName });

describe('aggregateMerchants：商户聚合', () => {
  it('同商户累加金额/笔数，取平均与最近一次', () => {
    const rows = [
      mk('某餐厅', 40, '2026-09-01', '餐饮'),
      mk('某餐厅', 60, '2026-09-05', '餐饮'),
      mk('便利店', 25, '2026-09-02', '购物'),
    ];
    const out = aggregateMerchants(rows);
    expect(out).toHaveLength(2);
    const rest = out.find((m) => m.name === '某餐厅');
    expect(rest && { total: rest.total, count: rest.count, avg: rest.avg, lastDate: rest.lastDate, category: rest.category })
      .toEqual({ total: 100, count: 2, avg: 50, lastDate: '2026-09-05', category: '餐饮' });
  });

  it('主导分类取出现最多的', () => {
    const rows = [mk('A', 10, '2026-09-01', '餐饮'), mk('A', 10, '2026-09-02', '购物'), mk('A', 10, '2026-09-03', '餐饮')];
    const out = aggregateMerchants(rows);
    expect(out[0].category).toBe('餐饮');
  });

  it('按金额降序；无收款方或金额非法被忽略', () => {
    const out = aggregateMerchants([
      mk('大', 500, '2026-09-01'),
      mk('小', 50, '2026-09-02'),
      { payee: '', amount: 99, date: '2026-09-03', categoryName: null },
      { payee: '零', amount: 0, date: '2026-09-04', categoryName: null },
    ]);
    expect(out[0].name).toBe('大');
    expect(out.length).toBe(2);
  });
});