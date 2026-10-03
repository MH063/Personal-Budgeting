// 存储管理：应用数据占用 / 磁盘空间占比 / 缓存清理 / 打开目录
//
// 背景：设置页需要「存储管理」——查看应用占用了多少空间、电脑磁盘的占用情况，
// 并清理可安全删除的残留文件（损坏库隔离文件、中断遗留的临时文件）。
// 设计：
//   - 磁盘空间零依赖获取：Windows 直接调用 kernel32!GetDiskFreeSpaceExW（FFI），
//     避免为一个查询引入 sysinfo 等新依赖（本机桌面版仅需 Windows 实现）。
//   - 「缓存」定义收窄为真正可弃文件：moneybook.db.corrupt.<ts>（损坏隔离留档）、
//     *.tmp（快照/写入中断残留）；主库、-wal/-shm 伴随文件、.bak 快照一律不碰。
use serde::Serialize;
use tauri::Manager;

/// 存储概览（一次性返回应用占用 + 磁盘空间，前端据此画占比条）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    /// 应用数据目录绝对路径（真实路径：便携目录或系统标准目录）
    pub app_dir: String,
    /// 数据目录模式：portable（程序目录\data）/ standard（系统标准目录）
    pub mode: String,
    /// 便携目标目录（程序目录\data），供前端展示「迁移到程序目录」入口
    pub portable_dir: String,
    /// 是否可迁移到便携目录（当前为标准模式 + 程序目录可写 + 便携目录尚无库）
    pub can_migrate: bool,
    /// 主库 moneybook.db 字节数
    pub db_size: u64,
    /// 预写日志 moneybook.db-wal 字节数
    pub wal_size: u64,
    /// 安全快照 moneybook.db.bak 字节数
    pub bak_size: u64,
    /// 可清理缓存字节数（.corrupt.* 与 *.tmp 之和）
    pub cache_size: u64,
    /// 应用数据目录下全部文件总字节数
    pub app_total: u64,
    /// 所在磁盘总容量（非 Windows 或查询失败为 0）
    pub disk_total: u64,
    /// 所在磁盘已用容量
    pub disk_used: u64,
    /// 所在磁盘可用容量
    pub disk_free: u64,
}

/// Windows 磁盘空间 FFI（kernel32）
#[cfg(windows)]
mod win_disk {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available_to_caller: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    /// 查询路径所在磁盘的 (总容量, 已用, 可用)；失败返回 None
    pub fn disk_space(dir: &std::path::Path) -> Option<(u64, u64, u64)> {
        use std::os::windows::ffi::OsStrExt;
        // API 要求 NUL 结尾的宽字符串
        let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
        wide.push(0);
        let mut free_to_caller = 0u64;
        let mut total = 0u64;
        let mut free_total = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_to_caller,
                &mut total,
                &mut free_total,
            )
        };
        if ok == 0 {
            None
        } else {
            Some((total, total.saturating_sub(free_total), free_total))
        }
    }
}

/// 查询路径所在磁盘 (总, 已用, 可用)；非 Windows 或失败返回全 0（前端提示不支持）
fn disk_space_of(dir: &std::path::Path) -> (u64, u64, u64) {
    #[cfg(windows)]
    {
        if let Some(v) = win_disk::disk_space(dir) {
            return v;
        }
    }
    #[cfg(not(windows))]
    let _ = dir;
    (0, 0, 0)
}

/// 计算单个文件字节数（不存在或读取失败记 0）
fn file_size(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .map(|m| if m.is_file() { m.len() } else { 0 })
        .unwrap_or(0)
}

/// 递归求目录下所有文件总字节数（读取失败的条目跳过）
fn dir_total_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            total = total.saturating_add(dir_total_size(&p));
        } else {
            total = total.saturating_add(e.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
    total
}

/// 是否为可安全清理的缓存文件。
/// 收窄定义：只认「历史损坏隔离留档」(.corrupt.*) 与「中断遗留临时文件」(*.tmp)；
/// 主库、-wal/-shm 伴随文件、.bak 快照绝不匹配（避免误删唯一可用数据）。
fn is_cache_file(name: &str) -> bool {
    name.contains(".corrupt.") || name.ends_with(".tmp")
}

/// 统计目录下可清理缓存字节数
fn cache_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_type().map(|t| t.is_file()).unwrap_or(false)
                && is_cache_file(&e.file_name().to_string_lossy())
        })
        .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
        .sum()
}

