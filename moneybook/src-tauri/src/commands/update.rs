use futures_util::StreamExt;
use reqwest::Client;
use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn download_update_custom(app: AppHandle, url: String) -> Result<String, String> {
    let temp_dir = env::temp_dir();
    let zip_path = temp_dir.join("moneybook-update-windows.zip");

    let client = Client::new();
    let res = client
        .get(&url)
        .header("User-Agent", "moneybook-updater")
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("下载失败: HTTP {}", res.status()));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut file = File::create(&zip_path).map_err(|e| format!("创建文件失败: {}", e))?;
    let mut stream = res.bytes_stream();
    let mut downloaded = 0;

    let _ = app.emit("update-download-started", DownloadProgress { downloaded: 0, total: total_size });

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit("update-download-progress", DownloadProgress { downloaded, total: total_size });
    }

    let _ = app.emit("update-download-finished", ());

    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn apply_update_custom(app: AppHandle, zip_path: String) -> Result<(), String> {
    let zip_path = PathBuf::from(zip_path);
    if !zip_path.exists() {
        return Err("更新包不存在".into());
    }

    let current_exe = env::current_exe().map_err(|e| format!("无法获取当前程序路径: {}", e))?;
    let target_dir = current_exe
        .parent()
        .ok_or("无法获取当前程序所在目录")?
        .to_path_buf();

    // Invoke our own executable with the --updater flag
    let updater_exe = current_exe.clone();

    let pid = std::process::id();

    // Start the updater process detached
    Command::new(updater_exe)
        .arg("--updater")
        .arg(pid.to_string())
        .arg(zip_path.to_string_lossy().to_string())
        .arg(target_dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("启动更新器失败: {}", e))?;

    // Exit the main application so the updater can overwrite files
    app.exit(0);

    Ok(())
}
