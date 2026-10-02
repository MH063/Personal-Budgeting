// 备份相关的 Tauri commands
use std::path::{Path, PathBuf};
use rusqlite::Connection;
use tauri::Manager;

/// 获取数据库文件放置路径（取自启动时的数据目录决策：便携目录或系统标准目录）
#[tauri::command]
pub fn get_db_path(app: tauri::AppHandle) -> Result<String, String> {
    let loc = app.state::<crate::datadir::DbLocation>();
    Ok(loc.file.to_string_lossy().to_string())
}

/// 校验给定路径是否为「当前应用的数据库文件」：
/// 防止命令被传入任意路径去读取/覆盖非本应用的文件。
fn is_db_file(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let loc = app.state::<crate::datadir::DbLocation>();
    let given = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("数据库路径不可访问：{e}"))?;
    let real = std::fs::canonicalize(&loc.file)
        .map_err(|e| format!("当前数据库文件不可用：{e}"))?;
    if given != real {
        return Err("仅允许操作当前应用的数据库文件".to_string());
    }
    Ok(())
}

/// 允许「用户侧」读写路径的可信根目录：
/// 应用数据目录（数据库所在目录）+ 用户主目录及其桌面/下载/文档子目录。
/// 阻止把任意路径交给备份/恢复命令（如系统目录、其他程序文件）。
fn user_allowed_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(loc) = app.try_state::<crate::datadir::DbLocation>() {
        if let Some(parent) = Path::new(&loc.file).parent() {
            roots.push(parent.to_path_buf());
        }
    }
    for base in [std::env::var("USERPROFILE"), std::env::var("HOME")] {
        let Ok(base) = base else { continue };
        if base.trim().is_empty() {
            continue;
        }
        let home = PathBuf::from(base);
        roots.push(home.clone());
        for sub in ["Documents", "Downloads", "Desktop", "桌面", "下载", "文档"] {
            roots.push(home.join(sub));
        }
    }
    roots
}

/// 判断路径是否位于「系统保留目录」：Windows 系统目录、Program Files、应用安装目录。
/// 这些位置不应被备份/恢复命令读写，防止覆盖操作系统或程序文件。
/// 入参需为已规范化的路径（canonicalize 后的前缀）。
fn is_system_reserved(target: &Path) -> bool {
    let reserved: Vec<PathBuf> = [
        std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into()),
        "C:\\Program Files".into(),
        "C:\\Program Files (x86)".into(),
        "C:\\Windows".into(),
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    for r in reserved {
        let canon_r = r.canonicalize().unwrap_or(r);
        if target.starts_with(&canon_r) {
            return true;
        }
    }
    // 应用安装目录（exe 所在目录）：便携模式下数据库就在此处，但该目录已由白名单第一步放行；
    // 走到这里说明是非便携场景，不应把备份写进安装目录。exe 路径同样需规范化以与 target 前缀匹配
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let canon_dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            if target.starts_with(&canon_dir) {
                return true;
            }
        }
    }
    false
}

/// 校验路径可用作备份/恢复：
/// 1) 可信白名单（应用数据目录 + 用户目录）直接放行；
/// 2) 放宽：任意磁盘路径放行，但排除系统保留目录（Windows/Program Files/安装目录）。
/// need_exist=true（备份源）：整路径须存在；false（备份目标）：父目录须可访问且文件名合法。
fn check_allowed(app: &tauri::AppHandle, path: &str, need_exist: bool) -> Result<(), String> {
    let p = Path::new(path);
    let target = if need_exist {
        p.canonicalize()
            .map_err(|e| format!("路径不存在或不可访问：{e}"))?
    } else {
        let parent = p.parent().ok_or_else(|| "路径缺少父目录".to_string())?;
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "路径缺少合法文件名".to_string())?;
        if name.is_empty() || name.starts_with('.') {
            return Err("不允许写入隐藏文件或空文件名".to_string());
        }
        let canon_parent = parent
            .canonicalize()
            .map_err(|e| format!("目标目录不可访问：{e}"))?;
        canon_parent.join(name)
    };
    for root in user_allowed_roots(app) {
        let canon_root = root.canonicalize().unwrap_or(root);
        if target.starts_with(&canon_root) {
            return Ok(());
        }
    }
    if !is_system_reserved(&target) {
        return Ok(());
    }
    Err(format!("路径位于系统保留目录，不允许用于备份/恢复：{path}"))
}

/// 使用 rusqlite 的 Online Backup 将数据库备份到目标文件。
/// 安全约束：source 必须是当前数据库文件；dest 支持任意磁盘路径，但排除系统保留目录。
#[tauri::command]
pub fn backup_database(app: tauri::AppHandle, source: String, dest: String) -> Result<(), String> {
    is_db_file(&app, &source)?;
    check_allowed(&app, &dest, false)?;
    let src = Connection::open(&source).map_err(|e| e.to_string())?;
    let mut dst = Connection::open(&dest).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(5, std::time::Duration::from_millis(250), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 用备份文件覆盖当前数据库（先做一次安全备份）。
/// 安全约束：backup 必须存在且位于非系统保留目录；target 必须是当前数据库文件。
#[tauri::command]
pub fn restore_database(app: tauri::AppHandle, backup: String, target: String) -> Result<(), String> {
    check_allowed(&app, &backup, true)?;
    is_db_file(&app, &target)?;
    let safe = format!("{}.bak", target);
    let _ = std::fs::copy(&target, &safe);
    std::fs::copy(&backup, &target).map_err(|e| e.to_string())?;
    Ok(())
}