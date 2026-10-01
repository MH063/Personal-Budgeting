import { Search, Plus, Moon, Sun, Bot } from 'lucide-react';
import { useState } from 'react';
import TransactionForm from '@/components/transaction/TransactionForm';
import { LedgerSwitcher } from '@/components/layout/LedgerSwitcher';
import NotificationBell from '@/components/layout/NotificationBell';
import { useUIStore } from '@/stores/useUIStore';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';
import { useTheme } from '@/hooks/useTheme';

export default function Topbar() {
  const { theme, toggleTheme } = useTheme();
  const [formOpen, setFormOpen] = useState(false);

  return (
    <>
      <header
        className="flex h-14 items-center gap-3 border-b px-6"
        style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
      >
        <button
          onClick={() => { useUIStore.getState().setCommandOpen(true); }}
          className="flex max-w-md flex-1 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-muted"
          style={{ borderColor: 'var(--border)' }}
        >
          <Search size={14} />
          <span>搜索功能、分类、交易…</span>
          <kbd className="ml-auto rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10">Ctrl K</kbd>
        </button>
        <button
          onClick={() => setFormOpen(true)}
          className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-white hover:opacity-90"
          style={{ background: 'var(--color-primary)' }}
        >
          <Plus size={14} /> 记一笔
        </button>
        {/* 全局通知中心：逾期借贷 / 预算超支 / 回收站待恢复 / 存储告警 */}
        <NotificationBell />
        {/* AI 助手统一入口（弹窗内对话，避免各页面重复嵌入 AI 区块） */}
        <button
          onClick={() => useAiAssistantStore.getState().openAssistant()}
          title="AI 助手"
          aria-label="AI 助手"
          className="rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Bot size={16} />
        </button>
        <LedgerSwitcher />
        <button
          onClick={toggleTheme}
          className="rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/5"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <TransactionForm open={formOpen} onOpenChange={setFormOpen} />
    </>
  );
}