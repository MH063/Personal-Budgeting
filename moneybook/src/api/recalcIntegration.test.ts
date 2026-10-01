/**
 * 「导入后余额重算」端到端集成验证。
 *
 * 用 sql.js 在内存中搭建一个真实的 SQLite 数据库，替换 ./db 访问层，
 * 端到端跑通：bulkImportTransactions（余额中性写入流水）→ recalcAccountBalances（按流水重算真实账户余额），
 * 断言账户余额从「未变」变为「与流水一致」，并验证重算幂等。
 * 此文件只验证计算口径与函数链路，不等同于 Tauri 桌面版真实落库。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { setCurrentLedger } from '@/lib/ledger';
import { bulkImportTransactions, type ImportRow } from './import';
import { recalcAccountBalances } from './transactions';
import { execute, select } from './db';

// —— 共享 sql.js 连接：在建表的 mock 工厂与测试体内都通过它访问同一内存库 ——
const { ensureDbAsync, ensureDbSync } = vi.hoisted(() => {
  // 内联最小 schema（与 src/api/schema.ts 的 INIT_SQL 中 accounts/categories/transactions 对齐，
  // 并补上 ensureRawSchema 幂等补的 ledger_id 与 5 个交易扩展字段列）
  const INLINE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('cash','bank','ewallet','credit','investment','savings','receivable','payable')),
      balance REAL DEFAULT 0,
      initial_balance REAL DEFAULT 0,
      icon TEXT DEFAULT '', color TEXT DEFAULT '#6B7280',
      is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      ledger_id INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('income','expense')),
      icon TEXT DEFAULT '', color TEXT DEFAULT '#6B7280', sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')),
      ledger_id INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','lend','borrow','repay_in','repay_out')),
      amount REAL NOT NULL CHECK(amount > 0),
      category_id INTEGER, account_id INTEGER NOT NULL, to_account_id INTEGER, loan_id INTEGER,
      date TEXT NOT NULL, note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')),
      pay_time TEXT, pay_method TEXT, payee TEXT, order_no TEXT, merchant_order_no TEXT,
      ledger_id INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ledgers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `;
  let db: any = null;
  let ready: Promise<any> | null = null;
  function ensureDbSync(): any {
    return db;
  }
  async function ensureDbAsync(): Promise<any> {
    if (db) return db;
    if (!ready) {
      ready = (async () => {
        const mod: any = await import('sql.js');
        // vitest/node 下 default 是 initSqlJs 工厂函数，调用后返回含 Database 的命名空间
        const SQL = await mod.default();
        db = new SQL.Database();
        db.run(INLINE_SCHEMA);
      })();
    }
    await ready;
    return db;
  }
  return { ensureDbAsync, ensureDbSync };
});

// 把 ./db 访问层替换为真实 sql.js 内存库实现，让 import.ts / transactions.ts 走真实 SQL
vi.mock('./db', () => {
  interface SqlRow {
    [key: string]: unknown;
  }
  // 行转换：getColumnNames 与 stmt.get()（数组按列序）打包为对象
  function rowsFrom(sql: string, params: unknown[]): SqlRow[] {
    const db = (ensureDbSync as () => any)() as any;
    const stmt = db.prepare(sql);
    stmt.bind(params ?? []);
    const cols = stmt.getColumnNames();
    const rows: SqlRow[] = [];
    while (stmt.step()) {
      const vals = stmt.get() as unknown[];
      const o: SqlRow = {};
      cols.forEach((c: string, i: number) => { o[c] = vals[i]; });
      rows.push(o);
    }
    stmt.free();
    return rows;
  }
  return {
    select: async (sql: string, params: unknown[] = []) => {
      const db = await ensureDbAsync();
      void db;
      return rowsFrom(sql, params);
    },
    execute: async (sql: string, params: unknown[] = []) => {
      const db = await ensureDbAsync();
      db.run(sql, params ?? []);
      // 取最后插入行的自增 id
      const r = db.exec('SELECT last_insert_rowid() AS id');
      const lastInsertId = r[0]?.values?.[0]?.[0] as number | undefined;
      return { rowsAffected: db.getRowsModified(), lastInsertId };
    },
    runInTransaction: async (fn: () => Promise<unknown>) => fn(),
  };
});

async function resetTables() {
  // 清库并预置账户（余额中性前提：账户带手工初始余额，预先把余额设为与初始一致）
  await execute('DELETE FROM transactions');
  await execute('DELETE FROM accounts');
  await execute('DELETE FROM categories');
  await execute(`INSERT INTO accounts (name, type, balance, initial_balance, ledger_id)
    VALUES ('微信','ewallet',100,100,1), ('现金','cash',500,500,1), ('花呗','credit',0,0,1)`);
}

/** 构造一条导入行 */
function makeRow(partial: Partial<ImportRow> & { date: string; type: ImportRow['type']; amount: number; account: string; line: number }): ImportRow {
  return { ...partial } as ImportRow;
}

