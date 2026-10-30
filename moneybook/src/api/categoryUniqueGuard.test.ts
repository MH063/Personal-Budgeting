/**
 * 017 迁移（分类唯一护栏）语义测试。
 * ---------------------------------------------------------------
 * 用 sql.js 在内存库里执行真实的 017 迁移 SQL，验证它确实能「根治」分类整批重复：
 *   ① 已存在的活跃重复被合并（引用重定向到保留行）；
 *   ② 之后任何 INSERT（001 重跑 / 导入自动建类 / 手建）都无法再插入活跃重复；
 *   ③ 软删除（is_active=0）后仍可重建同名分类，与 createCategory 的既有语义一致。
 *
 * 为什么用真实 SQL 而不是纯函数断言：迁移一旦在用户库上抛错会导致应用无法打开数据库，
 * 必须在 CI 里跑一遍真实语句，而不是只看字符串是否包含某些片段。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 读取 017 迁移 SQL（相对 vitest 的项目根） */
function loadMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), 'src-tauri/migrations/017_categories_unique_guard.sql'), 'utf8');
}

/** 建立 017 依赖的最小表结构（categories + 四张引用表） */
const MINI_SCHEMA = `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    icon TEXT DEFAULT '',
    color TEXT DEFAULT '#6B7280',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER);
  CREATE TABLE budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER);
  CREATE TABLE recurring_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER);
  CREATE TABLE txn_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER);
`;

/** 初始化内存库：建表 + 插入「两套默认分类」的重复场景，并让交易引用第二套 */
async function setupDupDb() {
  const mod: any = await import('sql.js');
  const SQL = await mod.default();
  const db: any = new SQL.Database();
  db.run(MINI_SCHEMA);
  // 第一套（模拟既有数据）
  db.run(`INSERT INTO categories (name, type, icon, sort_order) VALUES
    ('餐饮','expense','🍜',1), ('工资','income','💰',1);`);
  // 第二套（模拟 001 迁移重跑整批再插一份）
  db.run(`INSERT INTO categories (name, type, icon, sort_order) VALUES
    ('餐饮','expense','🍜',1), ('工资','income','💰',1);`);
  // 交易/预算/周期/模板各挂一条到「第二套餐饮」上，用于验证引用重定向
  db.run(`INSERT INTO transactions (category_id) VALUES (3);`);
  db.run(`INSERT INTO budgets (category_id) VALUES (3);`);
  db.run(`INSERT INTO recurring_transactions (category_id) VALUES (3);`);
  db.run(`INSERT INTO txn_templates (category_id) VALUES (3);`);
  return db;
}

/** 查询单值（取第一行第一列） */
function scalar(db: any, sql: string): unknown {
  const res = db.exec(sql);
  return res.length ? res[0].values[0][0] : undefined;
}

describe('017 迁移：分类唯一护栏', () => {
  it('合并已有的活跃重复：每类只保留一条，且引用重定向到保留行', async () => {
    const db = await setupDupDb();
    db.run(loadMigrationSql());

    // 餐饮/工资各只剩 1 条活跃行
    expect(scalar(db, `SELECT COUNT(*) FROM categories WHERE name='餐饮' AND type='expense' AND is_active=1`)).toBe(1);
    expect(scalar(db, `SELECT COUNT(*) FROM categories WHERE name='工资' AND type='income' AND is_active=1`)).toBe(1);
    // 第二套（id=3）被删除，保留组内最小 id=1，四张引用表全部重定向到 1
    expect(scalar(db, `SELECT COUNT(*) FROM categories`)).toBe(2);
    for (const t of ['transactions', 'budgets', 'recurring_transactions', 'txn_templates']) {
      expect(scalar(db, `SELECT category_id FROM ${t} LIMIT 1`)).toBe(1);
    }
    db.close();
  });

  it('触发器拦截后续重复插入（模拟 001 重跑），且不抛错', async () => {
    const db = await setupDupDb();
    db.run(loadMigrationSql());
    // 模拟 001 整批重跑：再插一次同名同类型
    expect(() => db.run(`INSERT INTO categories (name, type, icon, sort_order) VALUES ('餐饮','expense','🍜',1);`)).not.toThrow();
    expect(scalar(db, `SELECT COUNT(*) FROM categories WHERE name='餐饮' AND type='expense' AND is_active=1`)).toBe(1);
    db.close();
  });

  it('软删除后允许重建同名分类（不误伤删除再建场景）', async () => {
    const db = await setupDupDb();
    db.run(loadMigrationSql());
    // 软删保留行，再建同名：应成功插入新行（id 递增）
    db.run(`UPDATE categories SET is_active=0 WHERE name='餐饮' AND type='expense';`);
    db.run(`INSERT INTO categories (name, type, icon, sort_order) VALUES ('餐饮','expense','🍜',1);`);
    expect(scalar(db, `SELECT COUNT(*) FROM categories WHERE name='餐饮' AND type='expense' AND is_active=1`)).toBe(1);
    expect(scalar(db, `SELECT COUNT(*) FROM categories WHERE name='餐饮' AND type='expense'`)).toBe(2);
    db.close();
  });

  it('无重复时迁移为无操作（幂等，可安全重跑）', async () => {
    const mod: any = await import('sql.js');
    const SQL = await mod.default();
    const db: any = new SQL.Database();
    db.run(MINI_SCHEMA);
    db.run(`INSERT INTO categories (name, type, icon, sort_order) VALUES ('餐饮','expense','🍜',1), ('工资','income','💰',1);`);
    const sql = loadMigrationSql();
    db.run(sql);
    db.run(sql); // 重跑一次
    expect(scalar(db, `SELECT COUNT(*) FROM categories`)).toBe(2);
    db.close();
  });
});
