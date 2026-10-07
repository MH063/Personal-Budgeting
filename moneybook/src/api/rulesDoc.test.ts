/**
 * 规则文档（rulesDoc）单元测试。
 * 覆盖：三类规则行解析、前缀与分隔符变体、注释/空行跳过、非法行收集、
 * 流向字段省略与转账转入账户、导出文档仅含启用规则、模板解析 0 条、文档优先合并。
 */
import { describe, it, expect } from 'vitest';
import { parseRulesDoc, buildRulesDocText, buildRulesDocTemplate, mergeDocRules } from './rulesDoc';
import type { UserRule } from './merchantNorm';
import type { ImportRule } from './import';

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

  it('流向字段支持全角竖线「｜」分隔（中文输入法友好）', () => {
    const doc = parseRulesDoc('流向: 停车费 => 支出｜交通｜支付宝');
    expect(doc.flow[0]).toEqual({ match: '停车费', type: 'expense', category: '交通', account: '支付宝', toAccount: undefined, enabled: true });
  });

  it('流向中间空位留空占位：分类留空时账户不错位成分类', () => {
    const doc = parseRulesDoc('流向: 停车费 => 支出||支付宝');
    expect(doc.flow[0]).toEqual({ match: '停车费', type: 'expense', category: undefined, account: '支付宝', toAccount: undefined, enabled: true });
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

  it('分类留空、仅账户的规则：导出保留空位占位，回读不错位（防字段错位回归）', () => {
    const text = buildRulesDocText([], [
      { match: '停车费', type: 'expense', account: '支付宝', enabled: true },
    ]);
    expect(text).toContain('流向: 停车费 => 支出||支付宝');
    const doc = parseRulesDoc(text);
    expect(doc.flow[0]).toEqual({ match: '停车费', type: 'expense', category: undefined, account: '支付宝', toAccount: undefined, enabled: true });
    expect(doc.invalid).toEqual([]);
  });
});

describe('buildRulesDocTemplate：格式模板', () => {
  it('模板可直接导入且不产生任何规则（示例均为注释行，防误伤）', () => {
    const doc = parseRulesDoc(buildRulesDocTemplate());
    expect(doc.categorize).toEqual([]);
    expect(doc.merchant).toEqual([]);
    expect(doc.flow).toEqual([]);
    expect(doc.invalid).toEqual([]);
  });

  it('模板包含三类规则的格式示例与分隔符说明', () => {
    const text = buildRulesDocTemplate();
    expect(text).toContain('星巴克 => 咖啡');
    expect(text).toContain('归并: 金拱门 => 麦当劳');
    expect(text).toContain('流向: 停车费 => 支出|交通|支付宝');
    expect(text).toContain('=> 或 -> 或 → 或 ⇒');
  });
});

describe('mergeDocRules：文档优先合并', () => {
  it('同匹配词按文档值更新目标，保留原有停用状态', () => {
    const merchant: UserRule[] = [{ kind: 'categorize', match: '星巴克', to: '咖啡', enabled: false }];
    const r = mergeDocRules(merchant, [], parseRulesDoc('星巴克 => 饮品'));
    expect(r.merchant).toEqual([{ kind: 'categorize', match: '星巴克', to: '饮品', enabled: false }]);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
  });

  it('不存在的规则新增且默认启用；重复导入内容一致时不计更新（幂等）', () => {
    const doc = parseRulesDoc('星巴克 => 咖啡\n归并: 金拱门 => 麦当劳\n流向: 停车费 => 支出|交通');
    const first = mergeDocRules([], [], doc);
    expect(first.added).toBe(3);
    expect(first.updated).toBe(0);
    expect(first.merchant.every((r) => r.enabled)).toBe(true);
    const again = mergeDocRules(first.merchant, first.flow, doc);
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
  });

  it('资金流向同匹配词覆盖字段并保留停用状态', () => {
    const flow: ImportRule[] = [
      { match: '停车费', type: 'expense', category: '交通', account: '支付宝', enabled: false },
    ];
    const r = mergeDocRules([], flow, parseRulesDoc('流向: 停车费 => 支出|停车|微信'));
    expect(r.flow[0]).toEqual({ match: '停车费', type: 'expense', category: '停车', account: '微信', toAccount: undefined, enabled: false });
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
  });

  it('归类与归并各自独立：同名匹配词不互相覆盖（kind 隔离）', () => {
    const merchant: UserRule[] = [{ kind: 'merchant_renamed', match: '麦当劳', to: '麦当劳餐厅', enabled: true }];
    const r = mergeDocRules(merchant, [], parseRulesDoc('麦当劳 => 餐饮'));
    expect(r.merchant.length).toBe(2);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(0);
  });
});