import { formatMoney } from '@/lib/format';
import type { ImportSmoke } from '@/api/import';
import { IMPORT_TYPE_OPTIONS, type ReconItem } from './helpers';

interface ReconPanelProps {
  /** 待核对项（可疑行已按账单推测口径入库，就地修正后回写该交易） */
  recon: ReconItem[];
  /** 账户下拉数据源（导入后已刷新，含本次新建的账户） */
  accounts: ImportSmoke['accounts'];
  /** 更新本地选择（类型/账户/转入账户），点「保存」时才回写库 */
  onPatch: (id: number, patch: Partial<Pick<ReconItem, 'type' | 'accountId' | 'toAccountId'>>) => void;
  /** 保存某项：按修正后的类型/账户回写库中交易 */
  onSave: (item: ReconItem) => void;
  /** 忽略某项：保持当前口径，移出待核对列表 */
  onRemove: (id: number) => void;
}

/**
 * 导入后待核对区块：可疑行（去向为账单推测）已按推测口径入库，
 * 此处可就地改类型/账户并回写该交易，避免整批回滚重导。
 * （自 ImportManage 页拆出，展示与交互保持不变。）
 */
export default function ReconPanel({ recon, accounts, onPatch, onSave, onRemove }: ReconPanelProps) {
  if (recon.length === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">导入后待核对（{recon.length} 条）</h3>
        <span className="text-xs text-muted">这些行已按账单推测口径入库；若去向不符，改类型/账户后点「保存」修正该交易。</span>
      </div>
      <div className="max-h-80 overflow-auto rounded-lg border border-[var(--border)]">
        <table className="w-full min-w-[640px] table-fixed text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--bg)] text-left text-xs font-semibold text-[var(--fg)] shadow-[0_1px_0_0_var(--border)]">
            <tr>
              <th className="w-12 px-2 py-2">行</th>
              <th className="w-28 px-2 py-2">日期</th>
              <th className="w-24 px-2 py-2">类型</th>
              <th className="w-28 px-2 py-2 text-right">金额</th>
              <th className="px-2 py-2">账户</th>
              <th className="hidden px-2 py-2 sm:table-cell">转入</th>
              <th className="w-32 px-2 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {recon.map((it) => (
              <tr key={it.id} className="border-t border-[var(--border)] bg-[var(--color-warning,#F59E0B)]/8">
                <td className="px-2 py-1.5 text-[var(--color-warning,#F59E0B)]" title={it.pending}>⚠ {it.line}</td>
                <td className="px-2 py-1.5">{it.src.date || '—'}</td>
                <td className="px-2 py-1.5">
                  <select
                    value={it.type}
                    onChange={(e) => onPatch(it.id, {
                      type: e.target.value as ReconItem['type'],
                      toAccountId: e.target.value === 'transfer' ? it.toAccountId : null,
                    })}
                    className="h-7 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                  >
                    {IMPORT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-right font-medium">{['income', 'repay_in'].includes(it.type) ? '+' : '-'}{formatMoney(it.src.amount)}</td>
                <td className="px-2 py-1.5">
                  <select
                    value={String(it.accountId)}
                    onChange={(e) => onPatch(it.id, { accountId: Number(e.target.value) })}
                    className="h-7 w-full min-w-0 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                  >
                    {accounts.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                  </select>
                </td>
                <td className="hidden px-2 py-1.5 sm:table-cell">
                  {it.type === 'transfer' ? (
                    <select
                      value={it.toAccountId == null ? '' : String(it.toAccountId)}
                      onChange={(e) => onPatch(it.id, { toAccountId: e.target.value ? Number(e.target.value) : null })}
                      className="h-7 w-full min-w-0 rounded border border-[var(--border)] bg-transparent px-1 text-xs [color-scheme:inherit]"
                    >
                      <option value="">（选择转入账户）</option>
                      {accounts.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                    </select>
                  ) : <span className="text-xs text-muted">—</span>}
                </td>
                <td className="w-28 px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => onSave(it)}
                      className="rounded border border-[var(--color-primary)] px-2 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/10">保存</button>
                    <button type="button" onClick={() => onRemove(it.id)}
                      title="忽略：保持当前口径，移出待核对"
                      className="flex h-6 w-6 items-center justify-center rounded-md text-sm text-muted hover:bg-black/5 dark:hover:bg-white/10">✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
