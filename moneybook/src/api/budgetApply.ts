import dayjs from 'dayjs';
import { execute, runInTransaction, select } from '@/api/db';
import { currentLedgerId } from '@/lib/ledger';
import type { BudgetProposalItem } from '@/api/llm';

/**
 * 预算写入 & 撤销 —— 完全本地执行，不经过 AI/云端，无需脱敏。
 * ---------------------------------------------------------------
 * applyBudgetProposal 针对「当前账本月」（period='monthly'）做 UPSERT：
 *   - 已存在该分类的月度预算 → UPDATE amount
 *   - 不存在 → INSERT
 *   - categoryId 为 null 时写入「总预算」（category_id 为 NULL）
 * 写之前会快照当前账本月的所有月度预算，存到模块级 Map（保留最近 5 份），
 * 返回撤销令牌供 undoBudgetProposal 精确还原：恢复原金额 + 删除新增行。
 */

interface SnapshotRow {
  id: number;
  category_id: number | null;
  amount: number;
}

const snapshots = new Map<string, SnapshotRow[]>();
const MAX_SNAPSHOTS = 5;

function makeToken(): string {
  return `undo_${dayjs().valueOf()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前账本月（YYYY-MM） */
function currentMonth(): string {
  return dayjs().format('YYYY-MM');
}

/** 列出某账本月内所有 'monthly' 周期预算行 */
async function listMonthlyBudgets(ledgerId: number, ym: string): Promise<SnapshotRow[]> {
  return select<SnapshotRow>(
    `SELECT id, category_id, amount FROM budgets
     WHERE period='monthly' AND ledger_id=$1 AND strftime('%Y-%m', start_date)=$2`,
    [ledgerId, ym]
  );
}

export async function applyBudgetProposal(items: BudgetProposalItem[]): Promise<string> {
  const ledgerId = currentLedgerId();
  const ym = currentMonth();
  const selected = items.filter((i) => i && Number(i.amount) > 0);
  if (!selected.length) throw new Error('没有可写入的预算，请至少勾选一项');

  // 写入前快照当前账本月的月度预算，便于撤销
  const before = await listMonthlyBudgets(ledgerId, ym);
  const snapshot = before.map((r) => ({ id: r.id, category_id: r.category_id, amount: r.amount }));

  const token = makeToken();
  if (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  snapshots.set(token, snapshot);

  await runInTransaction(async () => {
    for (const it of selected) {
      const cid = it.categoryId ?? null;
      const existing = await select<{ id: number }>(
        `SELECT id FROM budgets
         WHERE category_id IS NOT DISTINCT FROM $1 AND period='monthly'
           AND ledger_id=$2 AND strftime('%Y-%m', start_date)=$3`,
        [cid, ledgerId, ym]
      );
      if (existing.length) {
        await execute(`UPDATE budgets SET amount=$1 WHERE id=$2`, [it.amount, existing[0].id]);
      } else {
        await execute(
          `INSERT INTO budgets (category_id, amount, period, start_date, ledger_id) VALUES ($1,$2,'monthly',$3,$4)`,
          [cid, it.amount, dayjs().format('YYYY-MM-DD'), ledgerId]
        );
      }
    }
  });

  return token;
}

export async function undoBudgetProposal(token: string): Promise<void> {
  const snapshot = snapshots.get(token);
  if (!snapshot) return;
  const ledgerId = currentLedgerId();
  const ym = currentMonth();
  const snapshotIds = new Set(snapshot.map((r) => r.id));

  await runInTransaction(async () => {
    const current = await listMonthlyBudgets(ledgerId, ym);
    // 删除本次新增的行（id 不在快照中的解除对账本月预算的占位）
    for (const row of current) {
      if (!snapshotIds.has(row.id)) {
        await execute(`DELETE FROM budgets WHERE id=$1`, [row.id]);
      }
    }
    // 恢复快照中已存在行的原金额
    for (const s of snapshot) {
      await execute(`UPDATE budgets SET amount=$1 WHERE id=$2`, [s.amount, s.id]);
    }
  });

  snapshots.delete(token);
}