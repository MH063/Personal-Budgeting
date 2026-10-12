import { describe, it, expect } from 'vitest';
import { detectSplitColumns, classifyBillDirection, cleanAmount } from './billColumns';

/**
 * 借贷分列识别与方向判定单测：
 * 覆盖「收入金额/支出金额」「借方发生额/贷方发生额」等分列形态，
 * 以及 借=支出 / 贷=收入 的方向判定（含复合词不误判、中性值返回 null）。
 */

describe('detectSplitColumns', () => {
  it('收入金额 / 支出金额 成对列 → 识别为分列', () => {
    const r = detectSplitColumns(['交易时间', '收入金额', '支出金额', '对方户名']);
    expect(r).toEqual({ incomeCol: 1, expenseCol: 2 });
  });

  it('借方发生额 / 贷方发生额 成对列 → 方向与列位置对应', () => {
    const r = detectSplitColumns(['交易日期', '借方发生额', '贷方发生额', '摘要']);
    expect(r).toEqual({ incomeCol: 2, expenseCol: 1 });
  });

  it('单列「金额」不算分列', () => {
    expect(detectSplitColumns(['交易时间', '收/支', '金额'])).toEqual({ incomeCol: -1, expenseCol: -1 });
  });

  it('只有一侧列时不算分列', () => {
    expect(detectSplitColumns(['日期', '收入金额', '备注'])).toEqual({ incomeCol: -1, expenseCol: -1 });
  });
});

describe('classifyBillDirection', () => {
  it('借贷标志：借=支出、贷=收入（含"借方/贷方"写法）', () => {
    expect(classifyBillDirection('借')).toBe('expense');
    expect(classifyBillDirection('借方')).toBe('expense');
    expect(classifyBillDirection('贷')).toBe('income');
    expect(classifyBillDirection('贷方')).toBe('income');
  });

  it('常见收支写法', () => {
    expect(classifyBillDirection('收入')).toBe('income');
    expect(classifyBillDirection('收款')).toBe('income');
    expect(classifyBillDirection('支出')).toBe('expense');
    expect(classifyBillDirection('付款')).toBe('expense');
  });

  it('中性/空值返回 null', () => {
    expect(classifyBillDirection('不计收支')).toBeNull();
    expect(classifyBillDirection('中性交易')).toBeNull();
    expect(classifyBillDirection('/')).toBeNull();
    expect(classifyBillDirection('')).toBeNull();
  });

  it('复合词「贷款」不被误判为收入', () => {
    expect(classifyBillDirection('贷款')).toBeNull();
  });
});

describe('cleanAmount', () => {
  it('去千分位与货币符号', () => {
    expect(cleanAmount('1,234.56')).toBeCloseTo(1234.56);
    expect(cleanAmount('¥ 88元')).toBeCloseTo(88);
    expect(cleanAmount('-50.00')).toBeCloseTo(50);
  });

  it('非法值返回 0', () => {
    expect(cleanAmount('')).toBe(0);
    expect(cleanAmount('abc')).toBe(0);
  });
});
