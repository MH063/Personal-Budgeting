/**
 * 恢复出厂设置：原子清空全部业务数据并重建默认数据
 * -----------------------------------------------------------------------------
 * 语义与「全新安装」一致：
 *   1) 清空所有业务表（交易、账户、分类、账本、预算、借贷、储蓄、订阅、回收站、
 *      审计、持仓等）+ 重置自增序列；
 *   2) 重建默认分类与默认账本（与 src-tauri/migrations/001_init.sql 一致），
 *      其余设置项全部清空（AI 配置、主题、知识库、规则等回到默认）；
 *   3) 故意不写 seed_done：页面刷新后首次引导（OnboardingModal）会自动重新弹出。
 *
 * 为什么用 defer_foreign_keys：事务连接（commands/tx.rs）显式开启了
 * foreign_keys=ON，而动态枚举表清空时无法保证「子表先删、父表后删」的顺序。
 * SQLite 允许 defer_foreign_keys 在事务内切换：开启后外键检查推迟到提交时刻，
 * 提交前数据已全部清空、重建的默认数据无跨表引用，检查必然通过——
 * 于是不必为每张表维护删除顺序，未来新增表也自动覆盖。
 */
import { execute, runInTransaction, select } from '@/api/db';

/** 与迁移 001 / schema.ts 完全一致的默认分类（恢复出厂后重建，用户无需手动重建） */
const DEFAULT_CATEGORIES: ReadonlyArray<[string, string, string, string, number]> = [
  ['餐饮', 'expense', '🍜', '#EF4444', 1],
  ['交通', 'expense', '🚌', '#3B82F6', 2],
  ['购物', 'expense', '🛍️', '#8B5CF6', 3],
  ['居住', 'expense', '🏠', '#F59E0B', 4],
  ['娱乐', 'expense', '🎮', '#EC4899', 5],
  ['医疗', 'expense', '💊', '#14B8A6', 6],
  ['教育', 'expense', '📚', '#6366F1', 7],
  ['其他支出', 'expense', '📦', '#6B7280', 8],
  ['工资', 'income', '💰', '#10B981', 1],
  ['奖金', 'income', '🎁', '#F59E0B', 2],
  ['兼职', 'income', '💼', '#3B82F6', 3],
  ['投资收益', 'income', '📈', '#8B5CF6', 4],
  ['红包', 'income', '🧧', '#EF4444', 5],
  ['其他收入', 'income', '💵', '#6B7280', 6],
];

export interface ResetResult {
  /** 被清空的业务表数量 */
  clearedTables: number;
}

/**
 * 执行恢复出厂设置（单个原子事务，任一步失败整体回滚）。
 * 调用方负责：执行成功后的页面刷新（重置全部前端内存状态）与引导提示。
 */
export async function resetAllData(): Promise<ResetResult> {
  let clearedTables = 0;
  await runInTransaction(async () => {
    // 先推迟外键检查（详见文件头注释），再动态枚举清空所有用户表
    await execute('PRAGMA defer_foreign_keys = ON', []);
    const tables = await select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    );
    for (const t of tables) {
      if (t.name === 'sqlite_sequence') continue; // 自增序列统一在最后重置
      await execute(`DELETE FROM "${t.name}"`, []);
      clearedTables += 1;
    }
    // 重置自增序列：让新数据 id 从 1 重新开始（与全新安装一致）
    await execute('DELETE FROM sqlite_sequence', []);

    // 重建默认分类
    for (const [name, type, icon, color, sortOrder] of DEFAULT_CATEGORIES) {
      await execute(
        'INSERT INTO categories (name, type, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)',
        [name, type, icon, color, sortOrder]
      );
    }
    // 重建默认账本并激活；其余设置项全部清空（各偏好回到默认），
    // seed_done 缺失会在刷新后重新触发首次引导
    await execute("INSERT INTO ledgers (name) VALUES ('默认账本')", []);
    await execute(
      "INSERT INTO settings (key, value) VALUES ('active_ledger_id', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
      []
    );
  });
  return { clearedTables };
}
