// 统一数据库访问层
// 本系统最终运行在本机桌面（Tauri + SQLite / moneybook.db），
// 因此仅保留 @tauri-apps/plugin-sql 原生物理后端；已彻底移除浏览器 sql.js / localStorage 分支。
import { isBrowserPreview } from '@/lib/runtime';

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
      // 注意：本系统的数据表结构迁移已完全交由 Rust 侧插件（tauri-plugin-sql）的 migrations/*.sql 管理，
      // 前端的冗余建表逻辑已移除，确保前后端对于数据库 Schema 演进的单一事实来源。
      tauriConn = conn;
      return conn;
    })().catch((e) => {
      connPromise = null;
      throw e;
    });
  }
  return connPromise;
}

// ---------------- 统一 API ----------------

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
 * 降级策略（两层）：
 *  - 浏览器预览（isBrowserPreview）：无真实数据库，事务本不可用，直接顺序执行 + 自动提交，
 *    保证预览功能不失效——这是预期行为；
 *  - 生产 Tauri：tx_begin 失败（命令未注册、数据库打开失败、拿锁超时等）时【拒绝降级】，
 *    抛出明确错误中止写操作。原因是事务是数据一致性的底线——静默降级为顺序执行会让
 *    「INSERT 成功但余额未更新」这类半程数据落库且难以追溯，比报错更危险。
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
    if (isBrowserPreview()) {
      // eslint-disable-next-line no-console
      console.warn('[db] 浏览器预览：事务降级为顺序执行（仅预览可用，无真实原子性）');
    } else {
      // 生产环境绝不静默降级：宁可中止写操作，也不让半程数据落库
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`无法开启原子事务，写操作已中止（${reason}）。请重启应用后重试；若持续出现，请检查安装完整性。`);
    }
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