// 统一数据库访问层
// 本系统最终运行在本机桌面（Tauri + SQLite / moneybook.db），
// 因此仅保留 @tauri-apps/plugin-sql 原生物理后端；已彻底移除浏览器 sql.js / localStorage 分支。
import {
  SAVINGS_ACCOUNTS_SQL,
  LOAN_ACCRUED_SQL,
  RECURRING_SQL,
  HOLDINGS_SQL,
  TXN_TEMPLATE_SQL,
  TRASH_SQL,
  RECON_SQL,
  RECON_TRANSACTION_COL,
} from './schema';

export interface ExecResult {
  rowsAffected: number;
  lastInsertId?: number;
}

type SqlRow = Record<string, unknown>;

// ---------------- Tauri 连接缓存 ----------------
// 惰性单例：首次访问时加载插件连接，并在就绪后幂等补齐缺失 schema。
let tauriConn: any = null;
let connPromise: Promise<any> | null = null;

async function getTauriConn(): Promise<any> {
  if (tauriConn) return tauriConn;
  if (!connPromise) {
    connPromise = (async () => {
      const DBM = await import('@tauri-apps/plugin-sql');
      // 连接串必须与 Rust 侧 add_migrations 注册串「逐字一致」：
      // tauri-plugin-sql 按连接串字符串全等匹配迁移表，若前端自行拼接路径，
      // 一旦与 Rust 决策结果有差异（大小写、分隔符、目录不同），迁移就会失配。
      // 数据目录在 Rust 启动时已决策（便携优先 / 回退标准），此处直接取结果使用。
      const { invoke } = await import('@tauri-apps/api/core');
      const dbUrl = await invoke<string>('get_db_url');
      const conn = await DBM.default.load(dbUrl);
      // 补齐桌面库缺失的表/列（幂等；迁移文件由插件保证执行，此处只覆盖迁移文件未覆盖的增量）
      await ensureRawSchema(conn);
      tauriConn = conn;
      return conn;
    })().catch((e) => {
      connPromise = null;
      throw e;
    });
  }
  return connPromise;
}

