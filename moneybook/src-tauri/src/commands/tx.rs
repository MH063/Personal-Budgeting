// 真正的原子事务（Rust 侧实现）
// -----------------------------------------------------------------------------
// 背景：tauri-plugin-sql 只暴露「连接池 + 单条语句」的执行接口（pool.execute），
// 前端每次调用都会各自从池里借一条连接、用完立刻归还；而 sqlx 在连接归还池时会
// 回滚所有未结束的事务。于是前端 `runInTransaction` 发出的 BEGIN 会被立即回滚、
// 中间语句走自动提交（数据已真实落库）、最后的 COMMIT 落到另一条连接上抛出
// `cannot commit - no transaction is active`——表现为「写入成功却报失败」。
//
// 本模块在 Rust 侧持有【一条】独立连接并显式 BEGIN，前端可在同一事务内连续执行
// 多条语句（tx_execute / tx_select），最终 tx_commit 或 tx_rollback，从而获得
// 真正的原子性：任一步失败则整体回滚，不会留下半程写入。
// depth 支持嵌套：内层调用只累加深度，提交/回滚统一由最外层处理。
// -----------------------------------------------------------------------------

use rusqlite::{types::ToSql, Connection};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// 单条语句执行结果（与插件 execute 的返回语义对齐）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxExecResult {
    pub affected: u64,
    pub last_insert_id: i64,
}

struct TxConn {
    conn: Connection,
    /// 嵌套深度：>1 表示内层调用，提交/回滚交由最外层处理
    depth: u32,
}

/// 事务连接持有器（注册为 Tauri 全局状态）
#[derive(Default)]
pub struct TxState(Mutex<Option<TxConn>>);

/// 定位与插件同一份数据库文件。
/// 说明：路径取自启动时的数据目录决策结果（datadir::DbLocation）——插件连接、
/// 本事务连接、自检/备份/存储统计全部指向同一份文件；便携模式切换后也不会错位。
fn db_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let loc = app.state::<crate::datadir::DbLocation>();
    Ok(loc.file.clone())
}

/// JSON 参数 → rusqlite 绑定值
fn json_to_sql(v: &JsonValue) -> Box<dyn ToSql> {
    match v {
        JsonValue::Null => Box::new(Option::<String>::None),
        JsonValue::Bool(b) => Box::new(if *b { 1_i64 } else { 0_i64 }),
        JsonValue::Number(n) => match n.as_i64() {
            Some(i) => Box::new(i),
            None => Box::new(n.as_f64().unwrap_or(0.0)),
        },
        JsonValue::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

/// rusqlite 值 → JSON（供前端按列名读取）
fn sql_to_json(v: rusqlite::types::ValueRef<'_>) -> JsonValue {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::from(i),
        ValueRef::Real(f) => JsonValue::from(f),
        ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => JsonValue::String(format!("<blob:{}B>", b.len())),
    }
}

/// 在指定连接上执行单条语句
fn exec_one(conn: &mut Connection, sql: &str, params: &[JsonValue]) -> Result<TxExecResult, String> {
    let boxed: Vec<Box<dyn ToSql>> = params.iter().map(json_to_sql).collect();
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let affected = {
        let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
        stmt.execute(refs.as_slice()).map_err(|e| e.to_string())?
    };
    Ok(TxExecResult { affected: affected as u64, last_insert_id: conn.last_insert_rowid() })
}

/// 在【同一条连接】上原子执行一批语句：任一步失败则整体回滚。
/// 抽成独立函数便于用内存库单测验证原子性（生产路径为 tx_execute 分步 + commit/rollback，
/// 故此函数仅在测试构建中存在，避免 dead_code 警告）。
#[cfg(test)]
pub fn exec_batch_atomic(
    conn: &mut Connection,
    stmts: &[(String, Vec<JsonValue>)],
) -> Result<Vec<TxExecResult>, String> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(stmts.len());
    for (sql, params) in stmts {
        match exec_one(conn, sql, params) {
            Ok(v) => out.push(v),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    if let Err(e) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e.to_string());
    }
    Ok(out)
}

/// 开始事务（可嵌套：内层复用外层事务，仅累加深度）
#[tauri::command]
pub fn tx_begin(app: tauri::AppHandle, state: tauri::State<'_, TxState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "事务状态获取失败".to_string())?;
    if let Some(tx) = guard.as_mut() {
        tx.depth += 1;
        return Ok(());
    }
    let conn = Connection::open(db_file(&app)?).map_err(|e| e.to_string())?;
    // 等待锁：避免与插件连接池中的读连接互相抢锁时直接失败
    conn.busy_timeout(Duration::from_secs(8)).map_err(|e| e.to_string())?;
    // 与 sqlx 默认一致地开启外键约束，保证级联删除等语义与插件连接完全相同
    conn.execute_batch("PRAGMA foreign_keys = ON").map_err(|e| e.to_string())?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    *guard = Some(TxConn { conn, depth: 1 });
    Ok(())
}

