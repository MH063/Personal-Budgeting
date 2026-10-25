// 应用内多窗口：导入解析结果独立窗口
// -----------------------------------------------------------------------------
// 背景：导入解析结果原以 Modal 弹窗展示，大表格受弹窗尺寸限制、无法调整大小。
// 现改为「应用内新窗口」（可自由调整大小、更直观）：前端解析成功后把预览数据写入
// localStorage 快照，再调用本命令打开「import-preview」窗口加载 #/import-preview 路由页。
// 窗口已打开时聚焦复用（用户在主窗口重新解析后，新窗口页面会通过 storage 事件刷新数据）。
// -----------------------------------------------------------------------------

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 打开「导入解析结果」独立窗口；已存在则聚焦复用。
#[tauri::command]
pub fn open_import_preview(app: tauri::AppHandle) -> Result<(), String> {
    // 窗口已打开：仅聚焦，避免重复创建（重新解析后页面通过 storage 事件刷新快照）
    if let Some(win) = app.get_webview_window("import-preview") {
        let _ = win.set_focus();
        return Ok(());
    }
    // HashRouter 下路由为 /import-preview：加载 index.html#/import-preview；
    // 标题与主窗口「个人记账」呼应（窗口标题栏 + 任务栏均显示），图标复用应用默认图标（bundle.icon）
    let mut builder = WebviewWindowBuilder::new(&app, "import-preview", WebviewUrl::App("index.html#/import-preview".into()))
        .title("个人记账 · 导入解析结果")
        .inner_size(1040.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())?;
    // 创建即可见，聚焦到新窗口方便直接操作
    if let Some(win) = app.get_webview_window("import-preview") {
        let _ = win.set_focus();
    }
    Ok(())
}