describe('导入后余额重算（sql.js 真实 SQLite 端到端）', () => {
  beforeAll(async () => {
    await ensureDbAsync();
  });

  it('导入为余额中性：仅写流水，导入后账户余额不变', async () => {
    await resetTables();
    setCurrentLedger(1);
    const rows: ImportRow[] = [
      makeRow({ date: '2026-09-01', type: 'expense', amount: 300, account: '微信', note: '购物', line: 1 }),
      makeRow({ date: '2026-09-02', type: 'income', amount: 1000, account: '现金', note: '工资', line: 2 }),
      makeRow({ date: '2026-09-03', type: 'transfer', amount: 200, account: '微信', toAccount: '现金', note: '提现', line: 3 }),
      makeRow({ date: '2026-09-04', type: 'expense', amount: 500, account: '花呗', note: '网购', line: 4 }),
    ];
    const res = await bulkImportTransactions(rows, { autoCreate: false });
    expect(res.imported).toBe(4);
    expect(res.createdAccounts).toHaveLength(0);

    // 余额中性：导入后账户 balance 仍未变动
    const accs = await select<{ name: string; balance: number }>(`SELECT name, balance FROM accounts ORDER BY id`);
    const byName = Object.fromEntries(accs.map((a) => [a.name, a.balance]));
    expect(byName['微信']).toBe(100);
    expect(byName['现金']).toBe(500);
    expect(byName['花呗']).toBe(0);
  });

  it('重算后余额 = 初始余额 + Σ流水净额，与口径一致', async () => {
    await resetTables();
    setCurrentLedger(1);
    const rows: ImportRow[] = [
      makeRow({ date: '2026-09-01', type: 'expense', amount: 300, account: '微信', note: '购物', line: 1 }),
      makeRow({ date: '2026-09-02', type: 'income', amount: 1000, account: '现金', note: '工资', line: 2 }),
      makeRow({ date: '2026-09-03', type: 'transfer', amount: 200, account: '微信', toAccount: '现金', note: '提现', line: 3 }),
      makeRow({ date: '2026-09-04', type: 'expense', amount: 500, account: '花呗', note: '网购', line: 4 }),
    ];
    await bulkImportTransactions(rows, { autoCreate: false });

    const changed = await recalcAccountBalances();
    expect(changed).toHaveLength(3);
    // 微信：100 - 300(支出) - 200(转出) = -400
    const weixin = changed.find((c) => c.name === '微信');
    expect(weixin?.before).toBe(100);
    expect(weixin?.after).toBe(-400);
    // 现金：500 + 1000(收入) + 200(转入) = 1700
    const cash = changed.find((c) => c.name === '现金');
    expect(cash?.before).toBe(500);
    expect(cash?.after).toBe(1700);
    // 花呗：0 - 500(消费) = -500（负债）
    const huabei = changed.find((c) => c.name === '花呗');
    expect(huabei?.before).toBe(0);
    expect(huabei?.after).toBe(-500);

    // 余额已落库
    const accs = await select<{ name: string; balance: number }>(`SELECT name, balance FROM accounts ORDER BY id`);
    const byName = Object.fromEntries(accs.map((a) => [a.name, a.balance]));
    expect(byName['微信']).toBe(-400);
    expect(byName['现金']).toBe(1700);
    expect(byName['花呗']).toBe(-500);
  });

  it('重算幂等：对已一致账户再次重算返回空数组不写入', async () => {
    await resetTables();
    setCurrentLedger(1);
    const rows: ImportRow[] = [
      makeRow({ date: '2026-09-01', type: 'expense', amount: 300, account: '微信', note: '购物', line: 1 }),
      makeRow({ date: '2026-09-02', type: 'income', amount: 1000, account: '现金', note: '工资', line: 2 }),
      makeRow({ date: '2026-09-04', type: 'expense', amount: 500, account: '花呗', note: '网购', line: 3 }),
    ];
    await bulkImportTransactions(rows, { autoCreate: false });
    const first = await recalcAccountBalances();
    expect(first.length).toBeGreaterThan(0);
    // 再次重算：余额已与流水一致，不应再有任何变化（幂等）
    const second = await recalcAccountBalances();
    expect(second).toEqual([]);
  });

  it('排除投资与应收/应付：它们不参与流水重算', async () => {
    await resetTables();
    // 追加一个 storage investment + 一个 receivable 虚拟账户
    await execute(`INSERT INTO accounts (name, type, balance, initial_balance, ledger_id)
      VALUES ('基金账户','investment',3000,3000,1), ('小李欠款','receivable',500,0,1)`);
    setCurrentLedger(1);
    const rows: ImportRow[] = [
      makeRow({ date: '2026-09-01', type: 'expense', amount: 100, account: '微信', note: 'a', line: 1 }),
    ];
    await bulkImportTransactions(rows, { autoCreate: false });
    const changed = await recalcAccountBalances();
    // 仅真实账户（微信）被重算；投资/应收账户被排除
    expect(changed.map((c) => c.name)).toEqual(['微信']);
    const accs = await select<{ name: string; balance: number; type: string }>(`SELECT name, balance, type FROM accounts`);
    const inv = accs.find((a) => a.type === 'investment');
    const rec = accs.find((a) => a.type === 'receivable');
    expect(inv?.balance).toBe(3000); // 保持用户/持仓逻辑给定的值，不被流水覆盖
    expect(rec?.balance).toBe(500);  // 由借贷同步维护，不被流水覆盖
  });

  it('已有同名账户时导入直接复用，不重复创建、不误报「创建失败」', async () => {
    // 逐条清表（sql.js 的 run 一次只执行第一条分号语句，多语句需拆开），再预置账户
    await execute(`DELETE FROM transactions`);
    await execute(`DELETE FROM accounts`);
    await execute(`DELETE FROM categories`);
    await execute(`INSERT INTO accounts (name, type, balance, initial_balance, ledger_id)
      VALUES ('湖北农信储蓄卡(2440)','bank',0,0,1), ('工商银行储蓄卡(1055)','bank',0,0,1), ('花呗','credit',0,0,1)`);
    setCurrentLedger(1);
    const rows: ImportRow[] = [
      makeRow({ date: '2026-09-12', type: 'expense', amount: 900, account: '湖北农信储蓄卡(2440)', note: '转账', line: 1 }),
      makeRow({ date: '2026-09-10', type: 'expense', amount: 19.95, account: '湖北农信储蓄卡(2440)', note: '话费', line: 2 }),
      makeRow({ date: '2026-09-08', type: 'expense', amount: 162.53, account: '花呗', note: '油费', line: 3 }),
    ];
    const res = await bulkImportTransactions(rows, { autoCreate: true });
    expect(res.imported).toBe(3);
    expect(res.skipped).toHaveLength(0);
    // 全部复用已有账户：不应新创建任何账户
    expect(res.createdAccounts).toHaveLength(0);
    // 账户表中三个账户各仅一条，未被重复创建
    const accCounts = await select<{ name: string; count: number }>(
      `SELECT name, COUNT(*) AS count FROM accounts GROUP BY name`);
    const byName = Object.fromEntries(accCounts.map((a) => [a.name, a.count]));
    expect(byName['湖北农信储蓄卡(2440)']).toBe(1);
    expect(byName['工商银行储蓄卡(1055)']).toBe(1);
    expect(byName['花呗']).toBe(1);
    // 交易正常落库，且 account_id 指向已有账户
    const tx = await select<{ account_id: number; amount: number }>(`SELECT account_id, amount FROM transactions ORDER BY id`);
    expect(tx).toHaveLength(3);
    const accId = await select<{ id: number }>(`SELECT id FROM accounts WHERE name = '湖北农信储蓄卡(2440)'`);
    expect(tx.some((t) => t.account_id === accId[0].id)).toBe(true);
  });
});