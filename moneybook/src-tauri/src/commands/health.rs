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
//
// 数据安全铁律（历史血泪：曾被「删 -wal + 旧快照覆盖」误伤导致重启丢数据）：
//   a) 无法打开库（另一实例仍占用 / 文件不可读）→ 一律不触碰数据，跳过自愈；
//   b) 确认损坏后，必须【先隔离原库三件套（保留现场可找回）】，再尝试快照恢复；
//      绝不先覆盖、后隔离 —— 覆盖会把原库内容顶掉，唯一可找回的只有滞后的快照；
//   c) 绝不在回滚路径上删除 -wal/-shm：-wal 里可能有「已提交但未 checkpoint」的
//      最新数据，删掉等于把用户最近录入的数据永久抹掉（历史上确实发生过）。
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
/// 注意：隔离 = 保留现场（改名），绝不是删除 —— 被隔离文件里可能还有
/// 「已提交但未 checkpoint」的最新数据，用户/工具仍可手动找回。
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

/// 对指定库文件执行 integrity_check。
/// 返回值语义（区分「无法打开」与「检查失败」至关重要）：
///  - None：库打不开（被另一实例占用 / 文件不可读 / 损坏到无法 open）——
///    此时绝不自动恢复，否则会误伤正在被占用的正常库；
///  - Some(true)：完整；
///  - Some(false)：SQLite 能打开但内部不一致（确认损坏）。
/// rusqlite::Connection::open 每次都会自动执行 WAL 恢复，故本检查天然包含
/// 「先恢复上次异常退出遗留的 -wal」这一步。
fn integrity_status(path: &std::path::Path) -> Option<bool> {
    let conn = Connection::open(path).ok()?;
    match conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(v) => Some(v.trim() == "ok"),
        Err(_) => Some(false),
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
/// 返回状态字符串：new（首次无库）/ ok（正常，已刷新快照）/ recovered（从快照回滚）/
/// recreated（重建空库）/ locked（库被占用或不可读，未做任何处理）。
pub fn ensure_db_health(app: &tauri::AppHandle) -> Result<String, String> {
    let path = db_path(app)?;
    let bak = backup_path(&path);

    // 首次启动：尚无数据库，跳过自检
    if !path.exists() {
        return Ok("new".to_string());
    }

    // 1) 正常路径：库存在且可打开、完整性通过 → 刷新安全快照（每次启动都刷新）。
    //    先自检后快照更稳妥：避免把已损坏的库导出成"权威快照"
    match integrity_status(&path) {
        Some(true) => {
            refresh_snapshot(&path, &bak);
            return Ok("ok".to_string());
        }
        Some(false) => {
            // 2) 确认损坏路径（SQLite 能打开但 integrity_check 非 ok）：
            //    a) 先隔离原库三件套（保留现场，-wal 中未合并的数据仍可找回）；
            //    b) 再用上次的安全快照覆盖回滚；
            //    c) 校验通过 → recovered；仍失败 → 重建空库兜底。
            //    顺序绝不可反过来（先覆盖后隔离 = 把原库顶掉，数据无处找回）。
            eprintln!(
                "[health] 数据库完整性检查未通过，先隔离原库再尝试快照恢复：{}",
                path.display()
            );
            quarantine(&path);
            if bak.exists() {
                let _ = std::fs::copy(&bak, &path);
                if quick_ok(&path) {
                    println!("[health] 已从安全快照恢复数据库");
                    return Ok("recovered".to_string());
                }
            }
            println!("[health] 快照恢复失败，重建空库（原库已隔离保留在 .corrupt.*）");
            return Ok("recreated".to_string());
        }
        None => {
            // 3) 无法打开：大概率是另一实例尚未完全退出、仍持锁，或文件被占用。
            //    此时绝不触碰数据 —— 让插件连接在启动流程中自行处理（SQLite 会等锁重试）。
            eprintln!(
                "[health] 数据库无法打开（可能被其他实例占用），跳过自愈，交由正常启动流程处理"
            );
            return Ok("locked".to_string());
        }
    }
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
        "recovered" => "检测到损坏，已从安全快照自动恢复（原库已隔离保留）",
        "recreated" => "检测到损坏且快照不可用，已隔离损坏文件并重建数据库",
        "locked" => "数据库被占用或不可读，跳过自检，交由正常启动流程处理",
        _ => "数据库状态正常",
    }
}