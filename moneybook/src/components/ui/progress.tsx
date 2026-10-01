import { cn } from '@/lib/utils';

export function Progress({ value, className, color = '#1E6FA9' }: {
  value: number; className?: string; color?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10', className)}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}