// 数据目录决策：便携优先 + 安全回退
// -----------------------------------------------------------------------------
// 设计目标（用户确认的方案）：
//   1) 全新安装优先使用「程序目录\data」，实现绿色便携——数据随程序整体搬移；
//   2) 安装到 Program Files 等无写权限位置时，写入探测失败即自动回退到系统标准目录
//      （Windows 为 %APPDATA%\<identifier>），绝不因权限问题导致应用不可用；
//   3) 已有数据绝不因升级改变位置：便携目录与标准目录「谁已有库就用谁」，
//      避免出现「升级后数据看起来丢了」这类最危险的情况。
//
// 决策只在进程启动时执行一次，结果注册为 Tauri 全局状态（DbLocation），
// 插件连接 / 事务连接 / 启动自检 / 备份 / 存储统计全部从这里取路径，保证全链路一致。
//
// 与 tauri-plugin-sql 的衔接：决策得到的是绝对路径，拼接为 `sqlite:<绝对路径>` 后
// 作为迁移注册串（插件按「连接串全等」匹配迁移表）。插件内部 path_mapper 对绝对路径
// 执行 push 时会整段替换 app_config_dir（Rust PathBuf::push 语义），sqlx 也直接按
// 该路径打开文件，因此绝对路径方案成立。前端必须使用 get_db_url 返回的同一字符串
// 执行 Database.load，否则迁移表会失配（字符串必须逐字一致）。
// 这两个依赖仅在「安装版（非 debug）」的便携迁移路径中使用；
// debug 构建直接跳过便携迁移，若不做 cfg 门控会产生 unused import 警告。
#[cfg(not(debug_assertions))]
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// 应用标识（与 tauri.conf.json 的 identifier 保持一致）
const APP_IDENTIFIER: &str = "com.yourname.moneybook";

/// 数据目录模式
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataDirMode {
    /// 便携模式：数据位于「程序目录\data」，随程序整体搬移
    Portable,
    /// 标准模式：数据位于系统标准目录（%APPDATA%\com.yourname.moneybook）
    Standard,
}

/// 数据库位置（启动时决策一次，注册为 Tauri 全局状态）
#[derive(Clone, Debug)]
pub struct DbLocation {
    /// 数据目录（库文件所在目录）
    pub dir: PathBuf,
    /// 库文件完整路径
    pub file: PathBuf,
    /// 决策出的模式
    pub mode: DataDirMode,
}

impl DbLocation {
    /// 传给 tauri-plugin-sql 的连接串（前端 Database.load 必须使用同一字符串）
    pub fn url(&self) -> String {
        format!("sqlite:{}", self.file.to_string_lossy())
    }

    /// 模式字符串（供命令返回给前端展示）
    pub fn mode_str(&self) -> &'static str {
        match self.mode {
            DataDirMode::Portable => "portable",
            DataDirMode::Standard => "standard",
        }
    }
}

/// 程序（可执行文件）所在目录
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 便携目标目录：程序目录\data（无论当前是否为便携模式都可用于「迁移」引导展示）
pub fn portable_target_dir() -> Option<PathBuf> {
    exe_dir().map(|d| d.join("data"))
}

/// 系统标准数据目录（与 Tauri app_data_dir 等价；Windows 上为 %APPDATA%\<identifier>
/// ——与既有版本的取址完全一致，保证「已有数据沿用」判断准确）
pub fn standard_data_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_IDENTIFIER)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Application Support")
            .join(APP_IDENTIFIER)
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local/share")
            .join(APP_IDENTIFIER)
    }
}

