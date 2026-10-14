import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'outline' | 'ghost' | 'danger' | 'success' | 'link';
type Size = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  // 主色底（浅色深板岩 / 暗色近白）上的文字必须用前景变量；
  // 历史缺陷：硬编码 text-white 会在暗色下变成「白底白字」而不可见。
  default: 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] hover:opacity-90',
  outline: 'border bg-transparent hover:bg-black/5 dark:hover:bg-white/5',
  ghost: 'bg-transparent hover:bg-black/5 dark:hover:bg-white/5',
  danger: 'bg-[var(--color-danger)] text-white hover:opacity-90',
  success: 'bg-[var(--color-success)] text-white hover:opacity-90',
  link: 'text-[var(--color-primary-fg)] underline-offset-4 hover:underline',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-6 text-base',
  icon: 'h-9 w-9',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = 'Button';