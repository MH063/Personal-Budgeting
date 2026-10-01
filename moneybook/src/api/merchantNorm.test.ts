/**
 * 商户标准化 + 用户规则优先级引擎（merchantNorm）单元测试。
 * 覆盖：内置同义归一、用户规则优先于内置、分类规则命中、规则解析与过滤。
 */
import { describe, it, expect } from 'vitest';
import { normalizeMerchant, categorizeByRule, parseUserRules, type UserRule } from './merchantNorm';

const rules: UserRule[] = [
  { kind: 'merchant_renamed', match: '麦当劳', to: '麦记', enabled: true },
  { kind: 'categorize', match: '星巴克', to: '咖啡', enabled: true },
];

describe('normalizeMerchant：商户归一', () => {
  it('内置同义把多写法归一到规范名', () => {
    expect(normalizeMerchant('金拱门').name).toBe('麦当劳');
    expect(normalizeMerchant("McDonald's").name).toBe('麦当劳');
    expect(normalizeMerchant('星巴克咖啡').name).toBe('星巴克');
  });

  it('用户规则优先于内置同义，并给出依据', () => {
    const r = normalizeMerchant('麦当劳', { rules });
    expect(r.name).toBe('麦记'); // 用户自定义优先
    expect(r.via).toContain('自定义规则');
  });

  it('未命中则原文返回', () => {
    expect(normalizeMerchant('某独立小店').name).toBe('某独立小店');
    expect(normalizeMerchant('')).toBeTruthy();
  });
});

describe('categorizeByRule：分类规则判定', () => {
  it('命中用户分类规则返回分类与依据', () => {
    const r = categorizeByRule('买了星巴克拿铁', { rules });
    expect(r).toMatchObject({ category: '咖啡', via: '规则「星巴克」' });
  });
  it('未命中返回 null', () => {
    expect(categorizeByRule('随便吃的', { rules })).toBeNull();
  });
});

describe('parseUserRules：校验与过滤', () => {
  it('过滤非法项，保留合法项', () => {
    const parsed = parseUserRules([
      { kind: 'categorize', match: 'A', to: '餐饮', enabled: true },
      { kind: 'bad', match: 'B', to: 'X' },
      { kind: 'merchant_renamed', match: '', to: 'Y' },
      null,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].match).toBe('A');
  });
  it('非数组返回空', () => {
    expect(parseUserRules('x')).toEqual([]);
  });
});