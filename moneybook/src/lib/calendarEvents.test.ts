import { describe, it, expect } from 'vitest';
import {
  nextMonthlyDay,
  normalizeEvents,
  groupByDay,
  buildEvents,
  type CalendarEvent,
  type LoanDueSrc,
} from './calendarEvents';

const ev = (p: Partial<CalendarEvent> & Pick<CalendarEvent, 'date' | 'amount'>): CalendarEvent => ({
  id: `${p.kind ?? 'recurring'}-${p.date}-${p.amount}`,
  kind: p.kind ?? 'recurring',
  date: p.date,
  title: p.title ?? '事件',
  amount: p.amount,
});

describe('calendarEvents.nextMonthlyDay', () => {
  it('正常日直接返回该号', () => {
    expect(nextMonthlyDay(10, '2026-09')).toBe(10);
  });
  it('day 超过当月最后一天（2月）时裁到月末', () => {
    expect(nextMonthlyDay(30, '2026-02')).toBe(28);
  });
  it('闰年 2 月（2024）月末为 29', () => {
    expect(nextMonthlyDay(31, '2024-02')).toBe(29);
  });
  it('31 号在大月（1月）保留为 31', () => {
    expect(nextMonthlyDay(31, '2026-01')).toBe(31);
  });
  it('day 小于 1 时钳制为 1', () => {
    expect(nextMonthlyDay(0, '2026-09')).toBe(1);
  });
});

describe('calendarEvents.normalizeEvents', () => {
  it('只保留属于指定月份的事件', () => {
    const list = [
      ev({ date: '2026-09-15', amount: 100 }),
      ev({ date: '2026-10-01', amount: 200 }),
      ev({ date: '2026-09-30', amount: 50 }),
    ];
    const result = normalizeEvents(list, '2026-09');
    expect(result.map((e) => e.date)).toEqual(['2026-09-15', '2026-09-30']);
  });
  it('同一天内按金额降序排列，不同天按日期升序排列', () => {
    const list = [
      ev({ date: '2026-09-02', amount: 10 }),
      ev({ date: '2026-09-02', amount: 30 }),
      ev({ date: '2026-09-01', amount: 99 }),
      ev({ date: '2026-09-03', amount: 5 }),
    ];
    const result = normalizeEvents(list, '2026-09');
    expect(result.map((e) => `${e.date}:${e.amount}`)).toEqual([
      '2026-09-01:99',
      '2026-09-02:30',
      '2026-09-02:10',
      '2026-09-03:5',
    ]);
  });
  it('缺省月份时使用当前月份过滤', () => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}`;
    const list = [ev({ date: `${ym}-01`, amount: 1 }), ev({ date: '1999-01-01', amount: 1 })];
    expect(normalizeEvents(list)).toHaveLength(1);
  });
});

describe('calendarEvents.groupByDay', () => {
  it('按日分组并得到正确的 day 键', () => {
    const list = [
      ev({ date: '2026-09-05', amount: 1 }),
      ev({ date: '2026-09-05', amount: 2 }),
      ev({ date: '2026-09-21', amount: 3 }),
    ];
    const groups = groupByDay(list);
    expect(Object.keys(groups).map(Number).sort((a, b) => a - b)).toEqual([5, 21]);
    expect(groups[5]).toHaveLength(2);
    expect(groups[21]).toHaveLength(1);
  });
  it('忽略无效日期字符串（不会抛错）', () => {
    const bad: CalendarEvent = { id: 'x', kind: 'loan', date: 'invalid', title: 'x', amount: 1 };
    const groups = groupByDay([ev({ date: '2026-09-08', amount: 9 }), bad]);
    expect(groups[8]).toHaveLength(1);
    expect(Object.keys(groups)).toHaveLength(1);
  });
});

// —— buildEvents 组装逻辑 ——
const due = (p: Partial<LoanDueSrc>): LoanDueSrc => ({
  id: 1, direction: 'borrow', counterparty: '房东', dueDate: '2026-09-10', payment: 3000, ...p,
});

describe('calendarEvents.buildEvents', () => {
  it('周期记账：只保留 next_run 落在本月的项，并生成正确的标题与金额', () => {
    const list = [
      { id: 1, type: 'expense' as const, next_run: '2026-09-05', note: '房贷', amount: 2800 },
      { id: 2, type: 'income' as const, next_run: '2026-10-10', note: '工资', amount: 6000 },
    ];
    const result = buildEvents('2026-09', list, [], []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'recurring-1', kind: 'recurring', date: '2026-09-05', amount: 2800 });
    expect(result[0].title).toContain('支出');
  });

  it('储蓄目标：仅进行中且启用计提，本月已计提时不重复展示', () => {
    const savings = [
      // 已计提过 → 不展示
      { id: 1, status: 'active', name: '旅行', auto_monthly: 500, auto_day: 1, last_auto_month: '2026-09' },
      // 未计提 → 展示
      { id: 2, status: 'active', name: '应急金', auto_monthly: 300, auto_day: 15, last_auto_month: '2026-08' },
      // 已暂停/未启用计提 → 不展示
      { id: 3, status: 'active', name: '停用', auto_monthly: 0, auto_day: 2, last_auto_month: null },
    ];
    const result = buildEvents('2026-09', [], savings, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'savings-2', kind: 'savings', date: '2026-09-15', amount: 300, title: '计提·应急金' });
  });

  it('储蓄目标：计提日超当月最后一天时裁到月末', () => {
    const savings = [{ id: 1, status: 'active', name: '大额', auto_monthly: 100, auto_day: 31, last_auto_month: null }];
    const result = buildEvents('2026-02', [], savings, []);
    expect(result[0].date).toBe('2026-02-28');
  });

  it('借贷还款：仅保留本期应还落在本月的项，借出/借入用不同措辞', () => {
    const loansDue = [
      due({ id: 10, direction: 'borrow', counterparty: '银行', dueDate: '2026-09-20', payment: 1200 }),
      due({ id: 11, direction: 'lend', counterparty: '小王', dueDate: '2026-10-01', payment: 500 }), // 下月 → 排除
    ];
    const result = buildEvents('2026-09', [], [], loansDue);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'loan-10', kind: 'loan', date: '2026-09-20', amount: 1200 });
    expect(result[0].title).toContain('偿还');
    expect(result[0].title).toContain('银行');
  });

  it('借贷：落在本月时借出用「收回」措辞', () => {
    const result = buildEvents('2026-09', [], [], [due({ id: 20, direction: 'lend', counterparty: '小王', dueDate: '2026-09-05', payment: 800 })]);
    expect(result[0].title).toContain('收回');
    expect(result[0].title).toContain('小王');
  });

  it('借贷：无到期日（dueDate 为 null）的直接跳过', () => {
    const result = buildEvents('2026-09', [], [], [due({ id: 30, dueDate: null, payment: 100 })]);
    expect(result).toHaveLength(0);
  });

  it('周期记账：转账类型标题含「转账」', () => {
    const list = [{ id: 1, type: 'transfer' as const, next_run: '2026-09-12', note: '房租互转', amount: 2000 }];
    const result = buildEvents('2026-09', list, [], []);
    expect(result[0].title).toContain('转账');
  });

  it('全部输入为空时返回空数组', () => {
    expect(buildEvents('2026-09', [], [], [])).toEqual([]);
  });
});

describe('calendarEvents 边界/空输入', () => {
  it('normalizeEvents 空数组返回空数组', () => {
    expect(normalizeEvents([], '2026-09')).toEqual([]);
  });
  it('groupByDay 空数组返回空对象', () => {
    expect(groupByDay([])).toEqual({});
  });
});