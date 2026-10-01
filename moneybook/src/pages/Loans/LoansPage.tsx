import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { LoanCard } from '@/components/loan/LoanCard';
import LoanForm from '@/components/loan/LoanForm';
import RepaymentForm from '@/components/loan/RepaymentForm';
import OverdueInterestForm from '@/components/loan/OverdueInterestForm';
import { LoanGantt } from '@/components/loan/LoanGantt';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { useLoans, useLoanMutations } from '@/hooks/useLoans';
import { EmptyState } from '@/components/common/EmptyState';
import { formatMoney } from '@/lib/format';
import { calcLoanInterest, type Loan } from '@/api/loans';

export default function LoansPage() {
  const { data: loans = [], isLoading } = useLoans();
  const { remove, settle, unSettle } = useLoanMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [editLoan, setEditLoan] = useState<Loan | null>(null);
  const [repayLoan, setRepayLoan] = useState<Loan | null>(null);
  const [overdueRepayLoan, setOverdueRepayLoan] = useState<Loan | null>(null);
  const [ganttLoan, setGanttLoan] = useState<Loan | null>(null);
  const [delTarget, setDelTarget] = useState<Loan | null>(null);
  const [settleTarget, setSettleTarget] = useState<Loan | null>(null);
  const [unsettleTarget, setUnsettleTarget] = useState<Loan | null>(null);
  // 批量管理：勾选多条借贷后一次性删除（删除同样进回收站，可恢复）
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const totalLend = loans.filter((l) => l.direction === 'lend').reduce((s, l) => s + l.remaining, 0);
  const totalBorrow = loans.filter((l) => l.direction === 'borrow').reduce((s, l) => s + l.remaining, 0);
  const totalLendInt = loans.filter((l) => l.direction === 'lend').reduce((s, l) => s + calcLoanInterest(l), 0);
  const totalBorrowInt = loans.filter((l) => l.direction === 'borrow').reduce((s, l) => s + calcLoanInterest(l), 0);
  const overdueLendInt = loans.filter((l) => l.direction === 'lend' && l.status === 'overdue').reduce((s, l) => s + (Number(l.accrued_interest) || 0), 0);
  const overdueBorrowInt = loans.filter((l) => l.direction === 'borrow' && l.status === 'overdue').reduce((s, l) => s + (Number(l.accrued_interest) || 0), 0);

  async function confirmDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast.success('借贷记录已删除');
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
    setDelTarget(null);
  }

  /** 勾选/取消单条借贷（批量管理模式下点击卡片触发） */
  const toggleId = (id: number) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /** 批量删除：顺序逐条删除（每条含关联交易/还款清理与余额补偿，串行执行更稳） */
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
    if (fail === 0) toast.success(`已删除 ${ok} 条借贷记录`);
    else toast.warning(`已删除 ${ok} 条，${fail} 条删除失败，请重试`);
  }

  async function confirmSettle() {
    if (!settleTarget) return;
    try {
      await settle.mutateAsync(settleTarget.id);
      toast.success(settleTarget.remaining > 0.0001 ? '已结清剩余金额并标记为已结清' : '借贷已结清');
    } catch (e) {
      toast.error(`结清失败：${(e as Error).message}`);
    }
    setSettleTarget(null);
  }

  async function confirmUnsettle() {
    if (!unsettleTarget) return;
    try {
      await unSettle.mutateAsync(unsettleTarget.id);
      toast.success('已恢复为进行中');
    } catch (e) {
      toast.error(`恢复失败：${(e as Error).message}`);
    }
    setUnsettleTarget(null);
  }

  return (
    <div>
      <PageHeader
        title="借贷"
        description="管理借出与借入"
        action={<button onClick={() => { setEditLoan(null); setFormOpen(true); }} className="rounded-lg px-3 py-1.5 text-sm text-white" style={{ background: 'var(--color-primary)' }}>+ 建立借贷</button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="text-sm text-muted">待收回（应收）</div>
          <div className="mt-1 text-xl font-bold" style={{ color: '#F59E0B' }}>{formatMoney(totalLend)}</div>
          {totalLendInt > 0 && <div className="mt-1 text-xs text-muted">预计利息 +{formatMoney(totalLendInt)}</div>}
          {overdueLendInt > 0 && <div className="mt-1 text-xs" style={{ color: '#EF4444' }}>其中逾期应计利息 +{formatMoney(overdueLendInt)}</div>}
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="text-sm text-muted">待偿还（应付）</div>
          <div className="mt-1 text-xl font-bold" style={{ color: '#3B82F6' }}>{formatMoney(totalBorrow)}</div>
          {totalBorrowInt > 0 && <div className="mt-1 text-xs text-muted">预计利息 +{formatMoney(totalBorrowInt)}</div>}
          {overdueBorrowInt > 0 && <div className="mt-1 text-xs" style={{ color: '#EF4444' }}>其中逾期应计利息 +{formatMoney(overdueBorrowInt)}</div>}
        </div>
      </div>
      {/* 批量管理条：勾选多条借贷后一次删除 */}
      {!isLoading && loans.length > 1 && (
        <div className="mb-3 flex items-center justify-end gap-2">
          {manageMode ? (
            <>
              <span className="text-sm text-muted">已选 {selectedIds.length} 条</span>
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
      {!isLoading && loans.length === 0 ? (
        <EmptyState icon="🤝" text="暂无借贷记录" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {loans.map((l) => {
            const sel = selectedIds.includes(l.id);
            return (
              <div
                key={l.id}
                onClick={manageMode ? () => toggleId(l.id) : undefined}
                className={`relative rounded-xl transition ${manageMode ? 'cursor-pointer [&_button]:pointer-events-none' : ''} ${sel ? 'ring-2 ring-[var(--color-primary)]' : ''}`}
              >
                {manageMode && (
                  <span
                    className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded border text-xs ${
                      sel ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--border)] bg-[var(--card)] text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                )}
                <LoanCard
                  key={l.id}
                  loan={l}
                  onRepay={setRepayLoan}
                  onRepayOverdue={setOverdueRepayLoan}
                  onSettle={setSettleTarget}
                  onUnsettle={setUnsettleTarget}
                  onGantt={setGanttLoan}
                  onEdit={(ln) => { setEditLoan(ln); setFormOpen(true); }}
                  onDelete={setDelTarget}
                />
              </div>
            );
          })}
        </div>
      )}
      <LoanForm open={formOpen} onOpenChange={(v) => { setFormOpen(v); if (!v) setEditLoan(null); }} editTarget={editLoan} />
      <RepaymentForm loan={repayLoan} open={!!repayLoan} onOpenChange={(v) => { if (!v) setRepayLoan(null); }} />
      <OverdueInterestForm loan={overdueRepayLoan} open={!!overdueRepayLoan} onOpenChange={(v) => { if (!v) setOverdueRepayLoan(null); }} />
      <LoanGantt loan={ganttLoan} open={!!ganttLoan} onOpenChange={(v) => { if (!v) setGanttLoan(null); }} />
      <ConfirmDialog
        open={!!delTarget}
        title="删除借贷"
        description={`确认删除「${delTarget?.counterparty ?? ''}」的借贷记录？将同时删除其关联的还款与交易记录，且不可恢复。`}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDelTarget(null)}
      />
      <ConfirmDialog
        open={!!settleTarget}
        title="结清借贷"
        description={settleTarget && settleTarget.remaining > 0.0001
          ? `「${settleTarget.counterparty}」还有 ¥${settleTarget.remaining.toFixed(2)} 未结清。结清将自动按剩余金额记录一笔还款并标记为「已结清」，是否继续？`
          : `确认将「${settleTarget?.counterparty ?? ''}」标记为「已结清」？`}
        confirmText="结清"
        onConfirm={confirmSettle}
        onClose={() => setSettleTarget(null)}
      />
      <ConfirmDialog
        open={!!unsettleTarget}
        title="恢复进行中"
        description={`确认将「${unsettleTarget?.counterparty ?? ''}」恢复为进行中？其已结清状态将被撤销，历史还款记录保留。`}
        confirmText="恢复"
        onConfirm={confirmUnsettle}
        onClose={() => setUnsettleTarget(null)}
      />
      {/* 批量删除二次确认：明示关联清理范围与回收站可恢复 */}
      <ConfirmDialog
        open={batchOpen}
        title="批量删除借贷"
        description={`确认删除选中的 ${selectedIds.length} 条借贷记录？将同时删除各自的关联还款与交易记录，删除后可在「回收站」中恢复。`}
        confirmText={`删除 ${selectedIds.length} 条`}
        danger
        onConfirm={() => void confirmBatchDelete()}
        onClose={() => setBatchOpen(false)}
      />
    </div>
  );
}