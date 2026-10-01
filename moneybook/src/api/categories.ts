import { execute, select, runInTransaction } from './db';
import { recordToTrash } from './trash';

export interface Category {
  id: number;
  name: string;
  type: 'income' | 'expense';
  icon: string;
  color: string;
  sort_order: number;
  is_active: number;
}

export async function listCategories(type?: 'income' | 'expense'): Promise<Category[]> {
  const conds = ['is_active = 1'];
  const params: unknown[] = [];
  if (type) { conds.push(`type = $${params.length + 1}`); params.push(type); }
  return select<Category>(
    `SELECT * FROM categories WHERE ${conds.join(' AND ')} ORDER BY sort_order, id`,
    params
  );
}

export async function createCategory(p: {
  name: string; type: Category['type']; icon?: string; color?: string;
}): Promise<number> {
  const r = await execute(
    `INSERT INTO categories (name, type, icon, color, sort_order) VALUES ($1,$2,$3,$4,0)`,
    [p.name, p.type, p.icon ?? '', p.color ?? '#6B7280']
  );
  return r.lastInsertId as number;
}

export async function updateCategory(id: number, p: Partial<Category>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  (Object.keys(p) as (keyof Category)[]).forEach((k) => {
    if (k === 'id') return;
    sets.push(`${k === 'type' ? k : k.replace(/_/g, '_')} = $${params.length + 1}`);
    params.push((p as any)[k]);
  });
  if (!sets.length) return;
  params.push(id);
  await execute(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

/** 删除分类（软删除：置 is_active=0；同时记入回收站，支持恢复/彻底删除） */
export async function deleteCategory(id: number): Promise<void> {
  return runInTransaction(async () => {
    const rows = await select<Record<string, unknown>>(`SELECT * FROM categories WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return;
    // 分类行仍保留（软删除），快照供回收站展示与恢复
    await recordToTrash('category', id, row);
    await execute(`UPDATE categories SET is_active = 0 WHERE id = $1`, [id]);
  });
}