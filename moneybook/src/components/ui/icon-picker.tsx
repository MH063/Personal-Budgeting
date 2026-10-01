import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ICON_PALETTE } from '@/lib/constants';

// 内置图标选择器：供分类/账户/储蓄目标等表单选择图标
export function IconPicker({ value, onChange, className, placeholder = '选择图标' }: {
  value?: string;
  onChange: (icon: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // 去重后再渲染：ICON_PALETTE 中可能有同名图标（如 ✈️ / 🎓 / 🏠），
  // 若不去重，React 会因重复 key 报错并可能导致子节点被省略/重复渲染错误。
  const icons = Array.from(new Set(ICON_PALETTE.filter((i) => i.includes(q.trim()))));

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setQ(''); }}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--color-primary)]"
      >
        <span className="text-lg leading-none">{value || '❔'}</span>
        <span className={cn('flex-1 text-left truncate', !value && 'text-muted')}>
          {value ? '点击更换图标' : placeholder}
        </span>
        <span className="text-xs text-muted">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索图标…"
            className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--color-primary)]"
          />
          <div className="mt-2 grid max-h-52 grid-cols-8 gap-1 overflow-y-auto rounded-lg border border-[var(--border)] p-2">
            {icons.map((ic) => (
              <button
                key={ic}
                type="button"
                onClick={() => { onChange(ic); setOpen(false); }}
                title={ic}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md text-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5',
                  value === ic && 'bg-black/10 ring-1 ring-[var(--color-primary)] dark:bg-white/10'
                )}
              >
                {ic}
              </button>
            ))}
            {icons.length === 0 && (
              <div className="col-span-8 py-3 text-center text-xs text-muted">无匹配图标</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}