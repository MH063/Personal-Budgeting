import dayjs from 'dayjs';
import { execute, select, runInTransaction } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { createTransaction } from './transactions';

/**
 * 周期性记账（Recurring Transactions）
 * ---------------------------------------------------------------
 * 用户设定按 日/周/月/年 + 间隔 重复的固定收支（如房租、会员、工资），
 * 到 next_run 当天自动生成一笔真实交易，并推进 next_run 到下次。幂等：生成后即推进，
 * 同一天重复调用不会重复入账。启动/进入页面时触发 applyDueRecurring。
 */

export type RecurringFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurring {
  id: number;
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  category_id: number | null;
  account_id: number;
  to_account_id: number | null;
  note: string;
  frequency: RecurringFrequency;
  interval: number;
  start_date: string;
  end_date: string | null;
  next_run: string | null;
  last_run: string | null;
  is_active: number;
  ledger_id: number;
  created_at: string;
}

export interface RecurringInput {
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  categoryId?: number;
  accountId: number;
  toAccountId?: number;
  note?: string;
  frequency: RecurringFrequency;
  interval?: number;
  startDate: string;
  endDate?: string;
}

/**
 * 计算某个日期之后（含）的首次触发日：按 frequency 与 interval 前进并夹取到合法月末。
 * 纯函数，便于单测。
 */
export function computeNextOccurrence(fromDate: string, frequency: RecurringFrequency, interval = 1): string {
  const base = dayjs(fromDate);
  if (frequency === 'daily') return base.add(interval, 'day').format('YYYY-MM-DD');
  if (frequency === 'weekly') return base.add(interval * 7, 'day').format('YYYY-MM-DD');
  // monthly / yearly：按月份年前进后，若原日（如 31）越界则夹取到该月月末
  const next = frequency === 'monthly' ? base.add(interval, 'month') : base.add(interval, 'year');
  const day = Math.min(base.date(), next.daysInMonth());
  return `${next.format('YYYY-MM')}-${String(day).padStart(2, '0')}`;
}

/** 新建时计算初始 next_run：startDate ≥ 今天则取 startDate，否则取 startDate 之后 ≥ 今天的一次。 */
export function computeInitialNext(startDate: string, today = dayjs().format('YYYY-MM-DD'), frequency: RecurringFrequency = 'monthly', interval = 1): string {
  if (startDate >= today) return startDate;
  let cur = startDate;
  // 最多推进一个保守上限，避免死循环（每周期向前，直到 ≥ today）
  for (let i = 0; i < 2000; i++) {
    const nxt = i === 0 ? startDate : computeNextOccurrence(cur, frequency, interval);
    if (nxt >= today) return nxt;
    cur = nxt;
  }
  return today;
}

export function listRecurring(): Promise<Recurring[]> {
  return select<Recurring>(
    `SELECT * FROM recurring_transactions WHERE ledger_id = $1 ORDER BY is_active DESC, next_run, id`,
    [currentLedgerId()]
  );
}

export async function createRecurring(input: RecurringInput): Promise<number> {
  const ledger = currentLedgerId();
  const interval = input.interval && input.interval > 0 ? input.interval : 1;
  const nextRun = computeInitialNext(input.startDate, dayjs().format('YYYY-MM-DD'), input.frequency, interval);
  const r = await execute(
    `INSERT INTO recurring_transactions
      (type, amount, category_id, account_id, to_account_id, note, frequency, interval, start_date, end_date, next_run, ledger_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [input.type, input.amount, input.categoryId ?? null, input.accountId, input.toAccountId ?? null,
     input.note ?? '', input.frequency, interval, input.startDate, input.endDate ?? null, nextRun, ledger]
  );
  return r.lastInsertId as number;
}

export async function updateRecurring(id: number, input: RecurringInput): Promise<void> {
  const interval = input.interval && input.interval > 0 ? input.interval : 1;
  const nextRun = computeInitialNext(input.startDate, dayjs().format('YYYY-MM-DD'), input.frequency, interval);
  await execute(
    `UPDATE recurring_transactions SET
      type=$1, amount=$2, category_id=$3, account_id=$4, to_account_id=$5, note=$6,
      frequency=$7, interval=$8, start_date=$9, end_date=$10, next_run=$11, is_active=1
     WHERE id=$12`,
    [input.type, input.amount, input.categoryId ?? null, input.accountId, input.toAccountId ?? null,
     input.note ?? '', input.frequency, interval, input.startDate, input.endDate ?? null, nextRun, id]
  );
}

export async function deleteRecurring(id: number): Promise<void> {
  await execute(`DELETE FROM recurring_transactions WHERE id = $1`, [id]);
}

/** 单次启动补齐的周期数上限：防止「数年未打开 + 高频周期」一次性生成海量历史交易，超出部分下次启动再补 */
const MAX_CATCHUP_PER_RUN = 60;

/**
 * 生成所有已到期（next_run ≤ 今天）且启用的周期性交易，并推进 next_run（幂等）。
 * 节奏：一次补齐该计划「错过」的全部周期（从 next_run 循环推进直到超过今天或 end_date），
 * 而非只生成最近一笔——这样长时间未打开应用也不会留下历史缺口。
 * @returns 本次生成笔数
 */
export async function applyDueRecurring(): Promise<number> {
  const today = dayjs().format('YYYY-MM-DD');
  return runInTransaction(async () => {
    const due = await select<Recurring>(
      `SELECT * FROM recurring_transactions
       WHERE ledger_id = $1 AND is_active = 1 AND next_run IS NOT NULL AND next_run <= $2`,
      [currentLedgerId(), today]
    );
    let count = 0;
    for (const r of due) {
      if (r.type === 'transfer' && !r.to_account_id) continue; // 缺转入账户则跳过（不推进，保持原行为）
      let date = r.next_run as string;
      let guard = 0;
      // 循环补齐：每笔生成后立即推进 next_run（幂等），直到超过今天或 end_date
      while (date <= today && (!r.end_date || date <= r.end_date) && guard < MAX_CATCHUP_PER_RUN) {
        await createTransaction({
          type: r.type,
          amount: r.amount,
          categoryId: r.category_id ?? undefined,
          accountId: r.account_id,
          toAccountId: r.to_account_id ?? undefined,
          date,
          note: r.note || undefined,
        });
        count++;
        guard++;
        // 计算下次触发
        const nxt = computeNextOccurrence(date, r.frequency, r.interval);
        if (r.end_date && nxt > r.end_date) {
          await execute(`UPDATE recurring_transactions SET next_run = NULL, is_active = 0, last_run = $1 WHERE id = $2`, [date, r.id]);
          break;
        }
        await execute(`UPDATE recurring_transactions SET next_run = $1, last_run = $2 WHERE id = $3`, [nxt, date, r.id]);
        date = nxt;
      }
    }
    return count;
  });
}