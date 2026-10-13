// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 5 && args[1] == "--updater" {
        // Run as updater
        let pid: u32 = args[2].parse().unwrap_or(0);
        let zip_path = std::path::Path::new(&args[3]);
        let target_dir = std::path::Path::new(&args[4]);
        moneybook_lib::run_updater(pid, zip_path, target_dir);
        return;
    }

    moneybook_lib::run()
}