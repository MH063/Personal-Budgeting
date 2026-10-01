// 回收站/撤销核心模块
// -----------------------------------------------------------------------------
// 设计：统一 trash 快照表。各业务 deleteXxx 在删除前（同一事务内）调用
// recordToTrash 把主行（ref_object）与关联子记录（assoc）序列化存入 trash，
// 再执行原有物理删除。恢复时按 entity 分发，保留原主键 id 直接回插，
// 交易/借贷类会重放余额（applyBalance）与虚拟账户同步。
// 为避免与业务模块循环依赖，本文件仅静态依赖 db.ts，业务依赖一律动态 import。
// -----------------------------------------------------------------------------
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';

export type TrashEntity =
  | 'transaction'
  | 'account'
  | 'category'
  | 'tag'
  | 'budget'
  | 'savings_goal'
  | 'loan'
  | 'recurring';

export interface TrashItem {
  id: number;
  entity: TrashEntity;
  entity_id: number;
  ref_object: string;
  assoc: string | null;
  deleted_at: string;
  ledger_id: number;
}

export const TRASH_LABEL: Record<TrashEntity, string> = {
  transaction: '交易记录',
  account: '账户',
  category: '分类',
  tag: '标签',
  budget: '预算',
  savings_goal: '储蓄目标',
  loan: '借贷记录',
  recurring: '周期性记账',
};

/** 删除前记录快照（必须在调用方的事务内调用，与删除同一原子性）。 */
export async function recordToTrash(
  entity: TrashEntity,
  entityId: number,
  refRow: Record<string, unknown>,
  assoc?: unknown
): Promise<void> {
  await execute(
    `INSERT INTO trash (entity, entity_id, ref_object, assoc, deleted_at, ledger_id)
     VALUES ($1,$2,$3,$4,datetime('now','localtime'),$5)`,
    [entity, entityId, JSON.stringify(refRow), assoc != null ? JSON.stringify(assoc) : null, currentLedgerId()]
  );
}

/** 回收站列表（可按实体筛选） */
export async function listTrash(entity?: TrashEntity): Promise<TrashItem[]> {
  const params: unknown[] = [currentLedgerId()];
  let cond = `ledger_id = $1`;
  if (entity) { cond += ` AND entity = $${params.length + 1}`; params.push(entity); }
  return select<TrashItem>(
    `SELECT * FROM trash WHERE ${cond} ORDER BY deleted_at DESC, id DESC`,
    params
  );
}

/** 彻底删除回收站记录（不再可恢复） */
export async function purgeTrash(id: number): Promise<void> {
  await execute(`DELETE FROM trash WHERE id = $1 AND ledger_id = $2`, [id, currentLedgerId()]);
}

/** 清空回收站（某实体或全部），返回删除条数 */
export async function clearTrash(entity?: TrashEntity): Promise<number> {
  const params: unknown[] = [currentLedgerId()];
  let sql = `DELETE FROM trash WHERE ledger_id = $1`;
  if (entity) { sql += ` AND entity = $${params.length + 1}`; params.push(entity); }
  const r = await execute(sql, params);
  return r.rowsAffected;
}

