import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useLedgers, useSwitchLedger } from '@/hooks/useLedgers';
import { useLedgerStore } from '@/stores/useLedgerStore';

/**
 * 顶栏账本切换器。
 *
 * 职责收敛为两件事：切换当前账本、跳转到账本管理页。
 * 新建 / 重命名 / 删除 / 复制等管理操作统一在「设置 → 账本管理」页面完成，
 * 避免同一功能在弹窗和页面里维护两套实现。
 */
export function LedgerSwitcher() {
  const { data: ledgers = [] } = useLedgers();
  const currentId = useLedgerStore((s) => s.currentId);
  const switchLedger = useSwitchLedger();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const current = ledgers.find((l) => l.id === currentId);

  /** 切换账本后收起弹层（缓存清理由 useSwitchLedger 统一完成） */
  async function doSwitch(id: number) {
    await switchLedger(id);
    setOpen(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
      >
        <span>{current?.icon || '📒'}</span>
        <span className="font-medium">{current?.name || '账本'}</span>
      </button>

      {open && createPortal(
        // 必须 portal 到 body：该组件挂在 Topbar 的 <header> 内，而 header 带 backdrop-filter，
        // 会让 position:fixed 的相对包含块退化为 header（高 64px），弹窗被压成一条并被裁切。
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="w-[min(92vw,360px)] rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 font-semibold">选择账本</h3>
            <div className="max-h-[60vh] space-y-1 overflow-y-auto">
              {ledgers.map((l) => (
                <button
                  key={l.id}
                  onClick={() => doSwitch(l.id)}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${l.id === currentId ? '' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
                  style={l.id === currentId ? { background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' } : {}}
                >
                  <span className="shrink-0">{l.icon}</span>
                  <span className="truncate">{l.name}</span>
                  {l.id === currentId && <span className="ml-auto shrink-0 text-xs">✓</span>}
                </button>
              ))}
              {ledgers.length === 0 && <p className="px-3 py-2 text-xs text-muted">暂无账本，请前往账本管理新建。</p>}
            </div>
            <button
              onClick={() => { setOpen(false); navigate('/settings?tab=ledgers'); }}
              className="mt-3 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5"
            >
              管理账本…
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
