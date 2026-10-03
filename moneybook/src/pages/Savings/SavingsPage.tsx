import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { PageHeader } from '@/components/common/PageHeader';
import { GoalCard } from '@/components/savings/GoalCard';
import GoalForm from '@/components/savings/GoalForm';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AccountPicker } from '@/components/transaction/AccountPicker';
import { useAccounts } from '@/hooks/useAccounts';
import { useGoals } from '@/hooks/useSavings';
import { useGoalMutations } from '@/hooks/useSavings';
import { EmptyState } from '@/components/common/EmptyState';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { SavingsGoal } from '@/api/savings';
import { formatMoney } from '@/lib/format';

export default function SavingsPage() {
  const { data: goals = [], isLoading } = useGoals();
  const { data: allAccounts = [] } = useAccounts(true);
  const { deposit, withdraw, remove } = useGoalMutations();
  const acctName = (id: number) => allAccounts.find((a) => a.id === id)?.name ?? `账户#${id}`;
  const [formOpen, setFormOpen] = useState(false);
  const [editGoal, setEditGoal] = useState<SavingsGoal | null>(null);
  const [depositGoal, setDepositGoal] = useState<SavingsGoal | null>(null);
  const [delTarget, setDelTarget] = useState<SavingsGoal | null>(null);
  // 批量管理：勾选多个目标后一次性删除（卡片少时也保留单条删除）
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [accountId, setAccountId] = useState<number | undefined>();
  const [toAccountId, setToAccountId] = useState<number | undefined>();
  const { register, handleSubmit, reset, formState } = useForm<{ amount: string }>({ defaultValues: { amount: '' } });
  const [withdrawGoal, setWithdrawGoal] = useState<SavingsGoal | null>(null);
  const [withdrawToId, setWithdrawToId] = useState<number | undefined>();
  const { register: wRegister, handleSubmit: wHandleSubmit, reset: wReset, formState: wFormState } = useForm<{ amount: string }>({ defaultValues: { amount: '' } });
  // 目标归集账户集（来源从首个归集账户转出）
  const poolOf = (g: SavingsGoal) => (g.account_ids?.length ? g.account_ids : (g.account_id != null ? [g.account_id] : []));
  const withdrawPool = withdrawGoal ? poolOf(withdrawGoal) : [];

  async function confirmDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast.success(`目标「${delTarget.name}」已删除`);
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
    setDelTarget(null);
  }

  /** 勾选/取消单个目标（批量管理模式下点击卡片触发） */
  const toggleId = (id: number) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /** 批量删除：顺序逐个删除（SQLite 写操作串行更稳），完成后退出批量并清空选择 */
  async function confirmBatchDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBatchBusy(true);
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        await remove.mutateAsync(id);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBatchBusy(false);
    setSelectedIds([]);
    setManageMode(false);
    if (fail === 0) toast.success(`已删除 ${ok} 个储蓄目标`);
    else toast.warning(`已删除 ${ok} 个，${fail} 个删除失败，请重试`);
  }

  async function onDeposit(d: { amount: string }) {
    if (!depositGoal) return;
    try {
      if (!accountId) { toast.error('请选择来源账户'); return; }
      await deposit.mutateAsync({ id: depositGoal.id, p: { amount: Number(d.amount), accountId, toAccountId, date: dayjs().format('YYYY-MM-DD') } });
      toast.success('已存入目标');
      setDepositGoal(null);
      setToAccountId(undefined);
      reset();
    } catch (e) {
      toast.error(`存入失败：${(e as Error).message}`);
    }
  }

  async function onWithdraw(d: { amount: string }) {
    if (!withdrawGoal) return;
    const amount = Number(d.amount);
    if (!amount || amount <= 0) { toast.error('请输入支取金额'); return; }
    if (amount > withdrawGoal.current_amount) { toast.error('支取金额不能超过已存入进度'); return; }
    if (!withdrawPool.length) { toast.error('目标未关联归集账户'); return; }
    if (!withdrawToId) { toast.error('请选择转入账户'); return; }
    try {
      // 资金来源交由后端自动选择池中余额充足的账户，避免把单个账户扣成负余额
      await withdraw.mutateAsync({ id: withdrawGoal.id, p: { amount, toAccountId: withdrawToId, date: dayjs().format('YYYY-MM-DD') } });
      toast.success('已支取');
      setWithdrawGoal(null);
      setWithdrawToId(undefined);
      wReset();
    } catch (e) {
      toast.error(`支取失败：${(e as Error).message}`);
    }
  }

  return (
    <div>
      <PageHeader
        title="储蓄目标"
        description="设定目标并定期存入"
        action={<button onClick={() => { setEditGoal(null); setFormOpen(true); }} className="rounded-lg px-3 py-1.5 text-sm text-white" style={{ background: 'var(--color-primary)' }}>+ 新建目标</button>}
      />
      {/* 批量管理条：勾选多个目标后一次删除 */}
      {!isLoading && goals.length > 1 && (
        <div className="mb-3 flex items-center justify-end gap-2">
          {manageMode ? (
            <>
              <span className="text-sm text-muted">已选 {selectedIds.length} 个</span>
              <Button variant="danger" size="sm" disabled={!selectedIds.length || batchBusy} onClick={() => setBatchOpen(true)}>
                {batchBusy ? '删除中…' : '删除选中'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setManageMode(false); setSelectedIds([]); }}>
                退出批量
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setManageMode(true)}>批量管理</Button>
          )}
        </div>
      )}
      {!isLoading && goals.length === 0 ? (
        <EmptyState icon="🐷" text="还没有储蓄目标，点击右上角新建" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((g) => {
            const sel = selectedIds.includes(g.id);
            return (
              <div
                key={g.id}
                onClick={manageMode ? () => toggleId(g.id) : undefined}
                className={`relative rounded-xl transition ${manageMode ? 'cursor-pointer [&_button]:pointer-events-none' : ''} ${sel ? 'ring-2 ring-[var(--color-primary)]' : ''}`}
              >
                {/* 批量模式下的勾选标记（选择态由包裹层高亮 + 角标共同表达） */}
                {manageMode && (
                  <span
                    className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded border text-xs ${
                      sel ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--border)] bg-[var(--card)] text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                )}
                <GoalCard key={g.id} goal={g} onDeposit={setDepositGoal} onWithdraw={setWithdrawGoal} onEdit={(gl) => { setEditGoal(gl); setFormOpen(true); }} onDelete={setDelTarget} />
              </div>
            );
          })}
        </div>
      )}
      <GoalForm open={formOpen} onOpenChange={(v) => { setFormOpen(v); if (!v) setEditGoal(null); }} editTarget={editGoal} />
      <Modal open={!!depositGoal} onClose={() => setDepositGoal(null)} title={depositGoal ? `存入「${depositGoal.name}」` : ''} guard={{
        // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
        dirty: formState.isDirty,
        // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
        onSave: () => { void handleSubmit(onDeposit)(); },
      }}>
        <form onSubmit={handleSubmit(onDeposit)} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-muted">存入金额</label>
            <Input type="number" step="0.01" min="0.01" required placeholder="0.00" {...register('amount')} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">来源账户</label>
            <AccountPicker excludeCredit value={accountId} onChange={setAccountId} />
          </div>
          {depositGoal && (depositGoal.account_ids?.length ?? 0) > 1 && (
            <div>
              <label className="mb-1 block text-sm text-muted">归集到（目标账户）</label>
              <div className="grid grid-cols-2 gap-2">
                {(depositGoal.account_ids ?? []).map((aid) => {
                  const active = (toAccountId ?? depositGoal.account_id) === aid;
                  return (
                    <button
                      key={aid}
                      type="button"
                      onClick={() => setToAccountId(aid)}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm ${active ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--border)]'}`}
                    >
                      <span className={`h-4 w-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${active ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'border-[var(--border)] text-transparent'}`}>✓</span>
                      <span className="truncate">{acctName(aid)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={deposit.isPending}>确认存入</Button>
        </form>
      </Modal>
      <Modal open={!!withdrawGoal} onClose={() => setWithdrawGoal(null)} title={withdrawGoal ? `支取「${withdrawGoal.name}」` : ''} guard={{
        // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
        dirty: wFormState.isDirty,
        // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
        onSave: () => { void wHandleSubmit(onWithdraw)(); },
      }}>
        <form onSubmit={wHandleSubmit(onWithdraw)} className="space-y-4">
          <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm bg-black/5 dark:bg-white/5">
            <div className="flex justify-between text-muted">
              <span>当前已存</span>
              <span>{withdrawGoal ? formatMoney(withdrawGoal.current_amount) : '-'}</span>
            </div>
            <div className="mt-1 flex justify-between text-muted">
              <span>来源</span>
              <span>{withdrawPool.length ? '从归集账户自动转出（余额充足者优先）' : '-'}</span>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">支取金额（不超过已存进度）</label>
            <Input type="number" step="0.01" min="0.01" required placeholder="0.00" {...wRegister('amount')} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">转入账户</label>
            <AccountPicker excludeCredit exclude={withdrawPool} value={withdrawToId} onChange={setWithdrawToId} />
          </div>
          <Button type="submit" className="w-full" disabled={withdraw.isPending}>确认支取</Button>
        </form>
      </Modal>
      <ConfirmDialog
        open={!!delTarget}
        title="删除储蓄目标"
        description={`确认删除目标「${delTarget?.name ?? ''}」？已存入关联储蓄账户的资金会保留，不会被回收；仅移除目标跟踪记录。`}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDelTarget(null)}
      />
      {/* 批量删除二次确认 */}
      <ConfirmDialog
        open={batchOpen}
        title="批量删除储蓄目标"
        description={`确认删除选中的 ${selectedIds.length} 个储蓄目标？已存入关联储蓄账户的资金会保留，不会被回收；仅移除目标跟踪记录。`}
        confirmText={`删除 ${selectedIds.length} 个`}
        danger
        onConfirm={() => void confirmBatchDelete()}
        onClose={() => setBatchOpen(false)}
      />
    </div>
  );
}