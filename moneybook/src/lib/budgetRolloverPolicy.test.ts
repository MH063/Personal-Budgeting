/**
 * 滚动预算策略纯函数单元测试。
 * 覆盖：默认策略等价历史行为、关闭滚动、滚入上限、负结余、JSON 解析容错与摘要文案。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROLLOVER_POLICY, parseRolloverPolicy, applyRolloverPolicy, describeRolloverPolicy,
} from '@/lib/budgetRolloverPolicy';

describe('applyRolloverPolicy：滚入计算', () => {
  it('默认策略等价历史行为：全额滚入且不设上限', () => {
    expect(applyRolloverPolicy(500, 1000, DEFAULT_ROLLOVER_POLICY)).toBe(500);
    // 历史上多期累积可超过单期额度，默认策略必须保持这一行为（不截断）
    expect(applyRolloverPolicy(2500, 1000, DEFAULT_ROLLOVER_POLICY)).toBe(2500);
  });

  it('关闭滚动：任何结余都不滚入', () => {
    const p = { enabled: false, capPercent: null };
    expect(applyRolloverPolicy(500, 1000, p)).toBe(0);
    expect(applyRolloverPolicy(2500, 1000, p)).toBe(0);
  });

  it('设置上限：滚入不超过「本期额度 × 百分比」', () => {
    const p = { enabled: true, capPercent: 50 };
    expect(applyRolloverPolicy(500, 1000, p)).toBe(500);   // 未触顶
    expect(applyRolloverPolicy(2000, 1000, p)).toBe(500);  // 触顶 = 1000×50%
    expect(applyRolloverPolicy(500, 0, p)).toBe(0);        // 无额度则无上限空间
  });

  it('上限为 0：等价于不滚入', () => {
    expect(applyRolloverPolicy(800, 1000, { enabled: true, capPercent: 0 })).toBe(0);
  });

  it('负结余（超支）不滚负值', () => {
    expect(applyRolloverPolicy(-200, 1000, DEFAULT_ROLLOVER_POLICY)).toBe(0);
    expect(applyRolloverPolicy(-200, 1000, { enabled: true, capPercent: 50 })).toBe(0);
  });
});

describe('parseRolloverPolicy：解析与容错', () => {
  it('缺失或空值回退默认策略', () => {
    expect(parseRolloverPolicy(null)).toEqual(DEFAULT_ROLLOVER_POLICY);
    expect(parseRolloverPolicy('')).toEqual(DEFAULT_ROLLOVER_POLICY);
  });

  it('非法 JSON 回退默认策略', () => {
    expect(parseRolloverPolicy('{不是JSON')).toEqual(DEFAULT_ROLLOVER_POLICY);
    expect(parseRolloverPolicy('123')).toEqual(DEFAULT_ROLLOVER_POLICY);
  });

  it('正常解析完整对象', () => {
    expect(parseRolloverPolicy('{"enabled":false,"capPercent":80}')).toEqual({ enabled: false, capPercent: 80 });
    expect(parseRolloverPolicy('{"enabled":true,"capPercent":null}')).toEqual({ enabled: true, capPercent: null });
  });

  it('字段缺失/类型不符时按默认补齐并忽略非法值', () => {
    expect(parseRolloverPolicy('{"enabled":false}')).toEqual({ enabled: false, capPercent: null });
    expect(parseRolloverPolicy('{"enabled":"yes","capPercent":-5}')).toEqual(DEFAULT_ROLLOVER_POLICY);
    expect(parseRolloverPolicy('{"capPercent":0}')).toEqual({ enabled: true, capPercent: 0 });
  });
});

describe('describeRolloverPolicy：中文摘要', () => {
  it('三种状态文案', () => {
    expect(describeRolloverPolicy({ enabled: false, capPercent: null })).toContain('已关闭');
    expect(describeRolloverPolicy(DEFAULT_ROLLOVER_POLICY)).toContain('全额滚入');
    expect(describeRolloverPolicy({ enabled: true, capPercent: 60 })).toContain('60%');
  });
});