/// 事务内执行写语句
#[tauri::command]
pub fn tx_execute(
    state: tauri::State<'_, TxState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<TxExecResult, String> {
    let mut guard = state.0.lock().map_err(|_| "事务状态获取失败".to_string())?;
    let tx = guard
        .as_mut()
        .ok_or_else(|| "没有进行中的事务（tx_begin 未调用）".to_string())?;
    exec_one(&mut tx.conn, &sql, &params)
}

/// 事务内查询（可见同事务内尚未提交的修改）
#[tauri::command]
pub fn tx_select(
    state: tauri::State<'_, TxState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<JsonMap<String, JsonValue>>, String> {
    let mut guard = state.0.lock().map_err(|_| "事务状态获取失败".to_string())?;
    let tx = guard
        .as_mut()
        .ok_or_else(|| "没有进行中的事务（tx_begin 未调用）".to_string())?;

    let boxed: Vec<Box<dyn ToSql>> = params.iter().map(json_to_sql).collect();
    let refs: Vec<&dyn ToSql> = boxed.iter().map(|b| b.as_ref()).collect();
    let mut stmt = tx.conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
    // 先取列名（拷成拥有所有权的 String，及时结束对 stmt 的不可变借用）
    let col_names: Vec<String> = {
        let names = stmt.column_names();
        names.iter().map(|s| s.to_string()).collect()
    };
    let mut rows = stmt.query(refs.as_slice()).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut m = JsonMap::new();
        for (i, name) in col_names.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| e.to_string())?;
            m.insert(name.clone(), sql_to_json(v));
        }
        out.push(m);
    }
    Ok(out)
}

/// 提交最外层事务并释放连接（内层仅减少深度）
#[tauri::command]
pub fn tx_commit(state: tauri::State<'_, TxState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "事务状态获取失败".to_string())?;
    if guard.is_none() {
        return Ok(());
    }
    // 内层：只减深度，不提交
    if let Some(tx) = guard.as_mut() {
        if tx.depth > 1 {
            tx.depth -= 1;
            return Ok(());
        }
    }
    // 外层：提交；无论成功与否都释放连接（失败时连接被丢弃，等同回滚）
    let res = {
        let tx = guard.as_mut().ok_or_else(|| "事务状态异常".to_string())?;
        tx.conn.execute_batch("COMMIT").map_err(|e| e.to_string())
    };
    *guard = None;
    res
}

/// 回滚事务并释放连接（任何一层出错都应整体回滚）
#[tauri::command]
pub fn tx_rollback(state: tauri::State<'_, TxState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "事务状态获取失败".to_string())?;
    if guard.is_none() {
        return Ok(());
    }
    let res = {
        let tx = guard.as_mut().ok_or_else(|| "事务状态异常".to_string())?;
        tx.conn.execute_batch("ROLLBACK").map_err(|e| e.to_string())
    };
    *guard = None;
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 原子性回归：批量中任一条语句失败，前面的写入必须整体回滚（不留半程数据）。
    #[test]
    fn exec_batch_atomic_rolls_back_on_failure() {
        let mut conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)")
            .expect("建表");

        let stmts = vec![
            ("INSERT INTO t (v) VALUES ($1)".to_string(), vec![JsonValue::from("a")]),
            // 第 2 条故意违反 NOT NULL，触发失败
            ("INSERT INTO t (v) VALUES ($1)".to_string(), vec![JsonValue::Null]),
        ];
        let err = exec_batch_atomic(&mut conn, &stmts);
        assert!(err.is_err(), "含失败语句的批次应返回错误");

        // 关键断言：第 1 条也不能留下
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("计数");
        assert_eq!(n, 0, "失败应整体回滚，不得留下半程写入");
    }

    /// 成功路径：多条语句全部生效并返回各自结果
    #[test]
    fn exec_batch_atomic_commits_on_success() {
        let mut conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)")
            .expect("建表");

        let stmts = vec![
            ("INSERT INTO t (v) VALUES ($1)".to_string(), vec![JsonValue::from("a")]),
            ("INSERT INTO t (v) VALUES ($1)".to_string(), vec![JsonValue::from("b")]),
        ];
        let out = exec_batch_atomic(&mut conn, &stmts).expect("批次应成功");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].affected, 1);
        assert!(out[1].last_insert_id >= 2, "应能拿到最新自增 id");

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("计数");
        assert_eq!(n, 2);
    }

    /// 类型绑定：null / 布尔 / 整数 / 浮点 / 字符串都能正确落库
    #[test]
    fn json_params_bind_with_expected_types() {
        let mut conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch("CREATE TABLE t (a TEXT, b INTEGER, c REAL)")
            .expect("建表");
        let stmts = vec![(
            "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)".to_string(),
            vec![JsonValue::Null, JsonValue::from(true), JsonValue::from(1.5)],
        )];
        exec_batch_atomic(&mut conn, &stmts).expect("插入成功");
        let (a, b, c): (Option<String>, i64, f64) = conn
            .query_row("SELECT a, b, c FROM t", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("读取");
        assert_eq!(a, None);
        assert_eq!(b, 1);
        assert_eq!(c, 1.5);
    }
}