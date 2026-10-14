import { Search, Plus, Moon, Sun, Bot, Download, ArrowUpCircle } from 'lucide-react';
import { useState } from 'react';
import TransactionForm from '@/components/transaction/TransactionForm';
import { LedgerSwitcher } from '@/components/layout/LedgerSwitcher';
import NotificationBell from '@/components/layout/NotificationBell';
import { useUIStore } from '@/stores/useUIStore';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';
import { useTheme } from '@/hooks/useTheme';
import { useUpdateStore } from '@/stores/useUpdateStore';

export default function Topbar() {
  const { theme, toggleTheme } = useTheme();
  const [formOpen, setFormOpen] = useState(false);
  const updatePhase = useUpdateStore((s) => s.phase);
  const updateInfo = useUpdateStore((s) => s.info);
  const openUpdateDialog = useUpdateStore((s) => s.openDialog);

  return (
    <>
      <header
        className="flex h-16 items-center gap-4 border-b px-6 transition-colors duration-300"
        style={{
          borderColor: 'var(--border)',
          background: 'rgba(var(--card-rgb), 0.7)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <button
          onClick={() => { useUIStore.getState().setCommandOpen(true); }}
          className="group flex max-w-md flex-1 items-center gap-3 rounded-xl border px-4 py-2 text-sm text-muted shadow-sm transition-all hover:border-[var(--color-primary)]/50 hover:bg-[var(--card)] hover:shadow-md"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
        >
          <Search size={16} className="text-muted group-hover:text-[var(--color-primary)]" />
          <span className="flex-1 text-left">搜索功能、分类、交易…</span>
          <kbd className="hidden rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-xs font-medium text-muted shadow-sm sm:inline-block">
            Ctrl K
          </kbd>
        </button>
        <div className="flex items-center gap-2 ml-auto">
          {/* 更新状态指示器 */}
          {(updatePhase === 'downloading' || updatePhase === 'ready') && (
            <button
              onClick={openUpdateDialog}
              title={updatePhase === 'ready' ? `新版本 V${updateInfo?.version} 已就绪，点击安装` : '更新下载中…'}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                updatePhase === 'ready'
                  ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] hover:bg-[var(--color-success)]/20'
                  : 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20'
              }`}
            >
              {updatePhase === 'downloading' ? (
                <>
                  <Download size={14} className="animate-bounce" />
                  <span>下载中</span>
                </>
              ) : (
                <>
                  <ArrowUpCircle size={14} className="animate-pulse" />
                  <span>待重启</span>
                </>
              )}
            </button>
          )}

          <button
            onClick={() => setFormOpen(true)}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-[var(--color-primary-foreground)] shadow-md transition-all hover:scale-105 hover:shadow-lg active:scale-95"
            style={{ background: 'var(--color-primary)' }}
          >
            <Plus size={16} strokeWidth={3} /> 记一笔
          </button>
          <div className="h-6 w-px bg-[var(--border)] mx-1" />
          <NotificationBell />
          <button
            onClick={() => useAiAssistantStore.getState().openAssistant()}
            title="AI 助手"
            aria-label="AI 助手"
            className="rounded-xl p-2.5 text-muted transition-colors hover:bg-black/5 hover:text-[var(--fg)] dark:hover:bg-white/10"
          >
            <Bot size={18} />
          </button>
          <LedgerSwitcher />
          <button
            onClick={toggleTheme}
            className="rounded-xl p-2.5 text-muted transition-colors hover:bg-black/5 hover:text-[var(--fg)] dark:hover:bg-white/10"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <TransactionForm open={formOpen} onOpenChange={setFormOpen} />
    </>
  );
}