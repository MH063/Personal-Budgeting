/**
 * 金额工具单元测试。
 * 覆盖 roundMoney（浮点尾差归一到分）与 moneyEqual（分级比较）。
 */
import { describe, it, expect } from 'vitest';
import { roundMoney, moneyEqual } from './money';

describe('roundMoney：金额归一到分（消除浮点尾差）', () => {
  it('经典浮点尾差被消除：0.1 + 0.2 → 0.3', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(0.30000000000000004)).toBe(0.3);
  });

  it('正常两位小数金额原样保留', () => {
    expect(roundMoney(19.95)).toBe(19.95);
    expect(roundMoney(100)).toBe(100);
    expect(roundMoney(-19.95)).toBe(-19.95);
  });

  it('三位以上小数按「四舍五入到分」处理', () => {
    expect(roundMoney(1.005)).toBe(1);    // 1.005*100=100.4999… → 100
    expect(roundMoney(2.675)).toBe(2.68); // 2.675*100=267.5（该值的二进制表示恰好≥267.5）→ 268
  });

  it('累加链上的尾差不累积：多次累加后再取整稳定', () => {
    // 0.1 累加 3 次：0.1+0.1+0.1 = 0.30000000000000004
    let net = 0;
    for (let i = 0; i < 3; i++) net = roundMoney(net + 0.1);
    expect(net).toBe(0.3);
  });
});

describe('moneyEqual：分级比较（容忍半分之内的浮点尾差）', () => {
  it('精确相等与尾差相等均判定一致', () => {
    expect(moneyEqual(0.3, 0.3)).toBe(true);
    expect(moneyEqual(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('真正的金额差异不被吞掉', () => {
    expect(moneyEqual(0.3, 0.35)).toBe(false);
    expect(moneyEqual(19.95, 20)).toBe(false);
  });
});
