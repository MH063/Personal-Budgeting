// 数据损坏自愈：启动自检 + 自动快照 + 损坏自动回滚
// 目标：moneybook.db 一旦损坏，应用仍能正常启动，绝不因「打不开数据库」而白屏或拒绝服务。
// 策略：
//   1) 每次启动先做 integrity_check；数据库正常时写一份安全快照 moneybook.db.bak。
//      快照必须用 VACUUM INTO 导出：库运行在 WAL 模式，直接 fs::copy 主文件只会拿到
//      「上一次 checkpoint 时的状态」，未落盘的已提交事务留在 -wal 中，快照会残缺（历史上曾只剩 4KB 空壳）。
//      快照每次启动都刷新（用户要求）：库体积为百 KB 级，VACUUM INTO 毫秒级完成，
//      换取「快照永远是最新一致状态」，损坏回滚不再受陈旧窗口影响。
//   2) 检测到损坏（integrity_check 返回非 "ok"）时，优先用 .bak 快照覆盖回滚。
//   3) 回滚后的库仍损坏，则把损坏文件（含 -wal/-shm 伴随文件）隔离为 moneybook.db.corrupt.<时间戳>，
//      再重建空库（数据可去回收站/导出找回）。
use rusqlite::Connection;
use tauri::Manager;

/// moneybook.db 的完整路径：取自启动时的数据目录决策结果（便携优先 / 回退标准目录），
/// 与插件连接、事务连接使用同一份路径，避免多处各自推算导致指向不一致。
pub fn db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let loc = app.state::<crate::datadir::DbLocation>();
    Ok(loc.file.clone())
}

/// 快照路径：moneybook.db.bak
fn backup_path(db: &std::path::Path) -> std::path::PathBuf {
    let mut p = db.as_os_str().to_owned();
    p.push(".bak");
    std::path::PathBuf::from(p)
}

/// 计算 SQLite 伴随文件路径：moneybook.db → moneybook.db-wal / moneybook.db-shm
fn sidecar(db: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut p = db.as_os_str().to_owned();
    p.push(suffix);
    std::path::PathBuf::from(p)
}

/// 隔离损坏文件：把 moneybook.db 及其 -wal/-shm 伴随文件一起改名留档。
/// 只移走主文件而留下旧 WAL，重建的新库会被旧预写日志污染。
fn quarantine(db: &std::path::Path) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for suffix in ["", "-wal", "-shm"] {
        let src = sidecar(db, suffix);
        if !src.exists() {
            continue;
        }
        let mut dst = src.as_os_str().to_owned();
        dst.push(format!(".corrupt.{}", ts));
        let _ = std::fs::rename(&src, std::path::PathBuf::from(dst));
    }
}

/// 刷新安全快照（一致性副本）。
/// 必须用 VACUUM INTO：它由 SQLite 自己导出「已合并 WAL 全部事务」的完整库文件，
/// 而 std::fs::copy 在 WAL 模式下只能拿到上一次 checkpoint 的主文件（残缺）。
/// 先写临时文件、成功后原子替换，避免中途断电/崩溃留下残缺快照。
fn refresh_snapshot(path: &std::path::Path, bak: &std::path::Path) {
    let mut tmp = bak.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let _ = std::fs::remove_file(&tmp);
    let ok = Connection::open(path)
        .and_then(|conn| conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().to_string()]))
        .is_ok();
    if ok {
        let _ = std::fs::rename(&tmp, bak);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 对指定库文件执行 integrity_check，返回是否正常
fn integrity_ok(path: &std::path::Path) -> bool {
    let Ok(conn) = Connection::open(path) else { return false };
    match conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(v) => v.trim() == "ok",
        Err(_) => false,
    }
}

/// quick_check 快速校验（回滚后的二次确认）
fn quick_ok(path: &std::path::Path) -> bool {
    let Ok(conn) = Connection::open(path) else { return false };
    conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
        .map(|v| v.trim() == "ok")
        .unwrap_or(false)
}

/// 启动时执行数据自检与自愈。
/// 返回状态字符串：new（首次无库）/ ok（正常，已刷新快照）/ recovered（从快照回滚）/ recreated（重建空库）
pub fn ensure_db_health(app: &tauri::AppHandle) -> Result<String, String> {
    let path = db_path(app)?;
    let bak = backup_path(&path);

    // 首次启动：尚无数据库，跳过自检
    if !path.exists() {
        return Ok("new".to_string());
    }

    // 1) 正常路径：库存在，先自检，再刷新安全快照（每次启动都刷新）
    //    先自检后快照更稳妥：避免把已损坏的库导出成"权威快照"
    if integrity_ok(&path) {
        refresh_snapshot(&path, &bak);
        return Ok("ok".to_string());
    }

    // 2) 损坏路径：尝试用快照回滚
    if bak.exists() {
        // 覆盖主库前先清掉残留的 -wal/-shm，避免旧预写日志与新快照混用（旧 WAL 的
        // 未提交帧会尝试附着到已替换的库上，轻则回滚无效、重则引入不一致数据）
        let _ = std::fs::remove_file(sidecar(&path, "-wal"));
        let _ = std::fs::remove_file(sidecar(&path, "-shm"));
        let _ = std::fs::copy(&bak, &path);
        if quick_ok(&path) {
            // 回滚成功
            return Ok("recovered".to_string());
        }
    }

    // 3) 回滚仍失败：隔离损坏文件（含 -wal/-shm）+ 重建空库（保证应用可启动）
    quarantine(&path);
    Ok("recreated".to_string())
}

/// Tauri command：手动触发一次数据自检自愈（可导入设置页/启动日志）
#[tauri::command]
pub fn run_db_health(app: tauri::AppHandle) -> Result<String, String> {
    ensure_db_health(&app)
}

/// 仅供打印用途：把自检状态翻译为中文描述
pub fn status_label(status: &str) -> &'static str {
    match status {
        "new" => "首次启动，创建数据库",
        "recovered" => "检测到损坏，已从安全快照自动恢复",
        "recreated" => "检测到损坏且快照不可用，已隔离损坏文件并重建数据库",
        _ => "数据库状态正常",
    }
}