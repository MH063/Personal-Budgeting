import { EmptyState } from '@/components/common/EmptyState';

export function DataTable<T extends { id: number }>({ columns, data, isLoading, onRowClick, selectable, selectedIds = [], onSelectionChange }: {
  columns: { key: string; header: string; render: (row: T) => React.ReactNode }[];
  data: T[];
  isLoading?: boolean;
  onRowClick?: (row: T) => void;
  /** 启用行选择（首列复选框 + 表头全选）；与 selectedIds/onSelectionChange 配套使用 */
  selectable?: boolean;
  /** 当前已选中的行 id 列表 */
  selectedIds?: number[];
  /** 勾选变化回调（参数为最新的完整选中 id 列表） */
  onSelectionChange?: (ids: number[]) => void;
}) {
  if (isLoading) return <div className="p-8 text-center text-muted">加载中…</div>;
  if (data.length === 0) return <EmptyState text="暂无记录" />;

  const allChecked = selectable && data.length > 0 && data.every((r) => selectedIds.includes(r.id));
  const someChecked = selectable && data.some((r) => selectedIds.includes(r.id));

  /** 表头全选/取消本页 */
  const toggleAll = () => onSelectionChange?.(allChecked ? [] : data.map((r) => r.id));
  /** 单行勾选切换 */
  const toggleOne = (id: number) =>
    onSelectionChange?.(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      <table className="w-full">
        <thead style={{ background: 'var(--card)' }}>
          <tr>
            {selectable && (
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={!!allChecked}
                  ref={(el) => { if (el) el.indeterminate = !!someChecked && !allChecked; }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer accent-[var(--color-primary)]"
                  aria-label="全选本页"
                />
              </th>
            )}
            {columns.map((c) => (
              <th key={c.key} className="px-4 py-2.5 text-left text-xs font-semibold text-muted">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const isSel = selectable && selectedIds.includes(row.id);
            return (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className="border-t border-[var(--border)] hover:bg-black/5 dark:hover:bg-white/5"
                style={{ ...(onRowClick ? { cursor: 'pointer' } : {}), ...(isSel ? { background: 'rgba(30,111,169,0.08)' } : {}) }}
              >
                {selectable && (
                  <td className="w-10 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!!isSel}
                      onChange={() => toggleOne(row.id)}
                      className="h-4 w-4 cursor-pointer accent-[var(--color-primary)]"
                      aria-label="选择该行"
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className="px-4 py-2.5 text-sm">{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}