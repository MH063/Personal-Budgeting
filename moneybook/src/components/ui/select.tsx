import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
  color?: string;
}

export function Select<T extends string>({ value, onChange, options, placeholder = '请选择', className }: {
  value?: T;
  onChange: (v: T) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={placeholder}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm"
      >
        {selected?.icon && <span>{selected.icon}</span>}
        <span className={cn('flex-1 text-left truncate', !selected && 'text-muted')}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="text-xs text-muted">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => { onChange(o.value as T); setOpen(false); }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/5',
                o.value === value && 'bg-black/5 dark:bg-white/5'
              )}
            >
              {o.icon && <span>{o.icon}</span>}
              <span className="truncate">{o.label}</span>
              {o.value === value && <span className="ml-auto text-[var(--color-primary-fg)]">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}