// ---------------- 幂等 schema 补齐（桌面端） ----------------
// 使用插件原生连接执行，避免经由导出函数造成递归初始化。
// 全部操作均为「检查存在 → 缺失才 ALTER/CREATE」，多次运行无副作用。
async function hasTable(conn: any, name: string): Promise<boolean> {
  const rows = await conn.select(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`,
    [name]
  );
  return rows.length > 0;
}

async function hasColumn(conn: any, table: string, column: string): Promise<boolean> {
  const rows = await conn.select(`PRAGMA table_info(${table})`);
  return rows.some((r: any) => r.name === column);
}

/** 若表中缺某列则补充（幂等） */
async function ensureColumn(conn: any, table: string, column: string, ddl: string): Promise<void> {
  const ok = await hasColumn(conn, table, column);
  if (ok) return;
  await conn.execute(ddl);
}

/** 若缺某表则建表（幂等；sql 需为 CREATE TABLE IF NOT EXISTS） */
async function ensureTable(conn: any, name: string, sql: string): Promise<void> {
  const ok = await hasTable(conn, name);
  if (ok) return;
  await conn.execute(sql);
}

/**
 * 补齐桌面端 schema 之间（插件迁移文件 001~007 之外）仍缺失的结构：
 * 借贷逾期利息列、业务表 ledger_id、投资持仓表、回收站表、储蓄归集/自动计提、
 * 周期性记账表、银行对账表。实现与旧 sql.js 迁移链语义一致，但全部幂等。
 */
async function ensureRawSchema(conn: any): Promise<void> {
  try {
    // 1) 默认账本 + 活跃账本指针
    if (await hasTable(conn, 'ledgers')) {
      const lc = await conn.select(`SELECT COUNT(*) AS c FROM ledgers`);
      if ((lc[0]?.c ?? 0) === 0) {
        await conn.execute(`INSERT INTO ledgers (name) VALUES ('默认账本')`);
      }
    }
    const sv = await conn.select(`SELECT COUNT(*) AS c FROM settings WHERE key = 'active_ledger_id'`);
    if ((sv[0]?.c ?? 0) === 0) {
      await conn.execute(`INSERT INTO settings (key, value) VALUES ('active_ledger_id', '1')`);
    }

    // 2) 业务表补 ledger_id 列（旧库增量，categories 等可能缺失）
    const bizTables = ['categories', 'accounts', 'loans', 'transactions', 'loan_repayments', 'savings_goals', 'budgets'];
    for (const t of bizTables) {
      if (await hasTable(conn, t)) {
        await ensureColumn(conn, t, 'ledger_id', `ALTER TABLE ${t} ADD COLUMN ledger_id INTEGER DEFAULT 1`);
      }
    }

    // 3) 消费/借贷扩展列
    if (await hasTable(conn, 'loans')) {
      await ensureColumn(conn, 'loans', 'rate', `ALTER TABLE loans ADD COLUMN rate REAL NOT NULL DEFAULT 0`);
      await ensureColumn(conn, 'loans', 'periods', `ALTER TABLE loans ADD COLUMN periods INTEGER`);
      await ensureColumn(conn, 'loans', 'compound', `ALTER TABLE loans ADD COLUMN compound INTEGER NOT NULL DEFAULT 0`);
      await ensureColumn(conn, 'loans', 'method', `ALTER TABLE loans ADD COLUMN method TEXT NOT NULL DEFAULT 'balloon'`);
      await ensureColumn(conn, 'loans', 'first_repay_date', `ALTER TABLE loans ADD COLUMN first_repay_date TEXT`);
      await ensureColumn(conn, 'loans', 'repay_day', `ALTER TABLE loans ADD COLUMN repay_day INTEGER`);
      // 逾期利息累计列（迁移文件 001~007 均未覆盖）
      if (!(await hasColumn(conn, 'loans', 'accrued_interest')) || !(await hasColumn(conn, 'loans', 'interest_accrued_until'))) {
        await conn.execute(LOAN_ACCRUED_SQL);
      }
    }

    // 4) 还款本金/利息拆分 + 期次列
    if (await hasTable(conn, 'loan_repayments')) {
      await ensureColumn(conn, 'loan_repayments', 'interest', `ALTER TABLE loan_repayments ADD COLUMN interest REAL NOT NULL DEFAULT 0`);
      await ensureColumn(conn, 'loan_repayments', 'period', `ALTER TABLE loan_repayments ADD COLUMN period INTEGER`);
    }

    // 5) 储蓄目标自动计提列 + 多账户归集表
    if (await hasTable(conn, 'savings_goals')) {
      await ensureColumn(conn, 'savings_goals', 'auto_monthly', `ALTER TABLE savings_goals ADD COLUMN auto_monthly REAL NOT NULL DEFAULT 0`);
      await ensureColumn(conn, 'savings_goals', 'auto_account_id', `ALTER TABLE savings_goals ADD COLUMN auto_account_id INTEGER`);
      await ensureColumn(conn, 'savings_goals', 'auto_day', `ALTER TABLE savings_goals ADD COLUMN auto_day INTEGER DEFAULT 1`);
      await ensureColumn(conn, 'savings_goals', 'last_auto_month', `ALTER TABLE savings_goals ADD COLUMN last_auto_month TEXT`);
    }
    await ensureTable(conn, 'savings_goal_accounts', SAVINGS_ACCOUNTS_SQL);

    // 6) 周期性记账表
    await ensureTable(conn, 'recurring_transactions', RECURRING_SQL);

    // 7) 投资持仓表
    await ensureTable(conn, 'account_holdings', HOLDINGS_SQL);

    // 8) 回收站表
    await ensureTable(conn, 'trash', TRASH_SQL);

    // 8.1) 常用交易模板表（智能补全·模板复用）
    await ensureTable(conn, 'txn_templates', TXN_TEMPLATE_SQL);

    // 8.5) 导入历史审计表（记录每次批量导入的文件/条数，便于追溯与去重排障）
    await ensureTable(conn, 'import_logs', `
      CREATE TABLE IF NOT EXISTS import_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 1,
        imported INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0,
        created_accounts INTEGER NOT NULL DEFAULT 0,
        created_categories INTEGER NOT NULL DEFAULT 0,
        ledger_id INTEGER DEFAULT 1,
        imported_at TEXT NOT NULL
      )`);

    // 8.6) AI/规则 审计与反馈日志（谁/何时/改了什么/依据，供可解释与回写闭环）
    await ensureTable(conn, 'ai_audit_log', `
      CREATE TABLE IF NOT EXISTS ai_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id INTEGER DEFAULT 1,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        before TEXT,
        after TEXT,
        basis TEXT,
        method TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )`);

    // 9) 银行对账表 + transactions 对账归属列
    await ensureTable(conn, 'reconciliations', RECON_SQL);
    if (await hasTable(conn, 'transactions')) {
      await ensureColumn(conn, 'transactions', 'reconciliation_id', RECON_TRANSACTION_COL);
      // 10) 交易扩展字段（支付时间/付款方式/收款方全称/订单号/商家订单号）——老库增量补列，全部幂等
      await ensureColumn(conn, 'transactions', 'pay_time', `ALTER TABLE transactions ADD COLUMN pay_time TEXT`);
      await ensureColumn(conn, 'transactions', 'pay_method', `ALTER TABLE transactions ADD COLUMN pay_method TEXT`);
      await ensureColumn(conn, 'transactions', 'payee', `ALTER TABLE transactions ADD COLUMN payee TEXT`);
      await ensureColumn(conn, 'transactions', 'order_no', `ALTER TABLE transactions ADD COLUMN order_no TEXT`);
      await ensureColumn(conn, 'transactions', 'merchant_order_no', `ALTER TABLE transactions ADD COLUMN merchant_order_no TEXT`);
    }
  } catch (e) {
    // schema 补齐失败不应阻断后续查询，仅记录
    // eslint-disable-next-line no-console
    console.error('[db] 桌面库 schema 补齐失败：', e);
  }
}

// ---------------- 统一 API ----------------

/**
 * 检测是否运行在 Tauri 桌面环境（存在 IPC 全局对象）。
 * 非 Tauri（如纯浏览器 vite 预览）时数据库不可达，select/execute 静默降级为空数据，
 * 避免每个查询都触发 `@tauri-apps/plugin-sql` 的 invoke 错误而刷屏；桌面端不受影响。
 */
let browserPreview: boolean | null = null;
function isBrowserPreview(): boolean {
  if (browserPreview === null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    browserPreview = typeof (window as any)?.__TAURI_INTERNALS__ === 'undefined';
  }
  return browserPreview;
}

/**
 * 归一化 Tauri IPC 抛出的错误。
 *
 * 由来：Rust command 返回 Err(String) 时，Tauri 的 invoke 会直接以「字符串」reject，
 * 而不是 Error 实例。此时 `err.message` 为 undefined，各处 `${(e as Error).message}`
 * 就会渲染成「删除失败：undefined」，把真实原因完全吞掉。此处统一包装为 Error，
 * 使所有上层 catch 都能拿到可读信息。
 */
async function normalizeError<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
  }
}

/**
 * 进行中的事务深度。
 * >0 时 select/execute 改走 Rust 的 tx_* 命令（同一条连接），
 * 从而与事务内其它语句处于同一原子事务中；否则走插件连接池（自动提交）。
 */
let txDepth = 0;

/** 事务命令调用（惰性 import，避免浏览器预览下加载 Tauri API） */
async function txInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizeError(invoke<T>(cmd, args));
}

export async function select<T = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (isBrowserPreview()) return [] as T[]; // 纯浏览器预览：返回空集，正常解析为空态
  // 事务内：走 Rust 持有的同一条连接，才能看到本事务尚未提交的数据
  if (txDepth > 0) return txInvoke<T[]>('tx_select', { sql, params });
  const conn = await getTauriConn();
  const rows = await normalizeError(conn.select(sql, params) as Promise<T[]>);
  return rows as T[];
}

export async function execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
  if (isBrowserPreview()) return { rowsAffected: 0 }; // 纯浏览器预览：写操作为空操作
  // 事务内：走 Rust 持有的同一条连接
  if (txDepth > 0) {
    const r = await txInvoke<{ affected: number; lastInsertId: number }>('tx_execute', { sql, params });
    return { rowsAffected: r.affected, lastInsertId: r.lastInsertId };
  }
  const conn = await getTauriConn();
  const res = await normalizeError(conn.execute(sql, params) as Promise<{ rowsAffected: number; lastInsertId?: number }>);
  return { rowsAffected: res.rowsAffected, lastInsertId: res.lastInsertId };
}

/**
 * 「事务」封装 —— 真原子版本。
 *
 * 实现：在 Rust 侧持有一条独立连接并显式 BEGIN（commands/tx.rs），
 * 事务期间 select/execute 全部改走该连接，因此：
 *  - 同事务内的读能看到自己未提交的写；
 *  - 任一步抛错即整体 ROLLBACK，不会留下半程写入。
 *
 * 为什么不能用 BEGIN/COMMIT 直接发语句：插件是 sqlx 连接池，每条语句各自借还连接，
 * sqlx 在连接归还时会回滚未结束的事务 —— 那会导致「写成功却 COMMIT 失败」的假报错
 * （详见 tx.rs 顶部说明）。故必须由 Rust 侧持有连接。
 *
 * 降级保护：若 tx_begin 不可用（浏览器预览、命令未注册、拿不到写锁等），
 * 自动退回「顺序执行 + 自动提交」，保证功能不因事务不可用而整体失效。
 */
export async function runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (isBrowserPreview()) return fn();

  // 先确保插件连接已就绪：它负责建库与执行迁移/补齐 schema，
  // 否则我们自己的连接可能打开到一个尚未初始化的空库。
  let began = false;
  try {
    await getTauriConn();
    await txInvoke('tx_begin');
    began = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[db] 无法开启原子事务，已降级为顺序执行：', e);
  }

  txDepth++;
  try {
    const result = await fn();
    if (began) await txInvoke('tx_commit');
    return result;
  } catch (e) {
    if (began) {
      try { await txInvoke('tx_rollback'); } catch { /* 回滚失败时原错误优先抛出 */ }
    }
    throw e;
  } finally {
    txDepth--;
  }
}

/** 一批语句在同一事务内原子执行（批量执行入口）。任一条失败则全部回滚。 */
export async function executeBatch(
  statements: { sql: string; params?: unknown[] }[]
): Promise<ExecResult[]> {
  return runInTransaction(async () => {
    const out: ExecResult[] = [];
    for (const s of statements) out.push(await execute(s.sql, s.params ?? []));
    return out;
  });
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number | null; // 桌面端磁盘无硬配额 → null
  percent: number | null;
}

/** 桌面端：读取真实 SQLite 数据库文件（及 -wal/-shm 日志）在磁盘上的字节数 */
async function tauriDbBytes(): Promise<number> {
  const { invoke } = await import('@tauri-apps/api/core');
  const path = await invoke<string>('get_db_path');
  const { stat } = await import('@tauri-apps/plugin-fs');
  let total = 0;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const s = await stat(p);
      total += s.size;
    } catch {
      /* 文件不存在则忽略 */
    }
  }
  return total;
}

/** 估算数据库文件占用（真实磁盘字节数，无硬配额） */
export async function estimateStorageUsage(): Promise<StorageUsage | null> {
  try {
    const used = await tauriDbBytes();
    return { usedBytes: used, quotaBytes: null, percent: null };
  } catch {
    return null;
  }
}

/** 获取当前活跃账本 id */
export async function getActiveLedgerId(): Promise<number> {
  const rows = await select<{ value: string }>(`SELECT value FROM settings WHERE key = 'active_ledger_id'`);
  return Number(rows[0]?.value) || 1;
}

/** 设置当前活跃账本 id */
export async function setActiveLedgerId(id: number): Promise<void> {
  await execute(
    `INSERT INTO settings (key, value) VALUES ('active_ledger_id', $1)
     ON CONFLICT(key) DO UPDATE SET value = $1`,
    [String(id)]
  );
}