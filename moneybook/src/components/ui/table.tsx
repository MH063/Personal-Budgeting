import { EmptyState } from '@/components/common/EmptyState';

export function Table<T extends Record<string, unknown>>({ columns, data }: {
  columns: { key: string; header: string; render: (row: T) => React.ReactNode }[];
  data: T[];
}) {
  if (data.length === 0) return <EmptyState text="暂无记录" />;
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      <table className="w-full">
        <thead style={{ background: 'var(--card)' }}>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="px-4 py-2.5 text-left text-xs font-semibold text-muted">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-t border-[var(--border)] hover:bg-black/5 dark:hover:bg-white/5">
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-2.5 text-sm">{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}