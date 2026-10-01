// 备份相关的 Tauri commands
use rusqlite::Connection;
use tauri::Manager;

/// 获取数据库文件放置路径（应用数据目录下 moneybook.db）
#[tauri::command]
pub fn get_db_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = dir.join("moneybook.db");
    Ok(path.to_string_lossy().to_string())
}

/// 使用 rusqlite 的 Online Backup 将数据库备份到目标文件
#[tauri::command]
pub fn backup_database(source: String, dest: String) -> Result<(), String> {
    let src = Connection::open(&source).map_err(|e| e.to_string())?;
    let mut dst = Connection::open(&dest).map_err(|e| e.to_string())?;
    let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|e| e.to_string())?;
    backup
        .run_to_completion(5, std::time::Duration::from_millis(250), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 用备份文件覆盖当前数据库（先做一次安全备份）
#[tauri::command]
pub fn restore_database(backup: String, target: String) -> Result<(), String> {
    let safe = format!("{}.bak", target);
    let _ = std::fs::copy(&target, &safe);
    std::fs::copy(&backup, &target).map_err(|e| e.to_string())?;
    Ok(())
}