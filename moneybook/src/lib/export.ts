/** 导出 CSV（Excel 兼容，含 UTF-8 BOM） */
export function downloadCSV(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出 JSON（含缩进，便于人工阅读 / 迁移）。 */
export function downloadJSON(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 桌面（Tauri）环境：弹系统保存对话框写入 JSON 文件，返回保存路径；用户取消返回 null。
 * 背景：WebView2 中 blob + <a download> 触发的是「静默下载」，不弹对话框也不告知落盘位置，
 * 用户完全不知道数据导到了哪儿（历史缺陷）。改用系统保存对话框，位置由用户决定，
 * 调用方拿到路径后展示给用户。
 */
export async function saveJSON(filename: string, data: unknown): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');
  const dest = await save({
    defaultPath: filename,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });
  if (!dest) return null; // 用户取消
  await writeTextFile(dest, JSON.stringify(data, null, 2));
  return dest;
}