import { listTransactionsDetailed } from './transactions';
import { getCategoryDistribution } from './stats';

const TYPE_MAP: Record<string, string> = {
  income: '收入',
  expense: '支出',
  transfer: '转账',
  lend: '借出',
  borrow: '借入',
  repay_in: '收回还款',
  repay_out: '偿还借款',
};

export function typeLabel(type: string): string {
  return TYPE_MAP[type] ?? type;
}

export interface ExportParams {
  from: string;
  to: string;
}

function escapeField(v: unknown): string {
  const s = String(v ?? '');
  // 含有逗号 / 换行 / 引号 时用双引号包裹并转义内部引号
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvString(rows: object[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField((row as Record<string, unknown>)[h])).join(','));
  }
  const body = lines.join('\r\n');
  // 含中文或非 ASCII 时加 BOM，兼容 Excel
  const hasNonAscii = /[^\x00-\x7F]/.test(body);
  return `${hasNonAscii ? '\uFEFF' : ''}${body}`;
}

function downloadBlob(content: BlobPart, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 把对象数组保存为 CSV 文件。
 * 桌面（Tauri）环境：弹系统保存对话框、经 fs 插件写入真实文件（WebView2 中
 * blob + <a download> 触发下载不可靠——历史缺陷：点击导出 CSV 无反应）；
 * 浏览器预览：回退 blob 触发下载。
 * 返回保存路径；用户取消时返回 null。
 */
export async function toCsv(rows: object[], filename?: string): Promise<string | null> {
  if (!rows.length) return null;
  const content = toCsvString(rows);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({
      defaultPath: filename ?? 'export.csv',
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
    });
    if (!path) return null; // 用户取消
    await writeTextFile(path, content);
    return path;
  }
  downloadBlob(content, filename ?? 'export.csv', 'text/csv;charset=utf-8;');
  return '已触发下载';
}

/** 导出交易明细 CSV，返回提示信息 */
export async function exportToCsv(params: ExportParams): Promise<string> {
  const rows = await listTransactionsDetailed({ from: params.from, to: params.to });
  const data = rows.map((r) => ({
    日期: r.date,
    类型: typeLabel(r.type),
    金额: r.amount,
    账户: r.account_name,
    目标账户: r.to_account_name ?? '',
    备注: r.note ?? '',
    分类: r.category_name ?? '',
  }));
  // 空数据与「用户取消保存」必须区分：历史缺陷——无记录时 toCsv 返回 null，
  // 被误报为「已取消导出」，误导用户以为操作被取消。这里提前拦截并明确提示。
  if (!data.length) return '区间内暂无交易记录，无可导出数据';
  const saved = await toCsv(data, `transactions_${params.from}_${params.to}.csv`);
  if (saved === null) return '已取消导出';
  return `已导出 ${data.length} 条记录${saved === '已触发下载' ? '' : `，文件已保存`}`;
}

const csvToHtml = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * 把报表 HTML 渲染进隐藏 iframe 并触发系统打印（可另存为 PDF）。
 * 历史缺陷：旧实现用 window.open 开新窗口打印，在 Tauri WebView2 中弹窗被拦截
 * （NewWindowRequested 默认拒绝），win 恒为 null，导致「导出 PDF (打印)」无反应。
 * iframe 方案不依赖弹窗权限：iframe 拥有独立文档，contentWindow.print() 只打印
 * iframe 内容（Chromium/WebView2 标准行为），打印完成即移除，不污染应用界面。
 * 返回是否成功触发打印（浏览器拦截等情况由调用方提示兜底）。
 */
function printHtml(html: string): boolean {
  if (typeof document === 'undefined') return false;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument;
    if (!doc) return false;
    doc.open();
    doc.write(html);
    doc.close();
    // 等 iframe 内样式/内容渲染完成后触发打印（300ms 足够本地 HTML 就绪）
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        /* 打印被环境拦截时静默：调用方按成功提示，用户仍可用 CSV 导出兜底 */
      }
      setTimeout(() => iframe.remove(), 1000);
    }, 300);
    return true;
  } catch {
    iframe.remove();
    return false;
  }
}

