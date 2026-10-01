import { select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { calcLoanInterest, checkOverdueLoans, getLoanNextDue, listLoans } from './loans';
import { listGoals } from './savings';
import { getBudgetVsActual } from './stats';
import dayjs from 'dayjs';

export interface TodoItem {
  kind: 'overdue_loan' | 'due_loan' | 'goal_due' | 'goal_auto' | 'over_budget';
  severity: 'danger' | 'warning' | 'info';
  title: string;
  detail: string;
  link: string;
}

/** 聚合"待办/提醒"：逾期借贷、近期应还、目标到期、自动计提应还、预算超支 */
export async function getTodoItems(): Promise<TodoItem[]> {
  const items: TodoItem[] = [];
  const today = dayjs();

  // 1) 逾期借贷（含每期的逾期期次）
  await checkOverdueLoans();
  const loans = await listLoans();
  for (const l of loans) {
    if (l.remaining <= 0.0001) continue;
    // 逾期借贷（到期一次与分期型均适用；逾期由 checkOverdueLoans 统一判定）
    if (l.status === 'overdue') {
      const dueDate = l.due_date ?? getLoanNextDue(l)?.dueDate ?? undefined;
      const accrued = Number(l.accrued_interest) || 0;
      items.push({
        kind: 'overdue_loan', severity: 'danger',
        title: `${l.direction === 'lend' ? '借出' : '借入'}「${l.counterparty}」已逾期`,
        detail: dueDate
          ? `剩余本金 ${l.remaining.toFixed(2)}，最近到期 ${dueDate}${accrued > 0.0001 ? `，逾期利息 ${accrued.toFixed(2)}` : ''}`
          : `剩余本金 ${l.remaining.toFixed(2)}${accrued > 0.0001 ? `，逾期利息 ${accrued.toFixed(2)}` : ''}`,
        link: '/loans',
      });
      continue;
    }
    // 期次化：下一期应还即将到期
    const next = getLoanNextDue(l);
    if (next && next.dueDate) {
      const days = dayjs(next.dueDate).diff(today, 'day');
      if (days >= 0 && days <= 7) {
        items.push({
          kind: 'due_loan', severity: days <= 3 ? 'warning' : 'info',
          title: `${l.direction === 'lend' ? '应收' : '应还'}「${l.counterparty}」第 ${next.period} 期${days === 0 ? '今天' : `还有 ${days} 天`}到期`,
          detail: `应还本金 ${next.principal.toFixed(2)} + 利息 ${next.interest.toFixed(2)} = ${next.payment.toFixed(2)}`,
          link: '/loans',
        });
      }
    }
  }

  // 2) 储蓄目标：临近目标日期 / 本月自动计提将触发
  const goals = await listGoals();
  for (const g of goals) {
    if (g.status !== 'active') continue;
    if (g.target_date) {
      const days = dayjs(g.target_date).diff(today, 'day');
      if (days >= 0 && days <= 7) {
        items.push({
          kind: 'goal_due', severity: days === 0 ? 'warning' : 'info',
          title: `储蓄目标「${g.name}」${days === 0 ? '今天到期' : `还有 ${days} 天到期`}`,
          detail: `进度 ${g.current_amount.toFixed(2)} / ${g.target_amount.toFixed(2)}`,
          link: '/savings',
        });
      }
    }
    if (g.auto_monthly > 0 && today.date() >= g.auto_day) {
      const autoDone = (g.last_auto_month ?? '') === today.format('YYYY-MM');
      if (!autoDone) {
        items.push({
          kind: 'goal_auto', severity: 'warning',
          title: `储蓄目标「${g.name}」本月自动计提${today.date() === g.auto_day ? '今天' : '已到期'}待执行`,
          detail: `将从来源账户自动转入 ${g.auto_monthly.toFixed(2)}`,
          link: '/savings',
        });
      }
    }
  }

  // 3) 预算超支
  try {
    const budgetVs = await getBudgetVsActual(today.format('YYYY-MM'));
    for (const b of budgetVs) {
      if (b.actual > b.budget_amount) {
        items.push({
          kind: 'over_budget', severity: 'danger',
          title: `预算「${b.category_name ?? '总预算'}」已超支`,
          detail: `已用 ${b.actual.toFixed(2)} / 预算 ${b.budget_amount.toFixed(2)}`,
          link: '/settings',
        });
      }
    }
  } catch { /* 忽略预算查询失败 */ }

  return items;
}

// 避免未使用告警：calcLoanInterest 保留用于未来按利息提醒
export { calcLoanInterest };