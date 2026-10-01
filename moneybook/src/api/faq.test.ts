/**
 * 聊天式财务问答（faq）纯逻辑单元测试。
 * 覆盖：意图识别、日期窗口计算、分类环比、本地答案文案。
 */
import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { detectIntent, buildRanges, computeCategoryMom, textAnswer, type FaqFacts } from './faq';

describe('detectIntent：意图识别', () => {
  it('按关键词识别收入/照出/环比意图', () => {
    expect(detectIntent('上个月工资收入多少')).toBe('income_total');
    expect(detectIntent('上个月花了多少钱')).toBe('expense_total');
    expect(detectIntent('哪类支出增长最快')).toBe('top_growth');
    expect(detectIntent('最多花在哪个分类')).toBe('top_cat');
    expect(detectIntent('你好')).toBe('generic');
  });
});

describe('buildRanges：日期窗口', () => {
  it('默认当前月，上一窗口为其前一月（等长）', () => {
    const r = buildRanges('花了多少');
    expect(r.from).toBe(dayjs().startOf('month').format('YYYY-MM-DD'));
    expect(r.prevTo).toBe(dayjs(r.from).subtract(1, 'day').format('YYYY-MM-DD'));
    expect(dayjs(r.to).diff(dayjs(r.from), 'day')).toBe(dayjs(r.prevTo).diff(dayjs(r.prevFrom), 'day'));
  });
  it('「上月」解析为上月窗口', () => {
    const r = buildRanges('上月咖啡花了多少');
    expect(r.from).toBe(dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'));
  });
});

describe('computeCategoryMom：分类环比', () => {
  it('上升/下降/新增计算正确', () => {
    const mom = computeCategoryMom(
      [{ name: '餐饮', icon: '🍜', total: 200 }, { name: '新类', icon: '', total: 50 }],
      [{ name: '餐饮', icon: '🍜', total: 100 }]
    );
    expect(mom.find((m) => m.name === '餐饮')?.momPct).toBe(100); // (200-100)/100
    expect(mom.find((m) => m.name === '新类')?.momPct).toBe(100); // 上期 0 → 100
  });
  it('无变化为 0；两期都 0 则忽略', () => {
    const mom = computeCategoryMom([{ name: 'A', icon: '', total: 0 }], [{ name: 'A', icon: '', total: 0 }]);
    expect(mom).toHaveLength(0);
  });
});

function sample(total: number): FaqFacts {
  return {
    intent: 'expense_total', type: 'expense',
    range: { from: '2026-09-01', to: '2026-09-30', prevFrom: '2026-08-01', prevTo: '2026-08-31' },
    total, top: [{ name: '餐饮', icon: '🍜', total: total }], mom: [],
  };
}

describe('textAnswer：本地答案文案', () => {
  it('给出金额并对单品TOP', () => {
    const a = textAnswer(sample(500), '花了多少');
    expect(a).toContain('支出');
    expect(a).toContain('¥500.00');
  });
  it('环比意图给出增长最快分类', () => {
    const facts: FaqFacts = {
      ...sample(600),
      intent: 'top_growth',
      mom: [{ name: '交通', icon: '', current: 300, prev: 100, momPct: 200 }],
    };
    const a = textAnswer(facts, '什么增长快');
    expect(a).toContain('交通');
    expect(a).toContain('200%');
  });
});