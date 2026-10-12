import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { formatMoney } from '@/lib/format';
import { rowKeyOf, type ImportRow } from '@/api/import';
import { IMPORT_TYPE_OPTIONS } from './helpers';

interface PreviewDialogProps {
  open: boolean;
  onClose: () => void;
  /** 全部解析行（含被跳过、待核对标记） */
  rows: ImportRow[];
  /** 有效行数（不含被规则跳过的行） */
  validCount: number;
  /** 有效行的支出合计 */
  total: number;
  /** 待确认行（去向为账单推测，导入后需核对） */
  pendingRows: ImportRow[];
  /** 疑似重复行号集合（导入时自动跳过） */
  dupLines: Set<number>;
  /** 解析警告（部分行被跳过或解析未识别） */
  parseWarn: string[];
  /** 将被自动创建的账户名（可改名到已有账户以复用） */
  pendingAccounts: string[];
  onRenamePending: (oldName: string, newName: string) => void;
  onPatchRow: (key: string, patch: Partial<ImportRow>) => void;
  onConfirmRow: (key: string) => void;
  onRemoveRow: (key: string) => void;
  /** 将全部「待确认」行标记为无需复核 */
  onClearPending: () => void;
  onImport: () => void;
  busy: boolean;
}

/**
 * 导入解析结果弹窗：选择文件识别成功后集中展示（避免预览大表格挤在页面）。
 * 弹窗内可编辑修正误判（类型/账户/分类/备注）、确认或移除单行，确认后直接「开始导入」；
 * 关闭仅收起弹窗，预览数据保留在内存直至下次解析。
 * （自 ImportManage 页拆出，展示与交互保持不变。）
 */