/** 撤销（恢复）某条回收站记录：快照回插 + 余额/虚拟账户补偿 + 删除 trash 行 */
export async function restoreTrash(id: number): Promise<void> {
  const rows = await select<TrashItem>(`SELECT * FROM trash WHERE id = $1 AND ledger_id = $2`, [id, currentLedgerId()]);
  const item = rows[0];
  if (!item) throw new Error('回收站记录不存在或不属于当前账本');

  const ref = JSON.parse(item.ref_object) as Record<string, unknown>;
  const assoc = item.assoc ? JSON.parse(item.assoc) : null;

  // 恢复前依赖预检：交易/借贷/储蓄/周期记账引用的账户、分类等存在性检查，
  // 避免外键失败导致恢复半程（提示先恢复被依赖的实体）
  await assertRestorable(item.entity, ref, assoc);

  // 业务依赖动态加载，避免与业务模块产生循环依赖
  const { applyBalance, syncVirtualAccounts } = await import('./transactions');

  await runInTransaction(async () => {
    switch (item.entity) {
      case 'transaction':
        await restoreTransaction(item.entity_id, ref, assoc);
        await syncVirtualAccounts();
        break;
      case 'loan':
        await restoreLoan(item.entity_id, ref, assoc);
        await syncVirtualAccounts();
        break;
      case 'account':
      case 'category': {
        // 分类为软禁用（is_active=0），行仍存在 → 恢复为启用；账户直接回插
        if (item.entity === 'category') {
          await execute(`UPDATE categories SET is_active = 1 WHERE id = $1`, [item.entity_id]);
        } else {
          await insertRef('accounts', item.entity_id, ref);
        }
        break;
      }
      case 'tag':
        await restoreTag(item.entity_id, ref);
        break;
      case 'budget':
      case 'recurring':
        await insertRef(tableOf(item.entity), item.entity_id, ref);
        break;
      case 'savings_goal':
        await insertRef('savings_goals', item.entity_id, ref);
        if (Array.isArray(assoc?.accounts)) {
          for (const aid of assoc.accounts) {
            await execute(`INSERT OR IGNORE INTO savings_goal_accounts (goal_id, account_id) VALUES ($1,$2)`, [item.entity_id, aid]);
          }
        }
        break;
    }
    // 回插成功后移出回收站
    await execute(`DELETE FROM trash WHERE id = $1`, [id]);
  });
}

/** 恢复前依赖预检：实体引用的账户/分类/借贷等必须仍存在（否则抛出可读错误） */
async function assertRestorable(
  entity: TrashEntity,
  ref: Record<string, unknown>,
  assoc: unknown
): Promise<void> {
  const mustExist = async (table: string, val: unknown, label: string) => {
    if (val == null) return;
    const rows = await select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = $1`, [val]);
    if (!Number(rows[0]?.n)) {
      throw new Error(`恢复失败：所引用的${label}（#${val}）已不存在，请先在回收站恢复该${label}后再试。`);
    }
  };

  switch (entity) {
    case 'transaction':
      await mustExist('accounts', ref.account_id, '账户');
      await mustExist('accounts', ref.to_account_id, '转入账户');
      await mustExist('categories', ref.category_id, '分类');
      break;
    case 'loan':
      await mustExist('accounts', ref.account_id, '关联账户');
      break;
    case 'savings_goal':
      await mustExist('accounts', ref.account_id, '关联账户');
      await mustExist('accounts', ref.auto_account_id, '自动计提账户');
      if (Array.isArray((assoc as { accounts?: unknown[] })?.accounts)) {
        for (const aid of (assoc as { accounts: unknown[] }).accounts) {
          await mustExist('accounts', aid, '归集账户');
        }
      }
      break;
    case 'recurring':
      await mustExist('accounts', ref.account_id, '账户');
      await mustExist('accounts', ref.to_account_id, '转入账户');
      await mustExist('categories', ref.category_id, '分类');
      break;
    case 'budget':
      await mustExist('categories', ref.category_id, '分类');
      break;
    default:
      break;
  }
}

/** 标签快照回插：tags.name 唯一，若同名标签已存在则改为恢复其旧 id（不重复创建） */
async function restoreTag(tagId: number, ref: Record<string, unknown>): Promise<void> {
  const name = String(ref.name ?? '').trim();
  const dup = await select<{ id: number }>(`SELECT id FROM tags WHERE name = $1`, [name]);
  if (dup.length) {
    // 同名标签已存在：不新增，直接把旧 tagId 的行 relink ——
    // 旧 id 已被物理删除，此处仅需把旧 id 行补回会导致 UNIQUE 冲突，
    // 因此改为：若同名行 id 恰为 tagId 则跳过；否则把快照 id 修正为已存在的 id。
    if (dup[0].id === tagId) return;
    // 更新快照中的 id 指向已存在行（供恢复后的引用使用）
    await execute(
      `UPDATE trash SET entity_id = $1, ref_object = $2 WHERE entity = 'tag' AND entity_id = $3 AND ledger_id = $4`,
      [dup[0].id, JSON.stringify({ ...ref, id: dup[0].id }), tagId, currentLedgerId()]
    );
    return;
  }
  await insertRef('tags', tagId, ref);
}

