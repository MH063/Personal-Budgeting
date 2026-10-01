import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Hint 悬浮说明图标：把说明性长文案收进「?」小图标，悬浮或点击时展开气泡。
 * 背景（用户反馈）：各页面直接铺大段说明文字影响美观；统一改为
 * 「图标 + 气泡提示」——界面保持清爽，提示内容仍随时可查，信息不丢失。
 * 交互：鼠标悬浮/键盘聚焦显示，移出/失焦收起；点击可切换（触屏设备可点开）。
 */
export function Hint({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={cn('relative inline-flex align-middle', className)}>
      <button
        type="button"
        aria-label="查看说明"
        className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] text-[10px] font-semibold leading-none text-muted transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ?
      </button>
      {open && (
        <span className="absolute left-0 top-full z-[60] mt-1.5 w-64 whitespace-normal rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 text-left text-xs font-normal leading-relaxed text-muted shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}