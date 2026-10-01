import { createTransaction } from './transactions';
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { recordToTrash } from './trash';

export interface SavingsGoal {
  id: number;
  name: string;
  target_amount: number;
  current_amount: number;
  account_id: number | null;
  account_ids: number[];       // 归集账户集合（多账户归集）
  target_date: string | null;
  icon: string;
  color: string;
  status: 'active' | 'completed' | 'cancelled';
  auto_monthly: number;        // 每月自动计提金额（0 = 不自动计提）
  auto_account_id: number | null; // 自动计提的来源账户
  auto_day: number;            // 每月第几天自动计提（1-31）
  last_auto_month: string | null; // 最近一次已计提的月份 'YYYY-MM'
  note: string;
}

export async function listGoals(): Promise<SavingsGoal[]> {
  const goals = await select<SavingsGoal>(
    `SELECT * FROM savings_goals WHERE ledger_id = $1 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id`,
    [currentLedgerId()]
  );
  // 批量挂载归集账户集合（兼容未挂接关联表的旧数据：回退到 account_id）
  const links = await select<{ goal_id: number; account_id: number }>(
    `SELECT ga.goal_id, ga.account_id FROM savings_goal_accounts ga
     JOIN savings_goals g ON g.id = ga.goal_id WHERE g.ledger_id = $1`,
    [currentLedgerId()]
  );
  for (const goal of goals) {
    const ids = links.filter((l) => l.goal_id === goal.id).map((l) => l.account_id);
    goal.account_ids = ids.length ? ids : (goal.account_id != null ? [goal.account_id] : []);
  }
  return goals;
}

async function replaceGoalAccounts(goalId: number, accountIds: number[]): Promise<void> {
  await execute(`DELETE FROM savings_goal_accounts WHERE goal_id = $1`, [goalId]);
  for (const aid of accountIds) {
    await execute(`INSERT INTO savings_goal_accounts (goal_id, account_id) VALUES ($1,$2)`, [goalId, aid]);
  }
}

