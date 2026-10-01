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

/** 把对象数组转成 CSV 并触发浏览器下载 */
export function toCsv(rows: object[], filename?: string): void {
  if (!rows.length) return;
  downloadBlob(toCsvString(rows), filename ?? 'export.csv', 'text/csv;charset=utf-8;');
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
  toCsv(data, `transactions_${params.from}_${params.to}.csv`);
  return `已导出 ${data.length} 条`;
}

const csvToHtml = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 导出报表：优先用 window.print 打印（另存为 PDF），否则 fallback 为 TXT */
export async function exportToPdf(params: ExportParams): Promise<string> {
  const rows = await listTransactionsDetailed({ from: params.from, to: params.to });
  const cats = await getCategoryDistribution('expense', params.from, params.to);
  const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount, 0);
  const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  const surplus = income - expense;

  // 不可用 window.print 时 fallback 导出纯文本
  if (typeof window === 'undefined' || typeof window.print !== 'function') {
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

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    return '无法打开打印窗口，请允许弹窗后重试（或改用 CSV 导出）';
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
  return '已打开打印窗口，可选择另存为 PDF';
}