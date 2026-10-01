import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { ACCOUNT_TYPES } from '@/lib/constants';
import type { Account } from '@/api/accounts';
import type { HoldingSummary } from '@/api/holdings';

export function AccountCard({ account, holding, onEdit, onDelete, onToggle, onHoldings, onMerge }: {
  account: Account;
  /** 投资账户：持仓市值与盈亏（用于展示 现金/市值/总资产） */
  holding?: HoldingSummary;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggle?: () => void;
  onHoldings?: () => void;
  onMerge?: () => void;
}) {
  const meta = ACCOUNT_TYPES.find((t) => t.key === account.type);
  const isLiability = account.type === 'credit' || account.type === 'payable';
  const active = !!account.is_active;
  const isInvestment = account.type === 'investment';
  // 投资账户总资产 = 现金(balance) + 持仓市值；其它账户即 balance
  const displayBalance = isInvestment && holding ? account.balance + holding.marketValue : account.balance;
  return (
    <Card className={`p-4 ${!active ? 'opacity-60' : ''}`}>
      {/* 头部：左侧名称占满可缩空间并截断，右侧操作按钮不收缩、不换行——
          否则窄列下「银行卡」会被逐字竖排、「合并/编辑/删除」被挤断行 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-2xl">{account.icon || meta?.icon || '💳'}</span>
          <div className="min-w-0">
            <div className="truncate font-medium" title={account.name}>{account.name}</div>
            <div className="truncate text-xs text-muted">{meta?.label ?? account.type}{!active && ' · 已停用'}</div>
          </div>
        </div>
        {(onEdit || onDelete || onMerge) && (
          <div className="flex shrink-0 items-center gap-0.5 whitespace-nowrap">
            {onMerge && (
              <button
                onClick={onMerge}
                className="rounded px-1.5 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5"
                title="合并入其它账户"
              >
                合并
              </button>
            )}
            {onEdit && (
              <button
                onClick={onEdit}
                className="rounded px-1.5 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5"
              >
                编辑
              </button>
            )}
            {onDelete && (
              <button
                onClick={onDelete}
                className="rounded px-1.5 py-0.5 text-xs text-[var(--color-danger)] hover:bg-black/5 dark:hover:bg-white/5"
              >
                删除
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-3 text-lg font-bold" style={{ color: isLiability && account.balance > 0 ? '#EF4444' : 'var(--fg)' }}>
        {formatMoney(isLiability ? -displayBalance : displayBalance)}
      </div>
      {isInvestment && holding && (
        <div className="mt-2 space-y-1 text-xs text-muted">
          <div className="flex justify-between">
            <span>现金</span><span>{formatMoney(account.balance)}</span>
          </div>
          <div className="flex justify-between">
            <span>持仓市值</span><span>{formatMoney(holding.marketValue)}</span>
          </div>
          <div className="flex justify-between">
            <span>持仓盈亏</span>
            <span className="font-semibold" style={{ color: holding.profit >= 0 ? '#10B981' : '#EF4444' }}>
              {holding.profit >= 0 ? '+' : ''}{formatMoney(holding.profit)}
            </span>
          </div>
        </div>
      )}
      {isInvestment && onHoldings && (
        <button
          onClick={onHoldings}
          className="mt-3 w-full rounded-lg bg-[var(--color-primary)]/10 py-1.5 text-xs font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary)]/20"
        >
          持仓 · 市值管理
        </button>
      )}
      {onToggle && (
        <button
          onClick={onToggle}
          className="mt-3 w-full rounded-lg border border-[var(--border)] py-1 text-xs text-muted hover:bg-black/5 dark:hover:bg-white/5"
        >
          {active ? '停用账户' : '启用账户'}
        </button>
      )}
    </Card>
  );
}