/// 目录是否可写：尝试创建目录并写入探测文件（用完即删）。
/// 这是「Program Files 无写权限」问题的解决方案核心——不可写即回退，绝不报错阻塞。
fn dir_writable(dir: &Path) -> bool {
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

/// 纯决策函数（独立便于单测）：按「便携已有 → 标准已有 → 便携可写优先」三级决策。
/// exe_dir 传 None 表示跳过便携候选（开发构建 / 无法定位程序目录时）。
pub fn decide_with(exe_dir: Option<&Path>, standard_dir: &Path) -> DbLocation {
    let portable_dir = exe_dir.map(|d| d.join("data"));

    // 1) 便携目录已有库 → 用它（升级、整体搬移后都能命中）
    if let Some(pd) = &portable_dir {
        let f = pd.join("moneybook.db");
        if f.exists() {
            return DbLocation {
                dir: pd.clone(),
                file: f,
                mode: DataDirMode::Portable,
            };
        }
    }

    // 2) 标准目录已有库 → 沿用（绝不改变现有用户的数据位置）
    let sf = standard_dir.join("moneybook.db");
    if sf.exists() {
        return DbLocation {
            dir: standard_dir.to_path_buf(),
            file: sf,
            mode: DataDirMode::Standard,
        };
    }

    // 3) 全新安装：便携目录可写则便携（绿色版），否则回退标准目录
    if let Some(pd) = &portable_dir {
        if dir_writable(pd) {
            return DbLocation {
                dir: pd.clone(),
                file: pd.join("moneybook.db"),
                mode: DataDirMode::Portable,
            };
        }
    }
    DbLocation {
        dir: standard_dir.to_path_buf(),
        file: sf,
        mode: DataDirMode::Standard,
    }
}

/// 进程启动时执行一次的实际决策。
/// 开发构建（debug）跳过便携候选：那时 exe 位于 target 目录，在构建产物目录里
/// 生成 data/ 会污染构建目录，且开发环境沿用既有标准目录更稳定。
pub fn decide() -> DbLocation {
    #[cfg(debug_assertions)]
    let exe: Option<PathBuf> = None; // 显式类型：None 无法自行推断
    #[cfg(not(debug_assertions))]
    let exe = exe_dir();

    decide_with(exe.as_deref(), &standard_data_dir())
}

/// 供前端 Database.load 使用的连接串（与迁移注册串同一来源，必须逐字一致）
#[tauri::command]
pub fn get_db_url(loc: tauri::State<'_, DbLocation>) -> String {
    loc.url()
}

/// 把数据迁移到程序目录（便携模式）。
/// 前置条件（任一不满足即拒绝，原数据不动）：
///   - 当前为标准模式（已是便携则无需迁移）；
///   - 程序目录可写（Program Files 等受保护位置会明确拒绝并说明）；
///   - 便携目录尚无库文件（避免覆盖已有数据）。
/// 过程：VACUUM INTO 导出当前库的一致性快照（库运行在 WAL 模式，直接复制主文件会残缺）
/// → integrity_check 校验 → 同盘 rename 原子落位。
/// 原库保持原样（天然成为回滚兜底），重启应用后便携目录优先命中，即完成切换。
#[tauri::command]
pub fn migrate_to_portable(app: tauri::AppHandle) -> Result<String, String> {
    // 开发构建不支持：exe 在 target 目录，迁移没有意义且会污染构建目录
    #[cfg(debug_assertions)]
    {
        let _ = &app;
        return Err("开发构建不支持便携迁移（仅安装版可用）".to_string());
    }

    #[cfg(not(debug_assertions))]
    {
        let loc = app.state::<DbLocation>();
        if loc.mode == DataDirMode::Portable {
            return Err("当前已是便携模式（数据就在程序目录）".to_string());
        }
        let target_dir = portable_target_dir().ok_or_else(|| "无法定位程序目录".to_string())?;
        let target = target_dir.join("moneybook.db");
        if target.exists() {
            return Err("程序目录下已存在数据文件，无需迁移".to_string());
        }
        if !dir_writable(&target_dir) {
            return Err("程序目录不可写（可能安装在 Program Files 等受保护位置），无法迁移；可改用「选择目录」把导出保存到其他位置".to_string());
        }
        if !loc.file.exists() {
            return Err("当前数据库文件不存在，无法迁移".to_string());
        }
        // 快照写到目标同目录（同盘 rename 才是原子操作）
        let tmp = target_dir.join("moneybook.db.migrating");
        let _ = std::fs::remove_file(&tmp);
        {
            let conn = Connection::open(&loc.file).map_err(|e| e.to_string())?;
            conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().to_string()])
                .map_err(|e| format!("导出快照失败：{e}"))?;
        }
        // 校验快照完整性，不通过则放弃（原数据未受影响）
        let ok = Connection::open(&tmp)
            .and_then(|c| c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)))
            .map(|v| v.trim() == "ok")
            .unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_file(&tmp);
            return Err("快照校验未通过，已放弃迁移（原数据未受影响）".to_string());
        }
        std::fs::rename(&tmp, &target).map_err(|e| format!("落位失败：{e}"))?;
        println!("[datadir] 已迁移到便携目录：{}", target.display());
        Ok(target.to_string_lossy().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 便携目录已有库 → 优先便携（升级/搬移后沿用）
    #[test]
    fn prefers_portable_when_db_exists() {
        let base = std::env::temp_dir().join(format!("mb-dd-a-{}", std::process::id()));
        let portable = base.join("portable");
        let standard = base.join("standard");
        std::fs::create_dir_all(portable.join("data")).unwrap();
        std::fs::create_dir_all(&standard).unwrap();
        std::fs::write(portable.join("data/moneybook.db"), b"x").unwrap();
        std::fs::write(standard.join("moneybook.db"), b"y").unwrap();

        let loc = decide_with(Some(&portable), &standard);
        assert_eq!(loc.mode, DataDirMode::Portable);
        assert_eq!(loc.file, portable.join("data/moneybook.db"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 标准目录已有库且便携无库 → 沿用标准（不改变现有用户数据位置）
    #[test]
    fn keeps_standard_when_existing_data() {
        let base = std::env::temp_dir().join(format!("mb-dd-b-{}", std::process::id()));
        let portable = base.join("portable");
        let standard = base.join("standard");
        std::fs::create_dir_all(&standard).unwrap();
        std::fs::write(standard.join("moneybook.db"), b"y").unwrap();

        let loc = decide_with(Some(&portable), &standard);
        assert_eq!(loc.mode, DataDirMode::Standard);
        assert_eq!(loc.file, standard.join("moneybook.db"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 全新安装且便携可写 → 选出便携目录（绿色版）
    #[test]
    fn picks_portable_for_fresh_install_when_writable() {
        let base = std::env::temp_dir().join(format!("mb-dd-c-{}", std::process::id()));
        let portable = base.join("portable");
        let standard = base.join("standard");

        let loc = decide_with(Some(&portable), &standard);
        assert_eq!(loc.mode, DataDirMode::Portable);
        assert!(portable.join("data").exists(), "应创建便携 data 目录");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 连接串格式固定为 sqlite:<绝对路径>（前端 Database.load 必须逐字一致）
    #[test]
    fn url_is_sqlite_prefixed_absolute_path() {
        let loc = DbLocation {
            dir: PathBuf::from("C:/x/y"),
            file: PathBuf::from("C:/x/y/moneybook.db"),
            mode: DataDirMode::Portable,
        };
        assert_eq!(loc.url(), "sqlite:C:/x/y/moneybook.db");
    }
}