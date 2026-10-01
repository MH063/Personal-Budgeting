import dayjs from 'dayjs';

/**
 * 日历视图统一事件模型。
 * 聚合三类「待发生」计划：周期记账、储蓄自动计提、借贷还款。
 * kind 决定展示的颜色/图标；date 决定落在日历的哪一天。
 */
export type CalendarEventKind = 'recurring' | 'savings' | 'loan';

export interface CalendarEvent {
  /** 唯一标识（源类型 + 源 id） */
  id: string;
  kind: CalendarEventKind;
  /** 事件日期 YYYY-MM-DD */
  date: string;
  /** 标题（如「工资」「房贷」） */
  title: string;
  /** 金额（正数，展示时带上符号风格） */
  amount: number;
}

/** 计算某月第 day 号的「计提日」：若 day 超过当月最后一天，则取该月月末。 */
export function nextMonthlyDay(day: number, anchorMonth: string): number {
  const last = dayjs(`${anchorMonth}-01`).daysInMonth();
  return Math.min(Math.max(1, Math.floor(day)), last);
}

/**
 * 过滤出属于指定月份的日历事件，并按 (日期升序, 金额降序) 排序。
 * 用 date 前缀匹配月份，稳健处理闰年/月末裁带来的残缺日期。
 */
export function normalizeEvents(events: CalendarEvent[], month = dayjs().format('YYYY-MM')): CalendarEvent[] {
  return events
    .filter((e) => e.date && e.date.startsWith(month))
    .sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date.localeCompare(b.date)));
}

/**
 * 按日（该月多少号）分组，返回 day → 该日事件列表 的映射。
 * 用于日历网格中每个格子展示当天的事件数量徽标。
 */
export function groupByDay(events: CalendarEvent[]): Record<number, CalendarEvent[]> {
  const map: Record<number, CalendarEvent[]> = {};
  for (const e of events) {
    const day = Number(e.date.slice(8, 10));
    if (!Number.isInteger(day) || day < 1 || day > 31) continue; // 一年最多 31 天，过滤残缺/非法日期
    (map[day] ??= []).push(e);
  }
  return map;
}

// —— 组装入参的结构类型（采用最新小类型，避免依赖 api 模块，保证纯函数可单测）——

interface RecurringSrc {
  id: number;
  type: 'income' | 'expense' | 'transfer';
  next_run: string | null;
  note: string;
  amount: number;
}
interface SavingsSrc {
  id: number;
  status: string;
  name: string;
  auto_monthly: number;
  auto_day: number;
  last_auto_month: string | null;
}
/** 借贷侧由组件先用 getLoanNextDue 算出本期应还，再交给本函数（屏蔽 api 依赖） */
export interface LoanDueSrc {
  id: number;
  direction: 'lend' | 'borrow';
  counterparty: string;
  dueDate: string | null;
  payment: number;
}

/**
 * 把三类「计划中事件」组装成日历统一事件（纯函数，不触碰数据库）：
 * - 周期记账：仅保留 next_run 落在本月的项；
 * - 储蓄目标：进行中且启用自动计提，若本月已计提过（last_auto_month === 本月）则不再待发生，
 *   计提日 = 该月 auto_day（超月末裁，用 nextMonthlyDay）；
 * - 借贷：按组件传回的 loansDue（本期应还）中落在本月的项展示。
 * 返回未过滤/未排序的原始事件，交给 normalizeEvents 处理。
 */
export function buildEvents(
  month: string,
  recurring: RecurringSrc[],
  savings: SavingsSrc[],
  loansDue: LoanDueSrc[]
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const r of recurring) {
    if (!r.next_run || !r.next_run.startsWith(month)) continue;
    const typeLabel = r.type === 'income' ? '收入' : r.type === 'transfer' ? '转账' : '支出';
    events.push({
      id: `recurring-${r.id}`,
      kind: 'recurring',
      date: r.next_run,
      title: `${typeLabel} · ${r.note || '周期'}`,
      amount: r.amount,
    });
  }

  for (const g of savings) {
    if (g.status !== 'active' || g.auto_monthly <= 0) continue;
    if (g.last_auto_month === month) continue; // 本月已计提，不再待发生
    const day = nextMonthlyDay(g.auto_day, month);
    events.push({
      id: `savings-${g.id}`,
      kind: 'savings',
      date: `${month}-${`${day}`.padStart(2, '0')}`,
      title: `计提·${g.name}`,
      amount: g.auto_monthly,
    });
  }

  for (const loan of loansDue) {
    if (!loan.dueDate || !loan.dueDate.startsWith(month)) continue;
    const dir = loan.direction === 'lend' ? '收回' : '偿还';
    events.push({
      id: `loan-${loan.id}`,
      kind: 'loan',
      date: loan.dueDate,
      title: `${dir}·${loan.counterparty || '借贷'}`,
      amount: loan.payment,
    });
  }

  return events;
}