export default function PreviewDialog({
  open, onClose, rows, validCount, total, pendingRows, dupLines, parseWarn,
  pendingAccounts, onRenamePending, onPatchRow, onConfirmRow, onRemoveRow, onClearPending, onImport, busy,
}: PreviewDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={`导入解析结果（${validCount} 条）`}>
      <div className="space-y-3">
        {/* 概要：识别 / 跳过 / 疑似重复 / 待确认 */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>识别 <b className="text-[var(--fg)]">{validCount}</b> 条</span>
          <span>支出合计 <b className="text-[var(--fg)]">{formatMoney(total)}</b></span>
          {pendingRows.length > 0 && (
            <span className="text-[var(--color-warning,#F59E0B)]">⚠ {pendingRows.length} 行去向为账单推测（导入后待核对）</span>
          )}
          {dupLines.size > 0 && (
            <span className="text-[var(--color-warning,#F59E0B)]">● {dupLines.size} 条疑似重复（导入时自动跳过）</span>
          )}
        </div>
        {parseWarn.length > 0 && (
          <div className="rounded-lg border-l-4 border-[var(--color-warning,#F59E0B)] bg-[var(--color-warning,#F59E0B)]/10 px-3 py-2 text-xs leading-relaxed text-[var(--fg)]">
            <div className="mb-1 font-medium text-[var(--color-warning,#F59E0B)]">导入待确认（部分行被跳过或解析未识别）</div>
            {parseWarn.slice(0, 6).map((w, i) => <div key={i} className="text-muted">{w}</div>)}
            {parseWarn.length > 6 && <div className="text-muted">…共 {parseWarn.length} 条未解析</div>}
          </div>
        )}
        {/* 将自动创建的账户：可改名到已有账户以复用，避免误建重复账户 */}
        {pendingAccounts.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted">导入时将自动创建账户（可改名到已有账户以复用，避免重复）：</div>
            <div className="flex flex-wrap gap-2">
              {pendingAccounts.map((n) => (
                <label key={n} className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-black/2 px-2 py-1 text-xs dark:bg-white/5">
                  <input
                    value={n}
                    onChange={(e) => onRenamePending(n, e.target.value)}
                    className="w-32 rounded bg-transparent outline-none"
                  />
                </label>
              ))}
            </div>
          </div>
        )}
        {/* 可编辑预览：修正误判后点「开始导入」 */}
        {pendingRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border-l-4 border-[var(--color-warning,#F59E0B)] bg-[var(--color-warning,#F59E0B)]/10 px-3 py-2 text-xs">
            <span className="text-[var(--color-warning,#F59E0B)]">
              ⚠ {pendingRows.length} 行去向为账单推测（退款到账账户 / 提现到账卡）：将按推测口径先入库，导入后可在下方「导入后待核对」逐条修正。
            </span>
            <button type="button"
              onClick={onClearPending}
              title="这些行的推测去向已足够确定，无需导入后复核"
              className="rounded border border-[var(--color-warning,#F59E0B)] px-2 py-0.5 text-[var(--color-warning,#F59E0B)] hover:bg-[var(--color-warning,#F59E0B)]/10">
              均无需复核
            </button>
          </div>
        )}
        <div className="max-h-72 overflow-auto rounded-lg border border-[var(--border)]">
          <table className="w-full min-w-[640px] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--bg)] text-left text-xs font-semibold text-[var(--fg)] shadow-[0_1px_0_0_var(--border)]">
              <tr>
                <th className="w-12 px-2 py-2">行</th>
                <th className="w-28 px-2 py-2">日期</th>
                <th className="w-20 px-2 py-2">类型</th>
                <th className="w-28 px-2 py-2 text-right">金额</th>
                <th className="px-2 py-2">账户</th>
                <th className="hidden px-2 py-2 sm:table-cell">转入</th>
                <th className="hidden px-2 py-2 md:table-cell">分类</th>
                <th className="hidden px-2 py-2 lg:table-cell">备注</th>
                <th className="w-20 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = rowKeyOf(r);
                const isSkipped = !!r._skippedReason;
                const isPending = !isSkipped && !!r._pending;
                return (
                <tr key={key} className={`border-t border-[var(--border)] ${
                  isSkipped ? 'bg-black/2 dark:bg-white/5'
                    : isPending ? 'bg-[var(--color-warning,#F59E0B)]/8'
                    : dupLines.has(r.line) ? 'bg-[var(--color-warning,#F59E0B)]/5' : ''
                }`}>
                  <td className="px-2 py-1.5 text-muted">
                    {dupLines.has(r.line) && <span className="mr-1 text-[var(--color-warning,#F59E0B)]" title="疑似重复导入，将被跳过">●</span>}
                    {isSkipped && <span className="mr-1 text-[var(--color-warning,#F59E0B)]" title={r._skippedReason}>⏭</span>}
                    {isPending && <span className="mr-1 text-[var(--color-warning,#F59E0B)]" title={r._pending}>⚠</span>}
                    {!isSkipped && !isPending && r.basis && (
                      <span className="mr-1 cursor-help text-[var(--color-muted)]" title={r.basis}>ℹ</span>
                    )}
                    {r.line}
                  </td>
                  <td className="px-2 py-1.5">{r.date}</td>
                  <td className="px-2 py-1.5">
                    {isSkipped && (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-[var(--color-warning,#F59E0B)]" title={r._skippedReason}>已跳过</span>
                        <button type="button"
                          onClick={() => onPatchRow(key, { type: 'expense', _skippedReason: undefined })}
                          className="rounded border border-[var(--color-primary)] px-1 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10" title="按支出恢复">支出</button>
                        <button type="button"
                          onClick={() => onPatchRow(key, { type: 'income', _skippedReason: undefined })}
                          className="rounded border border-[var(--color-primary)] px-1 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10" title="按收入恢复">收入</button>
                      </div>
                    )}
                    {!isSkipped && (
                    <div className="flex items-center gap-1">
                      <select
                        value={r.type}
                        onChange={(e) => onPatchRow(key, { type: e.target.value as ImportRow['type'] })}
                        className="h-7 w-full min-w-0 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                      >
                        {IMPORT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium">{isSkipped ? '' : ['income', 'repay_in'].includes(r.type) ? '+' : '-'}{formatMoney(r.amount)}</td>
                  <td className="px-2 py-1.5">
                    <input value={r.account} onChange={(e) => onPatchRow(key, { account: e.target.value, _pending: undefined })}
                      className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                  </td>
                  <td className="hidden px-2 py-1.5 sm:table-cell">
                    <input value={r.toAccount ?? ''} onChange={(e) => onPatchRow(key, { toAccount: e.target.value || undefined, _pending: undefined })}
                      className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                  </td>
                  <td className="hidden px-2 py-1.5 md:table-cell">
                    <input value={r.category ?? ''} onChange={(e) => onPatchRow(key, { category: e.target.value || undefined })}
                      className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                  </td>
                  <td className="hidden px-2 py-1.5 lg:table-cell">
                    <input value={r.note ?? ''} onChange={(e) => onPatchRow(key, { note: e.target.value || undefined })}
                      className="w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none transition-colors hover:border-[var(--border)] focus:border-[var(--color-primary)]" />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      {isPending && (
                        <button type="button" onClick={() => onConfirmRow(key)} title={r._pending}
                          className="rounded border border-[var(--color-warning,#F59E0B)] px-1.5 py-0.5 text-xs text-[var(--color-warning,#F59E0B)] hover:bg-[var(--color-warning,#F59E0B)]/10">确认</button>
                      )}
                      <button type="button" onClick={() => onRemoveRow(key)} title={isSkipped ? '移出待确认列表' : '移出本次导入'}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted transition-colors hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]">✕</button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
          <span className="mr-auto text-xs text-muted">类型 / 账户 / 分类 / 备注可直接编辑以修正误判</span>
          <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
          <Button size="sm" onClick={onImport} disabled={!validCount || busy}>
            {busy ? '导入中…' : `开始导入 ${validCount} 条`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
