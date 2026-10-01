#![cfg_attr(mobile, tauri::mobile_entry_point)]

mod commands;

use tauri_plugin_sql::{Migration, MigrationKind};

fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init_schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "loan_interest",
            sql: include_str!("../migrations/002_interest.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "loan_schedule",
            sql: include_str!("../migrations/003_loan_schedule.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "repayment_interest",
            sql: include_str!("../migrations/004_repayment_interest.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "period_auto_savings",
            sql: include_str!("../migrations/005_period_auto_savings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "recurring",
            sql: include_str!("../migrations/006_recurring.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "reconcile",
            sql: include_str!("../migrations/007_reconcile.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "prune_preset_accounts",
            sql: include_str!("../migrations/008_prune_preset_accounts.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // HTTP 插件：前端经此发起外部 API 请求（Rust 侧 reqwest），避免 WebView CORS/CSP 拦截
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:moneybook.db", get_migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::backup::get_db_path,
            commands::backup::backup_database,
            commands::backup::restore_database,
            commands::health::run_db_health,
            commands::ocr::verify_model_integrity,
            // 存储管理：占用概览 / 缓存清理 / 打开目录 / 打开 https 链接（关于页更新跳转）
            commands::storage::get_storage_overview,
            commands::storage::clean_storage_cache,
            commands::storage::open_folder,
            commands::storage::open_url,
            // 真原子事务：跨多次 IPC 复用同一条连接（插件连接池无法做到）
            commands::tx::tx_begin,
            commands::tx::tx_execute,
            commands::tx::tx_select,
            commands::tx::tx_commit,
            commands::tx::tx_rollback,
        ])
        // 事务连接持有器：runInTransaction 期间跨调用复用
        .manage(commands::tx::TxState::default())
        .setup(|app| {
            // 启动即做数据完整性自检与自愈（在插件连接接手前校准库文件）
            let handle = app.handle();
            let status = commands::health::ensure_db_health(&handle);
            match status {
                Ok(s) => {
                    // 记录自检结论（正常/恢复/重建），便于事后排查
                    println!(
                        "[health] 数据库自检：{}（{}）",
                        commands::health::status_label(&s),
                        s
                    );
                }
                Err(e) => {
                    eprintln!("[health] 数据库自检失败：{e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}