/// 计算 SQLite 伴随文件路径：moneybook.db → moneybook.db-wal / moneybook.db.bak
fn sidecar(db: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut p = db.as_os_str().to_owned();
    p.push(suffix);
    std::path::PathBuf::from(p)
}

/// 获取存储概览：应用数据占用明细 + 磁盘总/已用/可用
#[tauri::command]
pub fn get_storage_overview(app: tauri::AppHandle) -> Result<StorageOverview, String> {
    let loc = app.state::<crate::datadir::DbLocation>();
    let dir = loc.dir.clone();
    let db = loc.file.clone();
    // 便携迁移可用性：标准模式 + 程序目录可写 + 便携目录尚无库。
    // 只在标准模式下提示迁移（已是便携模式自然无需），且不做副作用（写探测文件会清理）。
    let portable_dir = crate::datadir::portable_target_dir();
    let can_migrate = loc.mode == crate::datadir::DataDirMode::Standard
        && portable_dir
            .as_ref()
            .map(|p| dir_executable_probe(p) && !p.join("moneybook.db").exists())
            .unwrap_or(false);
    let (disk_total, disk_used, disk_free) = disk_space_of(&dir);
    Ok(StorageOverview {
        app_dir: dir.to_string_lossy().to_string(),
        mode: loc.mode_str().to_string(),
        portable_dir: portable_dir
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        can_migrate,
        db_size: file_size(&db),
        wal_size: file_size(&sidecar(&db, "-wal")),
        bak_size: file_size(&sidecar(&db, ".bak")),
        cache_size: cache_size(&dir),
        app_total: dir_total_size(&dir),
        disk_total,
        disk_used,
        disk_free,
    })
}

/// 迁移可用性探测：目录可写（创建 + 写删探测文件）。
/// 注意这是「预检」——真正迁移时 Rust 侧还会再校验一次；探测失败只影响提示，不影响任何数据。
fn dir_executable_probe(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write_probe");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 清理可安全删除的缓存文件（.corrupt.* / *.tmp），返回释放的字节数
#[tauri::command]
pub fn clean_storage_cache(app: tauri::AppHandle) -> Result<u64, String> {
    let loc = app.state::<crate::datadir::DbLocation>();
    let dir = loc.dir.clone();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut freed = 0u64;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !is_cache_file(&name) {
            continue;
        }
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed = freed.saturating_add(meta.len());
        }
    }
    Ok(freed)
}

/// 用系统文件管理器打开指定目录（本机桌面版；explorer 成功时返回码可能为 1，不据返回码判成败）
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("目录不存在：{path}"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = p;
    }
    Ok(())
}

/// 在默认浏览器中打开 https 链接（用于「关于」页跳转 GitHub Releases）。
/// 安全约束：只放行 https://，避免经命令参数注入执行任意命令；
/// 用 rundll32 FileProtocolHandler 直接交给 Shell 关联程序，不经过 cmd 解析（url 中的 & 等符号无注入风险）。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("仅支持打开 https 链接".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("当前平台不支持打开外部链接".to_string())
    }
}

/// 用系统默认程序打开本地文件（报表 HTML 等临时文件）。
/// 安全约束：仅放行「已存在的文件绝对路径」，直接交给 Shell 关联程序，不经命令解析。
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", p.to_string_lossy().as_ref()])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("当前平台不支持打开外部文件".to_string())
    }
}

/// 把报表 HTML 写入系统临时目录并用系统默认浏览器打开（返回文件路径）。
/// 背景：报表「导出 PDF(打印)」原用隐藏 iframe 触发 WebView2 的 window.print()，
/// 打印对话框嵌在应用内部，体验不佳；改经默认浏览器打开报表文件，
/// 打印/另存为 PDF 的窗口呈现在外部浏览器中。
/// 安全：HTML 由前端只读业务数据生成；写入临时目录、随后 Shell 关联程序打开，
/// 不做任何命令解析。
#[tauri::command]
pub fn open_report_in_browser(html: String) -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = std::env::temp_dir().join(format!("moneybook-report-{ts}.html"));
    std::fs::write(&file, html).map_err(|e| format!("写入报表文件失败：{e}"))?;
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", file.to_string_lossy().as_ref()])
            .spawn()
            .map_err(|e| {
                let _ = std::fs::remove_file(&file);
                format!("打开浏览器失败：{e}")
            })?;
        Ok(file.to_string_lossy().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = std::fs::remove_file(&file);
        Err("当前平台不支持打开外部浏览器".to_string())
    }
}