export async function createGoal(p: {
  name: string; targetAmount: number; accountIds?: number[]; targetDate?: string; icon?: string; color?: string; note?: string;
  autoMonthly?: number; autoAccountId?: number | null; autoDay?: number;
}): Promise<number> {
  return runInTransaction(async () => {
    const ids = p.accountIds && p.accountIds.length ? p.accountIds : [];
    const primary = ids[0] ?? null;
    const r = await execute(
      `INSERT INTO savings_goals (name, target_amount, account_id, target_date, icon, color, auto_monthly, auto_account_id, auto_day, note, ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [p.name, p.targetAmount, primary, p.targetDate ?? null, p.icon ?? '🎯', p.color ?? '#10B981',
       p.autoMonthly ?? 0, p.autoAccountId ?? null, p.autoDay ?? 1, p.note ?? '', currentLedgerId()]
    );
    const goalId = r.lastInsertId as number;
    if (ids.length) await replaceGoalAccounts(goalId, ids);
    return goalId;
  });
}

/** 从来源账户向目标归集账户存入一笔（转账实现），并推进进度 */
export async function depositToGoal(goalId: number, p: {
  amount: number; accountId: number; toAccountId?: number; date: string;
}): Promise<void> {
  return runInTransaction(async () => {
    const [goal] = await select<SavingsGoal>(`SELECT * FROM savings_goals WHERE id = $1`, [goalId]);
    if (!goal) throw new Error('目标不存在');
    // 归集账户集合：优先用该期指定的 toAccountId，否则取首个归集账户，再回退单账户
    let accounts = await select<{ account_id: number }>(
      `SELECT account_id FROM savings_goal_accounts WHERE goal_id = $1`, [goalId]
    );
    const ids = accounts.map((r) => r.account_id).filter((x) => x != null);
    const pool: number[] = ids.length ? ids : (goal.account_id != null ? [goal.account_id] : []);
    if (!pool.length) throw new Error('目标未关联归集账户');
    const to = p.toAccountId && pool.includes(p.toAccountId) ? p.toAccountId : pool[0];
    if (p.amount <= 0) throw new Error('金额必须大于 0');

    await createTransaction({
      type: 'transfer',
      amount: p.amount,
      accountId: p.accountId,
      toAccountId: to,
      date: p.date,
      note: `存入目标「${goal.name}」`,
    });
    const newAmount = goal.current_amount + p.amount;
    const status = newAmount >= goal.target_amount - 0.0001 ? 'completed' : 'active';
    await execute(
      `UPDATE savings_goals SET current_amount = $1, status = $2 WHERE id = $3`,
      [newAmount, status, goalId]
    );
  });
}

/** 从目标归集账户支取一笔（反向转账实现），并回减进度。
 *  资金来源自动选择：优先使用调用方指定的 accountId，否则在归集账户池中
 *  取第一个余额足够支付该笔的账户，避免把单个账户扣成负余额。 */
export async function withdrawFromGoal(goalId: number, p: {
  amount: number; accountId?: number; toAccountId: number; date: string;
}): Promise<void> {
  return runInTransaction(async () => {
    const [goal] = await select<SavingsGoal>(`SELECT * FROM savings_goals WHERE id = $1`, [goalId]);
    if (!goal) throw new Error('目标不存在');
    if (p.amount <= 0) throw new Error('金额必须大于 0');
    if (goal.current_amount < p.amount - 0.0001) throw new Error('支取金额不能超过已存入进度');

    // 归集账户集合：优先取关联表，回退到单账户 account_id
    const links = await select<{ account_id: number }>(
      `SELECT account_id FROM savings_goal_accounts WHERE goal_id = $1`, [goalId]
    );
    const ids = links.map((r) => r.account_id).filter((x) => x != null);
    const pool: number[] = ids.length ? ids : (goal.account_id != null ? [goal.account_id] : []);
    if (pool.includes(p.toAccountId)) throw new Error('转入账户不能是目标的归集账户');

    // 选择来源账户：优先级 = 调用方指定(若在池中且余额足) > 池中首个余额充足的账户
    const candidates = pool.filter((a) => a !== p.toAccountId);
    if (!candidates.length) throw new Error('目标未关联可支取的归集账户');
    const prefs = p.accountId && candidates.includes(p.accountId)
      ? [p.accountId, ...candidates.filter((c) => c !== p.accountId)]
      : candidates;
    let src: number | null = null;
    for (const c of prefs) {
      const [acc] = await select<{ balance: number }>(`SELECT balance FROM accounts WHERE id = $1`, [c]);
      if (acc && acc.balance >= p.amount - 0.0001) { src = c; break; }
    }
    if (src == null) throw new Error('归集账户余额不足，无法完成支取');

    await createTransaction({
      type: 'transfer',
      amount: p.amount,
      accountId: src,
      toAccountId: p.toAccountId,
      date: p.date,
      note: `支取「${goal.name}」`,
    });

    const newAmount = goal.current_amount - p.amount;
    let status = goal.status;
    // 允许从"已完成"支取回来：回减后低于目标金额则恢复为进行中
    if (goal.status === 'completed' && newAmount < goal.target_amount - 0.0001) status = 'active';
    await execute(
      `UPDATE savings_goals SET current_amount = $1, status = $2 WHERE id = $3`,
      [newAmount, status, goalId]
    );
  });
}

export async function updateGoal(id: number, p: {
  name?: string; targetAmount?: number; accountIds?: number[]; targetDate?: string | null;
  icon?: string; color?: string; note?: string;
  autoMonthly?: number; autoAccountId?: number | null; autoDay?: number;
}): Promise<void> {
  await runInTransaction(async () => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => { sets.push(`${col} = $${params.length + 1}`); params.push(val); };
    if (p.name !== undefined) push('name', p.name);
    if (p.targetAmount !== undefined) push('target_amount', p.targetAmount);
    if (p.accountIds !== undefined) push('account_id', (p.accountIds[0] ?? null));
    if (p.targetDate !== undefined) push('target_date', p.targetDate);
    if (p.icon !== undefined) push('icon', p.icon);
    if (p.color !== undefined) push('color', p.color);
    if (p.autoMonthly !== undefined) push('auto_monthly', p.autoMonthly);
    if (p.autoAccountId !== undefined) push('auto_account_id', p.autoAccountId);
    if (p.autoDay !== undefined) push('auto_day', p.autoDay);
    if (p.note !== undefined) push('note', p.note);
    if (sets.length) { params.push(id); await execute(`UPDATE savings_goals SET ${sets.join(', ')} WHERE id = $${params.length}`, params); }
    if (p.accountIds !== undefined) await replaceGoalAccounts(id, p.accountIds);
  });
}

export async function cancelGoal(goalId: number): Promise<void> {
  await execute(`UPDATE savings_goals SET status = 'cancelled' WHERE id = $1`, [goalId]);
}

/** 删除储蓄目标。
 *  存入目标产生的资金已进入关联的储蓄账户，删除目标仅移除目标跟踪记录，
 *  不回收已存入资金（它们仍是账户内余额，可另作他用）。
 *  删除前把目标及归集账户关联快照写入回收站，支持恢复。
 */
export async function deleteGoal(goalId: number): Promise<void> {
  return runInTransaction(async () => {
    const [goal] = await select<Record<string, unknown>>(`SELECT * FROM savings_goals WHERE id = $1`, [goalId]);
    if (goal) {
      const accRows = await select<{ account_id: number }>(`SELECT account_id FROM savings_goal_accounts WHERE goal_id = $1`, [goalId]);
      await recordToTrash('savings_goal', goalId, goal, { accounts: accRows.map((r) => r.account_id) });
    }
    await execute(`DELETE FROM savings_goals WHERE id = $1`, [goalId]);
  });
}

/**
 * 触发"储蓄自动计提"：遍历启用了自动计提的进行中目标，
 * 若本月已到计提日（auto_day）且本月尚未计提过（last_auto_month != 当前月），
 * 则从来源账户向归集账户转账 auto_monthly，并推进进度、记录计提月份。
 * 带来源账户/自动计提金额的目标才有意义；来源账户余额不足会跳过并保留（下次再补）。
 */
export async function applyDueAutoSavings(): Promise<number> {
  const goals = await select<SavingsGoal>(
    `SELECT * FROM savings_goals
     WHERE ledger_id = $1 AND status = 'active'
       AND auto_monthly > 0 AND auto_account_id IS NOT NULL`,
    [currentLedgerId()]
  );
  let ran = 0;
  for (const goal of goals) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}`;
    // 未到本月计提日，或本月已计提过 → 跳过
    if (now.getDate() < goal.auto_day) continue;
    if ((goal.last_auto_month ?? '') === ym) continue;
    // 来源账户余额不足 → 跳过，保留 last_auto_month 以待下月
    const [src] = await select<{ balance: number }>(`SELECT balance FROM accounts WHERE id = $1`, [goal.auto_account_id]);
    if (!src || src.balance < goal.auto_monthly - 0.0001) continue;

    await depositToGoal(goal.id, {
      amount: goal.auto_monthly,
      accountId: goal.auto_account_id!,
      date: `${ym}-${`${now.getDate()}`.padStart(2, '0')}`,
    });
    await execute(`UPDATE savings_goals SET last_auto_month = $1 WHERE id = $2`, [ym, goal.id]);
    ran++;
  }
  return ran;
}