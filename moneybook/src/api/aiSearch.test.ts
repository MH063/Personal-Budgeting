/**
 * AI 语义搜索（aiSearch）纯函数单测。
 * 覆盖：自然语言→结构化条件的本地解析（时间/类型/分类/金额/关键词），及 AI 返回 JSON 的稳健解析。
 */
import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { parseCriteriaLocal, parseAiCriteria } from './aiSearch';

describe('parseCriteriaLocal：自然语言 → 结构化条件（本地）', () => {
  it('「上个月咖啡花了多少」→ 上月区间 + 支出 + 分类=咖啡', () => {
    const c = parseCriteriaLocal('上个月咖啡花了多少', { categoryNames: ['餐饮', '咖啡'] });
    const lastMonthStart = dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
    const lastMonthEnd = dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
    expect(c.type).toBe('expense');
    expect(c.from).toBe(lastMonthStart);
    expect(c.to).toBe(lastMonthEnd);
    expect(c.categoryName).toBe('咖啡');
  });

  it('「本周超过 500 的支出」→ 本周区间 + 最小金额 + 关键词', () => {
    const c = parseCriteriaLocal('本周超过500的支出', { categoryNames: [] });
    expect(c.type).toBe('expense');
    expect(c.minAmount).toBe(500);
    expect(c.from).toBe(dayjs().startOf('week').format('YYYY-MM-DD'));
  });

  it('「低于 100 的消费」→ 最大金额', () => {
    const c = parseCriteriaLocal('低于100的消费', { categoryNames: [] });
    expect(c.maxAmount).toBe(100);
    expect(c.type).toBe('expense');
  });

  it('无时间/类型/分类线索时不臆造这些条件（仅当自由关键词兜底）', () => {
    const c = parseCriteriaLocal('最近过得怎么样', { categoryNames: [] });
    expect(c.type).toBeUndefined();
    expect(c.from).toBeUndefined();
    expect(c.categoryName).toBeUndefined();
  });
});

describe('parseAiCriteria：稳健解析 AI 条件 JSON', () => {
  it('剥离 markdown 围栏并提取字段，非法值丢弃', () => {
    const raw = '```json\n{"type":"income","from":"2026-09-01","to":"2026-09-30","search":"咖啡","categoryName":"餐饮","minAmount":null,"maxAmount":500}\n```';
    const c = parseAiCriteria(raw);
    expect(c).not.toBeNull();
    expect(c!.type).toBe('income');
    expect(c!.from).toBe('2026-09-01');
    expect(c!.maxAmount).toBe(500);
    expect(c!.categoryName).toBe('餐饮');
  });
  it('非对象/无花括号返回 null（不抛错）', () => {
    expect(parseAiCriteria('没有数据')).toBeNull();
    expect(parseAiCriteria('')).toBeNull();
  });
});