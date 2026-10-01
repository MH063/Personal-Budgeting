// 全局通知中心（顶栏铃铛）
// -----------------------------------------------------------------------------
// 聚合系统级提醒：逾期借贷、本月预算超支、回收站待恢复记录、本地存储告警。
// 点击铃铛展开面板，点击某条通知跳转到对应页面；外部点击/ESC 关闭。
// 所有数据均来自本地数据库查询（无网络请求，不泄露任何数据到云端）。
// 通知项的组装逻辑抽离在 @/lib/notifications（纯函数，可单测）。
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useOverdueLoans } from '@/hooks/useLoans';
import { useTrash } from '@/hooks/useTrash';
import { getBudgetVsActualAdvanced } from '@/api/stats';
import { estimateStorageUsage } from '@/api/db';
import { listRecurring, type Recurring } from '@/api/recurring';
import { buildNotices, type NoticeItem } from '@/lib/notifications';
import type { StorageUsage } from '@/api/db';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // —— 各类提醒数据源（本地查询）——
  const { data: overdue = [] } = useOverdueLoans();
  const { list: trashList } = useTrash();
  const trashCount = trashList.data?.length ?? 0;
  const { data: budgets = [] } = useQuery({
    queryKey: ['stats', 'budget', 'monthly', dayjs().format('YYYY-MM')],
    queryFn: () => getBudgetVsActualAdvanced({ period: 'monthly', anchor: dayjs().format('YYYY-MM') }),
  });
  const { data: storage } = useQuery({ queryKey: ['storage', 'usage'], queryFn: estimateStorageUsage });
  // 周期记账到期项（纯查询，不触发 applyDueRecurring 自动入账，避免在"只看通知"时改变数据）
  const { data: recurringList = [] } = useQuery({ queryKey: ['recurring', 'list'], queryFn: listRecurring });

  // 端上过滤"今日到期且仍启用"的周期项映射为 dueRecurrings
  const dueRecurrings: Array<{ note: string | null; amount: number; type: string }> = useMemo(() => {
    return recurringList
      .filter((r: Recurring) => r.is_active === 1 && r.next_run && r.next_run <= dayjs().startOf('day').format('YYYY-MM-DD'))
      .slice(0, 5)
      .map((r: Recurring) => ({ note: r.note || null, amount: r.amount, type: r.type }));
  }, [recurringList]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // —— 组装通知项（纯函数）——
  const storageUsage: StorageUsage | null = storage ?? null;
  const { notices } = buildNotices({
    overdueCount: overdue.length,
    overduePartyNames: overdue.map((l) => l.counterparty),
    overBudgets: budgets.filter((b) => b.status === 'over'),
    trashCount,
    dueRecurrings,
    storageUsage,
  });
  const total = notices.length;

  return (
    <div className="relative" ref={boxRef}>
      {/* 铃铛按钮 */}
      <button
        onClick={() => setOpen((v) => !v)}
        title={total ? `有 ${total} 条提醒` : '通知中心'}
        className="relative rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/5"
      >
        <Bell size={16} />
        {total > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-bold leading-none text-white">
            {total}
          </span>
        )}
      </button>

      {/* 通知下拉面板 */}
      {open && (
        <div
          className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-xl border shadow-2xl"
          style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <span className="text-sm font-semibold">通知与提醒</span>
            <span className="text-xs text-muted">{total ? `${total} 条未读` : '暂无新提醒'}</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {notices.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-8 text-muted">
                <span className="text-2xl">🔔</span>
                <span className="text-sm">一切正常，暂无提醒</span>
              </div>
            ) : (
              notices.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  onClick={() => { setOpen(false); navigate(n.to); }}
                  className="flex w-full items-start gap-3 border-b border-[var(--border)] px-4 py-3 text-left transition hover:bg-black/5 dark:hover:bg-white/5 last:border-b-0"
                >
                  <span className="mt-0.5 text-lg">{n.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{n.title}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">{n.desc}</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[var(--border)] px-4 py-2">
            <button
              type="button"
              onClick={() => { setOpen(false); navigate('/trash'); }}
              className="w-full rounded-lg px-2 py-1.5 text-center text-xs text-muted after:content-[''] hover:bg-black/5 dark:hover:bg-white/5"
            >
              全部已读（进入回收站处理）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}