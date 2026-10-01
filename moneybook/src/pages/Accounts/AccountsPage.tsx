import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { AccountCard } from '@/components/account/AccountCard';
import AccountForm from '@/components/account/AccountForm';
import HoldingsModal from '@/components/account/HoldingsModal';
import MergeAccountModal from '@/components/account/MergeAccountModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAccounts, useAccountMutations } from '@/hooks/useAccounts';
import { useHoldingSummaries } from '@/hooks/useHoldings';
import { getAccountTotals, zeroAccountBalance } from '@/api/accounts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_TYPES } from '@/lib/constants';
import type { Account } from '@/api/accounts';
import { recalcAccountBalances } from '@/api/transactions';

export default function AccountsPage() {
  // 账户页为账户唯一入口：总览 + 类型汇总 + 新建/编辑/删除/持仓
  const { data: accounts = [], isLoading } = useAccounts(false);
  const { remove, setActive, merge } = useAccountMutations();
  const { data: totals = [] } = useQuery({ queryKey: ['accounts', 'totals'], queryFn: getAccountTotals });
  const { data: summaries = [] } = useHoldingSummaries();
  const [onlyActive, setOnlyActive] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Account | null>(null);
  const [delTarget, setDelTarget] = useState<Account | null>(null);
  const [holdingsTarget, setHoldingsTarget] = useState<Account | null>(null);
  const [mergeFrom, setMergeFrom] = useState<Account | null>(null);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const qc = useQueryClient();

  const list = onlyActive ? accounts.filter((a) => a.is_active) : accounts;
  const typeMeta = (t: string) => ACCOUNT_TYPES.find((x) => x.key === t);
  const holdingMap = new Map(summaries.map((s) => [s.account_id, s]));
  // 待删除账户是否还有余额：有则需要「清零并删除」，避免资产凭空消失
  const delNeedsZero = !!delTarget && Math.abs(Number(delTarget.balance ?? 0)) >= 0.005;

  function handleEdit(a: Account) {
    setEditTarget(a);
    setFormOpen(true);
  }
  function handleNew() {
    setEditTarget(null);
    setFormOpen(true);
  }
  function handleClose(v: boolean) {
    setFormOpen(v);
    if (!v) setEditTarget(null);
  }
  /** 删除账户：若仍有余额，先清零（写入「账户调整」审计留痕）再删除，
   *  避免这笔钱凭空从净资产消失（用户已确认此语义）。 */
  async function confirmDelete() {
    if (!delTarget) return;
    try {
      const zeroed = await zeroAccountBalance(delTarget.id);
      await remove.mutateAsync(delTarget.id);
      toast.success(
        zeroed > 0
          ? `账户「${delTarget.name}」已清零 ¥${zeroed.toFixed(2)} 并删除（已记入审计历史）`
          : `账户「${delTarget.name}」已删除`
      );
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
    setDelTarget(null);
  }

  async function confirmMerge(fromId: number, toId: number) {
    try {
      await merge.mutateAsync({ fromId, toId });
      toast.success('账户合并完成');
    } catch (e) {
      toast.error(`合并失败：${(e as Error).message}`);
      throw e;
    }
  }

  /** 按流水重算真实账户余额：批量导入是「余额中性」的，需此动作才能让各账户余额与流水一致 */
  async function handleRecalcCredit() {
    setRecalcBusy(true);
    try {
      const changed = await recalcAccountBalances();
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      if (changed.length) {
        toast.success(
          `已重算 ${changed.length} 个账户：${changed.map((c) => `${c.name} ${c.before.toFixed(2)} → ${c.after.toFixed(2)}`).join('；')}`,
          { duration: 6000 }
        );
      } else {
        toast.success('各账户余额已与流水一致，无需调整');
      }
    } catch (e) {
      toast.error(`重算失败：${(e as Error).message}`);
    } finally {
      setRecalcBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="账户"
        description="管理你的现金、银行卡、电子钱包等账户"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={handleRecalcCredit}
              disabled={recalcBusy}
              title="按已入库流水重算各真实账户（现金/银行/电子钱包/信用/储蓄）余额（批量导入为余额中性，需此动作补齐）"
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {recalcBusy ? '重算中…' : '重算账户余额'}
            </button>
            <button onClick={handleNew} className="rounded-lg px-3 py-1.5 text-sm text-white" style={{ background: 'var(--color-primary)' }}>
              + 新建账户
            </button>
          </div>
        }
      />
      <label className="mb-4 flex w-fit items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
        仅显示启用账户
      </label>
      {!isLoading && list.length > 0 && (
        <>
          <h3 className="mb-2 font-semibold">账户一览</h3>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {list.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                holding={holdingMap.get(a.id)}
                onEdit={() => handleEdit(a)}
                onDelete={() => setDelTarget(a)}
                onMerge={() => setMergeFrom(a)}
                onToggle={() => setActive.mutate({ id: a.id, active: !a.is_active })}
                onHoldings={a.type === 'investment' ? () => setHoldingsTarget(a) : undefined}
              />
            ))}
          </div>
        </>
      )}
      {totals.length > 0 && (
        <>
          <h3 className="mb-2 font-semibold">类型汇总</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {totals.map((t) => (
              <div key={t.type} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm">
                <span className="text-muted">{typeMeta(t.type)?.icon} {typeMeta(t.type)?.label ?? t.type}</span>
                <span className="font-semibold">¥{t.total.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <AccountForm open={formOpen} onOpenChange={handleClose} editTarget={editTarget} />
      {holdingsTarget && (
        <HoldingsModal open={!!holdingsTarget} onOpenChange={(v) => { if (!v) setHoldingsTarget(null); }} account={holdingsTarget} />
      )}
      <MergeAccountModal
        open={!!mergeFrom}
        from={mergeFrom}
        accounts={accounts}
        onClose={() => setMergeFrom(null)}
        onMerge={confirmMerge}
      />
      {/* 删除确认：有余额时明确提示「先清零再删除」，并可选择改用停用保留余额 */}
      <ConfirmDialog
        open={!!delTarget}
        title={delNeedsZero ? '清零并删除账户' : '删除账户'}
        description={delNeedsZero
          ? `账户「${delTarget?.name ?? ''}」当前余额 ¥${Number(delTarget?.balance ?? 0).toFixed(2)}。`
            + '删除前会先把余额清零，并写入一条「账户调整」审计记录，以免这笔钱凭空从净资产中消失。'
            + '若你想保留这笔余额，请取消后改用「停用账户」。'
          : `确认删除账户「${delTarget?.name ?? ''}」？删除后不可恢复。若该账户存在关联交易、借贷或储蓄记录，将无法删除。`}
        confirmText={delNeedsZero ? '清零并删除' : '删除'}
        danger
        onConfirm={confirmDelete}
        onClose={() => setDelTarget(null)}
      />
    </div>
  );
}