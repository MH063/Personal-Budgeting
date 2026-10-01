import { execute, runInTransaction, select } from './db';
import { recordToTrash } from './trash';

export interface Tag {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

/** 全部标签 */
export async function listTags(): Promise<Tag[]> {
  return select<Tag>('SELECT * FROM tags ORDER BY id');
}

/** 新建标签，返回 id */
export async function createTag(name: string, color?: string): Promise<number> {
  const rs = await execute(`INSERT INTO tags (name, color) VALUES ($1, $2)`, [name.trim(), color || '#6B7280']);
  return rs.lastInsertId!;
}

/** 重命名/改色 */
export async function updateTag(id: number, name: string, color?: string): Promise<void> {
  await execute(`UPDATE tags SET name = $2, color = $3 WHERE id = $1`, [id, name.trim(), color || '#6B7280']);
}

/** 删除标签（transaction_tags 级联清除；删除前记入回收站，可恢复） */
export async function deleteTag(id: number): Promise<void> {
  return runInTransaction(async () => {
    const rows = await select<Record<string, unknown>>(`SELECT * FROM tags WHERE id = $1`, [id]);
    const row = rows[0];
    if (row) await recordToTrash('tag', id, row);
    await execute(`DELETE FROM tags WHERE id = $1`, [id]);
  });
}

/** 获取某笔交易的标签 id 列表 */
export async function getTransactionTags(txId: number): Promise<number[]> {
  const rows = await select<{ tag_id: number }>(`SELECT tag_id FROM transaction_tags WHERE transaction_id = $1`, [txId]);
  return rows.map((r) => r.tag_id);
}

/** 覆盖设置某笔交易的标签集合（多对多） */
export async function setTransactionTags(txId: number, tagIds: number[]): Promise<void> {
  await runInTransaction(async () => {
    await execute(`DELETE FROM transaction_tags WHERE transaction_id = $1`, [txId]);
    for (const id of tagIds) {
      await execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`, [txId, id]);
    }
  });
}

type Tx = { id: number; name: string; color: string };

/** 批量：一组交易各自的标签（用于列表展示），返回 { 交易id: Tag[] } */
export async function listTagsByTransactions(txIds: number[]): Promise<Record<number, Tag[]>> {
  if (!txIds.length) return {};
  const ph = txIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await select<{ transaction_id: number } & Tx>(
    `SELECT tt.transaction_id, t.id, t.name, t.color
     FROM transaction_tags tt
     JOIN tags t ON tt.tag_id = t.id
     WHERE tt.transaction_id IN (${ph})
     ORDER BY t.id`,
    txIds
  );
  const map: Record<number, Tag[]> = {};
  for (const r of rows) {
    (map[r.transaction_id] ??= []).push({ id: r.id, name: r.name, color: r.color, created_at: '' });
  }
  return map;
}