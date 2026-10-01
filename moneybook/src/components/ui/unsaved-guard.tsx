import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Esc 键关闭监听：仅当 enabled 为真时挂载。
 * 主动键盘操作（Esc）与点击 ✕ 走同一份 handler，由 handler 决定
 * 直接关闭还是进入「未保存拦截」确认，保证各入口行为一致。
 */
export function useEscapeClose(enabled: boolean, handler: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled, handler]);
}

/**
 * 「关闭弹窗时存在未保存修改」的拦截确认弹窗。
 * 三条出路：继续编辑 / 不保存并关闭 / 保存并关闭（无保存语义的向导传 canSave=false）。
 */
export function UnsavedCloseDialog({
  open,
  canSave,
  onContinue,
  onDiscard,
  onSave,
}: {
  open: boolean;
  /** 是否提供「保存并关闭」出路（纯选择向导等无保存语义时传 false） */
  canSave: boolean;
  onContinue: () => void;
  onDiscard: () => void;
  onSave?: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30">
      <div className="w-80 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-2 font-semibold">有未保存的修改</h3>
        <p className="mb-4 text-sm text-muted">关闭将丢失当前输入的内容，请选择处理方式。</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onContinue}>继续编辑</Button>
          <Button size="sm" variant="outline" onClick={onDiscard}>不保存并关闭</Button>
          {canSave && onSave && <Button size="sm" onClick={onSave}>保存并关闭</Button>}
        </div>
      </div>
    </div>
  );
}