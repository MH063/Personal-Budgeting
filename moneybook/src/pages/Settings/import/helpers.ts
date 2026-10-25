import type { ImportRow } from '@/api/import';

/** 支付宝等导出的 CSV 常为 GBK 编码：优先按 UTF-8 解码，若出现替换符则视为 GBK 重解。 */
export function decodeText(buf: Uint8Array): string {
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const data = hasBom ? buf.subarray(3) : buf;
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (!hasBom && asUtf8.includes('\uFFFD')) {
    try { return new TextDecoder('gbk').decode(data); } catch { /* 回退 utf-8 */ }
  }
  return asUtf8;
}

/** 导入类型下拉选项（预览与「导入后待核对」共用） */
export const IMPORT_TYPE_OPTIONS: { value: ImportRow['type']; label: string }[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'repay_in', label: '负债减少' },
];

/**
 * 导入预览快照的 localStorage 键（主窗口 → 独立窗口的数据通道）。
 * 快照结构：{ rows, dupLines[], parseWarn[], pendingAccounts[] }，validCount/total/pendingRows 由 rows 派生。
 */
export const IMPORT_PREVIEW_KEY = 'moneybook.importPreview.v1';

/**
 * 「导入后待核对」项：可疑行（去向为账单推测）已按推测口径入库，
 * 携带库中交易 id 与解析后的账户 id，便于就地改类型/账户后回写该交易。
 */
export interface ReconItem {
  id: number;
  line: number;
  pending: string;
  /** 原始解析行（保留备注/订单号/支付时间等字段，回写时一并带回去，避免丢字段） */
  src: ImportRow;
  type: ImportRow['type'];
  accountId: number;
  toAccountId: number | null;
}
