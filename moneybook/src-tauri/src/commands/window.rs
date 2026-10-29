// 应用内多窗口：导入解析结果独立窗口
// -----------------------------------------------------------------------------
// 背景：导入解析结果原以 Modal 弹窗展示，大表格受弹窗尺寸限制、无法调整大小。
// 现改为「应用内新窗口」（可自由调整大小、更直观）：前端解析成功后把预览数据写入
// localStorage 快照，再调用本命令打开「import-preview」窗口——与主窗口加载同一个
// index.html 入口，由前端按窗口标签（import-preview）决定渲染预览页（不依赖 hash 路由）。
// 窗口已打开时聚焦复用（用户在主窗口重新解析后，新窗口页面会通过 storage 事件刷新数据）。
//
// 关键约束（输入失效的根因）：
// Tauri 官方文档对 WebviewWindowBuilder::new 明确写着「Windows 下在同步命令/事件回调里创建
// 窗口会 deadlock（wry#583），应改用 async 命令或独立线程创建窗口」。早前本命令是同步命令，
// 创建窗口时主线程消息循环里又开了一层嵌套消息泵，导致两个窗口的鼠标激活/点击被吞：
// 独立窗口内按钮全部点不动、独立窗口存在时主窗口按钮也失效（点一次无反馈、连点两次才生效），
// 关掉独立窗口后主窗口即恢复——正是用户反馈的现象。故本命令必须保持 async。
// -----------------------------------------------------------------------------

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 「导入解析结果」窗口标签（前端 main.tsx 以此判定渲染预览页）
const PREVIEW_LABEL: &str = "import-preview";
/// 预览窗口初始尺寸（逻辑像素）：比主窗口小一圈，便于与主窗口同时使用
const PREVIEW_W: f64 = 1040.0;
const PREVIEW_H: f64 = 720.0;

/// 打开「导入解析结果」独立窗口；已存在则还原并聚焦复用。
/// 必须是 async 命令：同步命令在 Windows 下创建窗口会阻塞/嵌套主线程消息循环（见文件头注释）。
#[tauri::command]
pub async fn open_import_preview(app: tauri::AppHandle) -> Result<(), String> {
    // 窗口已打开：还原（可能被最小化）、显示并聚焦，避免重复创建
    // （重新解析后页面通过 storage 事件刷新为新快照）
    if let Some(win) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    // 加载与主窗口相同的 index.html 入口，由前端按窗口标签（import-preview）决定渲染预览页：
    // 早前用 App("index.html#/import-preview") 依赖 hash 路由，多窗口下首屏时序不稳，出现过整窗白屏。
    // 标题与主窗口「个人记账」呼应（窗口标题栏 + 任务栏均显示），图标复用应用默认图标（bundle.icon）
    let mut builder = WebviewWindowBuilder::new(&app, PREVIEW_LABEL, WebviewUrl::App("index.html".into()))
        .title("个人记账 · 导入解析结果")
        .inner_size(PREVIEW_W, PREVIEW_H)
        .min_inner_size(720.0, 480.0)
        .resizable(true);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    // 与主窗口错开摆放，避免新窗口整片盖住主窗口（完全重叠时用户点「主窗口按钮」实际点在预览窗口上）
    if let Some((x, y)) = preview_position(&app) {
        builder = builder.position(x, y);
    }
    let win = builder.build().map_err(|e| {
        eprintln!("[window] 创建导入预览窗口失败：{e}");
        e.to_string()
    })?;
    // 显示并聚焦（还原可能的最小化状态；聚焦在窗口可见后才生效）
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    println!("[window] 已创建并显示导入预览窗口：{PREVIEW_LABEL}");
    Ok(())
}

/// 计算预览窗口的初始逻辑坐标：相对主窗口左上角偏移 32px，
/// 避免新窗口与主窗口整片重叠（否则主窗口看起来「点不动」）。
/// 取不到主窗口位置/缩放时返回 None，交由系统默认摆放。
fn preview_position(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let main = app.get_webview_window("main")?;
    let pos = main.outer_position().ok()?;
    let scale = main.scale_factor().ok()?;
    if scale <= 0.0 {
        return None;
    }
    // builder.position 使用逻辑像素，而 outer_position 是物理像素，需按缩放比换算
    Some((pos.x as f64 / scale + 32.0, pos.y as f64 / scale + 32.0))
}
