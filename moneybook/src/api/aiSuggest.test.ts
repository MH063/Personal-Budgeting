/**
 * AI 智能分类/账户推荐（aiSuggest）纯函数单测。
 * 覆盖：本地关键词分类、账户包含匹配、AI 返回 JSON 的稳健解析、结果过滤（只收清单内名称）。
 */
import { describe, it, expect } from 'vitest';
import { classifyLocal, matchAccountLocal, parseAiSuggestion, classifyConfidence, lowConfidenceNames, LOCAL_CATEGORY_RULES } from './aiSuggest';

describe('classifyLocal：本地关键词分类', () => {
  it('按关键词命中对应分类', () => {
    expect(classifyLocal('午饭 25 元')).toBe('餐饮');
    expect(classifyLocal('地铁出行')).toBe('交通');
    expect(classifyLocal('房租水电')).toBe('居住');
    expect(classifyLocal('买超市日用品')).toBe('购物');
  });
  it('无关键词命中返回 null（不臆造）', () => {
    expect(classifyLocal('随手记')).toBeNull();
    expect(classifyLocal('')).toBeNull();
  });
  it('对齐新分类体系：话费归通讯、网购归网购、工资归工资（不再出现伪分类「工资/收入」）', () => {
    expect(classifyLocal('充话费 50 元')).toBe('通讯');
    expect(classifyLocal('在淘宝下单')).toBe('网购');
    expect(classifyLocal('收到本月工资')).toBe('工资');
    expect(classifyLocal('健身房年卡')).toBe('运动');
    expect(classifyLocal('买台新电脑')).toBe('数码');
    expect(LOCAL_CATEGORY_RULES.some((r) => r.category === '工资/收入')).toBe(false);
    expect([...new Set(LOCAL_CATEGORY_RULES.map((r) => r.category))].length).toBe(LOCAL_CATEGORY_RULES.length);
  });
});

describe('matchAccountLocal：账户名包含匹配', () => {
  const accounts = [
    { id: 1, name: '微信' },
    { id: 2, name: '招商银行卡(1055)' },
    { id: 3, name: '现金' },
  ];
  it('账户名出现在文本中则命中（按更长名称优先）', () => {
    expect(matchAccountLocal('从招商银行卡(1055)转出', accounts)?.id).toBe(2);
    expect(matchAccountLocal('微信支付买咖啡', accounts)?.id).toBe(1);
    expect(matchAccountLocal('收现金', accounts)?.id).toBe(3);
  });
  it('全文无账户名返回 null', () => {
    expect(matchAccountLocal('去逛商场买东西', accounts)).toBeNull();
  });
});

describe('parseAiSuggestion：稳健解析 AI 输出', () => {
  it('剥离 markdown 围栏并取首个数组', () => {
    const raw = '```json\n[{"category":"餐饮","score":0.9,"account":"微信","account_score":0.8}]\n```';
    expect(parseAiSuggestion(raw)).toEqual([{ category: '餐饮', score: 0.9, account: '微信', account_score: 0.8 }]);
  });
  it('非数组/无括号返回空数组（不抛错）', () => {
    expect(parseAiSuggestion('好的，我看看')).toEqual([]);
    expect(parseAiSuggestion('')).toEqual([]);
    expect(parseAiSuggestion('plain text [ not close')).toEqual([]);
  });
});

describe('classifyConfidence / lowConfidenceNames：低置信度转人工', () => {
  it('置信度分级：高/中/低', () => {
    expect(classifyConfidence(0.9)).toBe('high');
    expect(classifyConfidence(0.7)).toBe('medium');
    expect(classifyConfidence(0.5)).toBe('low');
    expect(classifyConfidence(0.6)).toBe('medium');
  });

  it('只筛出低于阈值的类别，供 UI 提示待核实', () => {
    expect(lowConfidenceNames({ categories: [{ name: '餐饮', score: 0.9 }, { name: '娱乐', score: 0.4 }] })).toEqual(['娱乐']);
    expect(lowConfidenceNames({ categories: [] })).toEqual([]);
  });
});