/**
 * 规则文档（rulesDoc）单元测试。
 * 覆盖：三类规则行解析、前缀与分隔符变体、注释/空行跳过、非法行收集、
 * 流向字段省略与转账转入账户、导出文档仅含启用规则。
 */
import { describe, it, expect } from 'vitest';
import { parseRulesDoc, buildRulesDocText } from './rulesDoc';
import type { UserRule } from './merchantNorm';

describe('parseRulesDoc：规则文档解析', () => {
  it('无前缀默认解析为归类规则，支持多种分隔符', () => {
    const doc = parseRulesDoc('星巴克 => 咖啡\n肯德基 -> 快餐\n麦当劳 → 餐饮');
    expect(doc.categorize).toEqual([
      { match: '星巴克', to: '咖啡' },
      { match: '肯德基', to: '快餐' },
      { match: '麦当劳', to: '餐饮' },
    ]);
    expect(doc.invalid).toEqual([]);
  });

  it('「归并」前缀解析为商户归并规则', () => {
    const doc = parseRulesDoc('归并: 金拱门 => 麦当劳\n归并：KFC => 肯德基');
    expect(doc.merchant).toEqual([
      { match: '金拱门', to: '麦当劳' },
      { match: 'KFC', to: '肯德基' },
    ]);
  });

  it('「流向」前缀解析为资金流向规则，字段可省略', () => {
    const doc = parseRulesDoc('流向: 停车费 => 支出|交通|支付宝\n流向: 工资 => 收入');
    expect(doc.flow[0]).toEqual({ match: '停车费', type: 'expense', category: '交通', account: '支付宝', toAccount: undefined, enabled: true });
    expect(doc.flow[1]).toEqual({ match: '工资', type: 'income', category: undefined, account: undefined, toAccount: undefined, enabled: true });
  });

  it('流向类型非法时该行记入 invalid，不阻断其他行', () => {
    const doc = parseRulesDoc('流向: 停车费 => 未知类型|交通\n星巴克 => 咖啡');
    expect(doc.flow).toEqual([]);
    expect(doc.invalid).toEqual(['流向: 停车费 => 未知类型|交通']);
    expect(doc.categorize).toEqual([{ match: '星巴克', to: '咖啡' }]);
  });

  it('跳过空行、# 注释与 // 注释；缺分隔符的行记入 invalid', () => {
    const doc = parseRulesDoc('# 说明\n\n// 注释\n没有分隔符的一行\n星巴克 => 咖啡\n');
    expect(doc.categorize).toEqual([{ match: '星巴克', to: '咖啡' }]);
    expect(doc.invalid).toEqual(['没有分隔符的一行']);
  });

  it('非转账类型的流向规则丢弃转入账户（避免残留误导）', () => {
    const doc = parseRulesDoc('流向: 停车费 => 支出|交通|支付宝|某某卡');
    expect(doc.flow[0].toAccount).toBeUndefined();
  });
});

describe('buildRulesDocText：规则文档导出', () => {
  it('仅导出启用规则，含分节注释与三类行格式', () => {
    const merchant: UserRule[] = [
      { kind: 'categorize', match: '星巴克', to: '咖啡', enabled: true },
      { kind: 'categorize', match: '停用的分类', to: '不导出', enabled: false },
      { kind: 'merchant_renamed', match: '金拱门', to: '麦当劳', enabled: true },
    ];
    const text = buildRulesDocText(merchant, [
      { match: '停车费', type: 'expense', category: '交通', account: '支付宝', enabled: true },
      { match: '停用的流向', type: 'expense', enabled: false },
    ]);
    expect(text).toContain('星巴克 => 咖啡');
    expect(text).toContain('归并: 金拱门 => 麦当劳');
    expect(text).toContain('流向: 停车费 => 支出|交通|支付宝');
    expect(text).not.toContain('停用的分类');
    expect(text).not.toContain('停用的流向');
  });

  it('导出内容可被 parseRulesDoc 原样解析回来（往返一致）', () => {
    const merchant: UserRule[] = [
      { kind: 'categorize', match: '星巴克', to: '咖啡', enabled: true },
      { kind: 'merchant_renamed', match: '金拱门', to: '麦当劳', enabled: true },
    ];
    const text = buildRulesDocText(merchant, [
      { match: '停车费', type: 'expense', category: '交通', enabled: true },
    ]);
    const doc = parseRulesDoc(text);
    expect(doc.categorize).toEqual([{ match: '星巴克', to: '咖啡' }]);
    expect(doc.merchant).toEqual([{ match: '金拱门', to: '麦当劳' }]);
    expect(doc.flow[0]).toEqual({ match: '停车费', type: 'expense', category: '交通', account: undefined, toAccount: undefined, enabled: true });
    expect(doc.invalid).toEqual([]);
  });
});