/** 导出报表：生成 HTML 后经系统打印对话框打印（可另存为 PDF） */
export async function exportToPdf(params: ExportParams): Promise<string> {
  const rows = await listTransactionsDetailed({ from: params.from, to: params.to });
  const cats = await getCategoryDistribution('expense', params.from, params.to);
  const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount, 0);
  const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  const surplus = income - expense;

  // 无 DOM 环境（SSR 等）时 fallback 导出纯文本
  if (typeof window === 'undefined') {
    const lines = [
      `交易报表 ${params.from} ~ ${params.to}`,
      `收入: ${income}    支出: ${expense}    结余: ${surplus}`,
      '',
      '===== 分类汇总（支出）=====',
      ...cats.map((c) => `${c.icon} ${c.name}: ${c.total}`),
      '',
      '===== 交易明细 =====',
      '日期\t类型\t金额\t账户\t目标账户\t备注\t分类',
      ...rows.map((r) =>
        `${r.date}\t${typeLabel(r.type)}\t${r.amount}\t${r.account_name}\t${r.to_account_name ?? ''}\t${r.note ?? ''}\t${r.category_name ?? ''}`
      ),
    ];
    downloadBlob(`\uFEFF${lines.join('\n')}`, `report_${params.from}_${params.to}.txt`, 'text/plain;charset=utf-8;');
    return '已导出 TXT 报表';
  }

  const categoryRows = cats.length
    ? cats.map((c) =>
        `<tr><td>${csvToHtml(c.icon)} ${csvToHtml(c.name)}</td><td style="text-align:right">${c.total}</td></tr>`
      ).join('')
    : '<tr><td colspan="2" style="text-align:center;color:#888">无支出记录</td></tr>';

  const txRows = rows.length
    ? rows.map((r) =>
        `<tr>` +
        `<td>${csvToHtml(r.date)}</td>` +
        `<td>${csvToHtml(typeLabel(r.type))}</td>` +
        `<td style="text-align:right">${r.amount}</td>` +
        `<td>${csvToHtml(r.account_name)}</td>` +
        `<td>${csvToHtml(r.to_account_name ?? '')}</td>` +
        `<td>${csvToHtml(r.note ?? '')}</td>` +
        `<td>${csvToHtml(r.category_name ?? '')}</td>` +
        `</tr>`
      ).join('')
    : '<tr><td colspan="7" style="text-align:center;color:#888">区间内无交易记录</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>交易报表</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #222; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #666; margin-bottom: 16px; }
  .summary { display: flex; gap: 24px; margin-bottom: 20px; }
  .summary div { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 10px 14px; }
  .summary .k { font-size: 12px; color: #888; }
  .summary .v { font-size: 18px; font-weight: 600; margin-top: 4px; }
  h2 { font-size: 15px; margin: 20px 0 8px; border-left: 3px solid #4f8cff; padding-left: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f5f7fa; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <h1>💰 记账交易报表</h1>
  <div class="meta">统计区间：${csvToHtml(params.from)} ~ ${csvToHtml(params.to)}</div>
  <div class="summary">
    <div><div class="k">总收入</div><div class="v" style="color:#16a34a">${income}</div></div>
    <div><div class="k">总支出</div><div class="v" style="color:#dc2626">${expense}</div></div>
    <div><div class="k">结余</div><div class="v">${surplus}</div></div>
  </div>
  <h2>分类汇总（支出）</h2>
  <table><thead><tr><th>分类</th><th>金额</th></tr></thead><tbody>${categoryRows}</tbody></table>
  <h2>交易明细</h2>
  <table>
    <thead><tr><th>日期</th><th>类型</th><th>金额</th><th>账户</th><th>目标账户</th><th>备注</th><th>分类</th></tr></thead>
    <tbody>${txRows}</tbody>
  </table>
</body>
</html>`;

  // 桌面（Tauri）环境：把报表写入临时文件并用系统默认浏览器打开，
  // 打印/另存为 PDF 的窗口在外部浏览器呈现（历史缺陷：WebView2 内 window.print()
  // 的打印对话框嵌在应用内部，体验不佳）。
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const p = await invoke<string>('open_report_in_browser', { html });
      return `报表已用默认浏览器打开（${p}），请在浏览器中打印或「另存为 PDF」`;
    } catch (e) {
      return `打开浏览器失败：${(e as Error).message}，请改用 CSV 导出`;
    }
  }

  if (!printHtml(html)) {
    return '当前环境无法触发打印，请改用 CSV 导出';
  }
  return '已打开系统打印窗口，可选择「另存为 PDF」完成导出';
}