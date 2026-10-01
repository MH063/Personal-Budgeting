import { useEffect } from 'react';
import { cn } from '@/lib/utils';

export function Modal({ open, onClose, title, children, wide, side }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  wide?: boolean;
  side?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    // 遮罩不做点击关闭（历史缺陷：点弹窗外部/遮罩会直接关闭，导致正在编辑的表单内容丢失）。
    // 关闭入口仅保留：标题栏 ✕ 按钮、调用方自定义按钮、Esc 键。
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-24">
      <div
        className={cn(
          'flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl bg-[var(--card)] shadow-2xl',
          side ? 'h-full w-[460px] rounded-r-none' : wide ? 'max-w-2xl' : 'max-w-md'
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <h2 className="font-semibold">{title}</h2>
            <button className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/5" onClick={onClose}>✕</button>
          </div>
        )}
        <div className={cn('overflow-y-auto', title ? 'p-5' : 'p-5')}>{children}</div>
      </div>
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} side>
      {children}
    </Modal>
  );
}