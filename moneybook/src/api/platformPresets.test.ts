import { describe, it, expect } from 'vitest';
import { PLATFORM_PRESETS, matchPlatformPreset, presetToColumnMap } from './platformPresets';

/**
 * 平台预设单测：验证「表头 → 列映射」落在正确列、按文件名/表头推荐平台、
 * 以及同一列不被多字段重复认领（认领顺序契约）。
 */

const presetOf = (id: string) => {
  const p = PLATFORM_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`预设不存在：${id}`);
  return p;
};

describe('presetToColumnMap / 支付宝', () => {
  it('日期/收支/金额/对方/账户/单号 落在正确列', () => {
    const header = ['交易时间', '交易分类', '交易对方', '商品说明', '收/支', '金额（元）', '收/付款方式', '当前状态', '交易订单号', '商家订单号', '备注'];
    const map = presetToColumnMap(presetOf('alipay'), header);
    expect(map.date).toBe(0);
    expect(map.type).toBe(4);
    expect(map.amount).toBe(5);
    expect(map.account).toBe(6);
    expect(map.payee).toBe(2);
    expect(map.orderNo).toBe(8);
    expect(map.merchantOrderNo).toBe(9);
    expect(map.category).toBe(1);
    expect(map.note).toBe(3);
  });
});

describe('presetToColumnMap / 招商银行', () => {
  it('银行通用表头（借贷标志 + 对方户名 + 摘要）正确认领', () => {
    const header = ['交易日期', '交易时间', '收支', '交易金额', '账户', '对方户名', '摘要', '流水号'];
    const map = presetToColumnMap(presetOf('cmb'), header);
    expect(map.date).toBe(0);
    expect(map.payTime).toBe(1);
    expect(map.type).toBe(2);
    expect(map.amount).toBe(3);
    expect(map.account).toBe(4);
    expect(map.payee).toBe(5);
    expect(map.note).toBe(6);
    expect(map.orderNo).toBe(7);
  });
});

describe('presetToColumnMap / 列认领不重复', () => {
  it('同一列不会被日期与支付时间同时认领', () => {
    const header = ['交易时间'];
    const map = presetToColumnMap(presetOf('wechat'), header);
    expect(map.date).toBe(0);
    expect(map.payTime).toBeUndefined();
  });
});

describe('matchPlatformPreset', () => {
  it('按文件名推荐平台（微信）', () => {
    const p = matchPlatformPreset([], '微信支付账单(20260901-20260930).csv');
    expect(p?.id).toBe('wechat');
  });

  it('按文件名推荐平台（支付宝）', () => {
    const p = matchPlatformPreset([], 'alipay_record_202609.zip');
    expect(p?.id).toBe('alipay');
  });

  it('文件名与表头均无特征时返回 null', () => {
    expect(matchPlatformPreset(['日期', '金额'], 'my-export.csv')).toBeNull();
  });

  it('表头含平台说明文字时也能命中', () => {
    const p = matchPlatformPreset(['招商银行交易明细', '交易日期', '收支', '交易金额'], 'export.csv');
    expect(p?.id).toBe('cmb');
  });
});
