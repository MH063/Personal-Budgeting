import { describe, it, expect } from 'vitest';
import { classifyBuiltinCategory, categorizeWithRules, BUILTIN_CATEGORY_RULES } from './builtinCategory';
import type { UserRule } from './merchantNorm';

/**
 * 内置归类词典单测：验证常见商户/关键词命中正确分类、
 * 分类名对齐系统默认分类、以及「用户规则优先于内置词典」的契约。
 */

describe('classifyBuiltinCategory', () => {
  it('常见商户命中餐饮（品牌与品类两种写法）', () => {
    expect(classifyBuiltinCategory('星巴克咖啡(北京店)')?.category).toBe('餐饮');
    expect(classifyBuiltinCategory('午餐 麦当劳')?.category).toBe('餐饮');
  });

  it('出行关键词命中交通', () => {
    expect(classifyBuiltinCategory('滴滴出行')?.category).toBe('交通');
    expect(classifyBuiltinCategory('地铁通勤')?.category).toBe('交通');
  });

  it('居住类关键词命中居住', () => {
    expect(classifyBuiltinCategory('电费缴费')?.category).toBe('居住');
  });

  it('无关键词命中返回 null', () => {
    expect(classifyBuiltinCategory('未知商家xyz')).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(classifyBuiltinCategory('')).toBeNull();
  });
});

describe('classifyBuiltinCategory / 分类名对齐系统默认分类', () => {
  it('词典分类名均属系统默认 14 条分类之内', () => {
    const defaults = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '其他支出', '工资', '奖金', '兼职', '投资收益', '红包', '其他收入'];
    for (const r of BUILTIN_CATEGORY_RULES) {
      expect(defaults).toContain(r.category);
    }
  });
});

describe('categorizeWithRules / 优先级', () => {
  it('用户归类规则优先于内置词典', () => {
    const rules: UserRule[] = [{ kind: 'categorize', match: '星巴克', to: '咖啡', enabled: true }];
    const hit = categorizeWithRules('星巴克咖啡', rules);
    expect(hit?.category).toBe('咖啡');
  });

  it('用户规则未命中时回退内置词典', () => {
    const rules: UserRule[] = [{ kind: 'categorize', match: '不存在的商户', to: '咖啡', enabled: true }];
    const hit = categorizeWithRules('滴滴出行', rules);
    expect(hit?.category).toBe('交通');
    expect(hit?.via).toContain('内置词典');
  });

  it('用户规则停用时视为未命中，回退内置词典', () => {
    const rules: UserRule[] = [{ kind: 'categorize', match: '滴滴', to: '打车专用', enabled: false }];
    const hit = categorizeWithRules('滴滴出行', rules);
    expect(hit?.category).toBe('交通');
  });
});
