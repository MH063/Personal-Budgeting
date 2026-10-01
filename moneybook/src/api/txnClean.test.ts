/**
 * 交易字段抽取与清洗（txnClean）纯逻辑单元测试。
 * 覆盖：支付方式识别、退款判定、优惠/手续费抽取与净消费、退款冲抵候选。
 */
import { describe, it, expect } from 'vitest';
import { extractPayMethod, isRefund, cleanTransaction, suggestRefundOffset } from './txnClean';

describe('extractPayMethod：支付方式识别', () => {
  it('识别常见支付方式', () => {
    expect(extractPayMethod('微信支付')?.name).toBe('微信');
    expect(extractPayMethod('用支付宝扫码')?.name).toBe('支付宝');
    expect(extractPayMethod('花呗分期')?.name).toBe('花呗');
    expect(extractPayMethod('现金结清')?.name).toBe('现金');
  });
  it('未命中返回 null', () => {
    expect(extractPayMethod('买咖啡')).toBeNull();
  });
});

describe('isRefund：退款判定', () => {
  it('退款/退/冲正为 true，普通消费为 false', () => {
    expect(isRefund('订单退款到账')).toBe(true);
    expect(isRefund('退货商家已退款')).toBe(true);
    expect(isRefund('购买会员')).toBe(false);
  });
});

describe('cleanTransaction：清洗抽取', () => {
  it('抽取实付/优惠与原价，不含手续费字样', () => {
    const c = cleanTransaction('星巴克 实付 30 元 原价 35 优惠 5 会员券');
    expect(c.paid).toBe(30);
    expect(c.original).toBe(35);
    expect(c.discount).toBe(5);
    expect(c.hits.length).toBeGreaterThan(0);
  });

  it('手续费单独提取，净消费 = 实付 - 费用', () => {
    const c = cleanTransaction('微信支付 100.00 手续费 2.00');
    expect(c.payMethod?.name).toBe('微信');
    expect(c.fee).toBe(2);
    expect(c.cleanAmount).toBe(98);
  });

  it('无实付时取首个金额作为实付', () => {
    const c = cleanTransaction('某店消费 45.5 元');
    expect(c.paid).toBe(45.5);
  });

  it('退款语义标记', () => {
    expect(cleanTransaction('商品退款 199').isRefund).toBe(true);
  });
});

describe('suggestRefundOffset：退款冲抵候选', () => {
  it('同收款方同金额退款 → 命中冲抵', () => {
    const rows = [{ payee: '某店', amount: 50 }, { payee: '某店', amount: -50 }];
    const r = suggestRefundOffset(rows);
    expect(r).toHaveLength(1);
    expect(r[0].offsetCandidate).toBe(true);
  });
  it('无匹配原交易的退款 → 不可冲抵', () => {
    const rows = [{ payee: 'A', amount: 50 }, { payee: 'B', amount: -50 }];
    expect(suggestRefundOffset(rows)[0].offsetCandidate).toBe(false);
  });
});