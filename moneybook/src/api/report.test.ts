/**
 * 自动周/月报（report）纯逻辑单元测试。
 * 覆盖：周期窗口计算（周/月 + 上一等价期）、报告文本组装。
 */
import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { buildPeriodRange, assembleReportText, topIncrementAttribution, type SummaryInput } from './report';

describe('buildPeriodRange：周期窗口', () => {
  it('周报：本周一~周日，上一周边界相接', () => {
    const r = buildPeriodRange('week');
    expect(r.from).toBe(dayjs().startOf('week').format('YYYY-MM-DD'));
    expect(r.to).toBe(dayjs().endOf('week').format('YYYY-MM-DD'));
    expect(dayjs(r.from).diff(dayjs(r.prevTo), 'day')).toBe(1); // prevTo 是 from 前一天
    expect(dayjs(r.to).diff(dayjs(r.from), 'day')).toBe(6); // 整周 7 天
  });

  it('月报：本月与上月的对应区间', () => {
    const r = buildPeriodRange('month');
    expect(r.from).toBe(dayjs().startOf('month').format('YYYY-MM-DD'));
    expect(r.prevFrom).toBe(dayjs(r.from).subtract(1, 'month').startOf('month').format('YYYY-MM-DD'));
  });
});

describe('assembleReportText：报告文本', () => {
  it('包含收支、环比、健康与提醒', () => {
    const s: SummaryInput = {
      word: '周报', from: '2026-09-21', to: '2026-09-27',
      income: 5000, expense: 1200, surplus: 3800, momExpensePct: 12.5,
      topExpense: [{ name: '餐饮', total: 400 }, { name: '交通', total: 200 }],
      topIncome: [{ name: '工资', total: 5000 }],
      healthLabel: '良好', healthScore: 72, dueSubs: 1, anomalyCount: 0,
      attribution: ['餐饮 +¥120.00'],
    };
    const t = assembleReportText(s);
    expect(t).toContain('# 周报');
    expect(t).toContain('收入：¥5000.00');
    expect(t).toContain('支出：¥1200.00');
    expect(t).toContain('+12.5%');
    expect(t).toContain('72 分');
    expect(t).toContain('餐饮');
    expect(t).toContain('支出上升主要来自');
  });
});

describe('topIncrementAttribution：支出上升归因', () => {
  it('返回较上期增幅最大的分类 Top，忽略下降类', () => {
    const attr = topIncrementAttribution(
      { 餐饮: 520, 交通: 200, 网购: 300 },
      { 餐饮: 100, 交通: 300, 购物: 50 },
      3
    );
    expect(attr[0]).toEqual({ name: '餐饮', delta: 420, total: 520 });
    // 交通下降（-100）不应计入
    expect(attr.some((a) => a.name === '交通')).toBe(false);
  });

  it('仅在当前期出现（上期无）的分类也作为上升来源', () => {
    const attr = topIncrementAttribution({ 旅行: 800 }, {}, 3);
    expect(attr).toEqual([{ name: '旅行', delta: 800, total: 800 }]);
  });

  it('空输入返回空数组', () => {
    expect(topIncrementAttribution({}, {})).toEqual([]);
  });
});