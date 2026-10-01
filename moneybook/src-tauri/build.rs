// Tauri 构建脚本：必须在 build 阶段生成上下文资源（icons.capabilities 等），
// 供 `tauri::generate_context!()` 宏在编译期读取，否则会报 `OUT_DIR env var is not set`。
fn main() {
    tauri_build::build()
}