/** 把一行快照按原主键 id 回插到指定表（通用；快照中的 id 列参与值但插入时复用传入的 id） */
async function insertRef(table: string, id: number, ref: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(ref).filter((c) => c !== 'id');
  if (!cols.length) throw new Error('快照为空，无法恢复');
  const colSql = cols.map((c) => `"${c}"`).join(',');
  const ph = cols.map((_, i) => `$${i + 2}`).join(',');
  await execute(`INSERT INTO ${table} (id, ${colSql}) VALUES ($1, ${ph})`, [id, ...cols.map((c) => ref[c] ?? null)]);
}

/** 交易快照回插：原 id 回插 + 余额补偿 + 标签恢复 */
async function restoreTransaction(
  txId: number,
  ref: Record<string, unknown>,
  assoc: { tags?: number[] } | null
): Promise<void> {
  const { applyBalance } = await import('./transactions');
  await insertRef('transactions', txId, ref);
  // 重放余额：与删除时的 reverseBalance 抵消
  await applyBalance({
    type: ref.type as TxType,
    amount: Number(ref.amount),
    categoryId: ref.category_id != null ? Number(ref.category_id) : undefined,
    accountId: Number(ref.account_id),
    toAccountId: ref.to_account_id != null ? Number(ref.to_account_id) : undefined,
    loanId: ref.loan_id != null ? Number(ref.loan_id) : undefined,
    date: String(ref.date),
    note: String(ref.note ?? ''),
  });
  // 恢复标签关联
  if (Array.isArray(assoc?.tags)) {
    for (const tagId of assoc.tags) {
      await execute(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES ($1,$2)`, [txId, tagId]);
    }
  }
}

/** 借贷快照恢复：loans 回插 → 关联交易回插（含余额补偿）→ 还款记录回插 */
async function restoreLoan(
  loanId: number,
  ref: Record<string, unknown>,
  assoc: { txs?: Record<string, unknown>[]; repayments?: Record<string, unknown>[] } | null
): Promise<void> {
  const { applyBalance } = await import('./transactions');
  await insertRef('loans', loanId, ref);
  for (const tx of assoc?.txs ?? []) {
    await insertRef('transactions', Number(tx.id), tx);
    await applyBalance({
      type: tx.type as TxType,
      amount: Number(tx.amount),
      categoryId: tx.category_id != null ? Number(tx.category_id) : undefined,
      accountId: Number(tx.account_id),
      toAccountId: tx.to_account_id != null ? Number(tx.to_account_id) : undefined,
      loanId,
      date: String(tx.date),
      note: String(tx.note ?? ''),
    });
  }
  for (const rp of assoc?.repayments ?? []) {
    await insertRef('loan_repayments', Number(rp.id), rp);
  }
}

function tableOf(entity: TrashEntity): string {
  switch (entity) {
    case 'tag': return 'tags';
    case 'budget': return 'budgets';
    case 'recurring': return 'recurring_transactions';
    default: throw new Error(`不支持的实体类型：${entity}`);
  }
}

/** 预算删除（页面通过此函数，统一进回收站） */
export async function deleteBudgetSafe(id: number): Promise<void> {
  await runInTransaction(async () => {
    const rows = await select<Record<string, unknown>>(`SELECT * FROM budgets WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return;
    await recordToTrash('budget', id, row);
    await execute(`DELETE FROM budgets WHERE id = $1`, [id]);
  });
}

type TxType = 'income' | 'expense' | 'transfer' | 'lend' | 'borrow' | 'repay_in' | 'repay_out';