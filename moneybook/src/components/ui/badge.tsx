import { cn } from '@/lib/utils';

export function Badge({ className, color = '#10B981', children }: {
  className?: string; color?: string; children: React.ReactNode;
}) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', className)}
      style={{ backgroundColor: `${color}1a`, color }}
    >
      {children}
    </span>
  );
}