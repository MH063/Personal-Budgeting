import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AccountPicker } from '@/components/transaction/AccountPicker';
import { useLoanMutations } from '@/hooks/useLoans';
import { formatMoney } from '@/lib/format';
import type { Loan } from '@/api/loans';

/** 单独偿还已累计的逾期利息（独立条目，与本金分开回收）。 */
export default function OverdueInterestForm({ loan, open, onOpenChange }: {
  loan: Loan | null; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const { repayOverdue } = useLoanMutations();
  const [accountId, setAccountId] = useState<number | undefined>();
  const { register, handleSubmit, reset, formState } = useForm<{ amount: string; date: string }>({
    defaultValues: { amount: '', date: dayjs().format('YYYY-MM-DD') },
  });
  useEffect(() => {
    if (open && loan) {
      reset({ amount: String(Number(loan.accrued_interest) || 0), date: dayjs().format('YYYY-MM-DD') });
      setAccountId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan?.id, open, reset]);

  if (!loan) return null;
  const accrued = Number(loan.accrued_interest) || 0;
  const dirLabel = loan.direction === 'lend' ? '利息收入(收回)' : '利息支出(付出)';

  async function onSubmit(d: { amount: string; date: string }) {
    try {
      if (!accountId) { toast.error('请选择资金账户'); return; }
      const amount = Number(d.amount);
      if (!amount || amount <= 0) { toast.error('请输入偿还金额'); return; }
      await repayOverdue.mutateAsync({ id: loan!.id, p: { amount, accountId, date: d.date } });
      toast.success('逾期利息已单独偿还');
      onOpenChange(false);
    } catch (e) {
      toast.error(`操作失败：${(e as Error).message}`);
    }
  }

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title={`单独偿还逾期利息 · ${loan.counterparty}`} guard={{
      // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
      dirty: formState.isDirty,
      // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
      onSave: () => { void handleSubmit(onSubmit)(); },
    }}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="rounded-lg bg-[var(--color-danger)]/10 px-3 py-2 text-sm">
          <div className="flex justify-between text-muted">
            <span>已累计逾期利息</span>
            <span className="font-semibold" style={{ color: 'var(--color-danger)' }}>{formatMoney(accrued)}</span>
          </div>
          <div className="mt-1 text-xs text-muted">本次只冲减逾期利息，不影响剩余待还本金。</div>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">偿还金额</label>
          <Input type="number" step="0.01" min="0.01" max={accrued} required {...register('amount')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">资金账户</label>
          <AccountPicker excludeCredit value={accountId} onChange={setAccountId} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">日期</label>
          <Input type="date" {...register('date')} />
        </div>
        <div className="text-xs text-muted">该笔将计为{dirLabel}，并相应减少已累计的逾期利息。</div>
        <Button type="submit" className="w-full" disabled={repayOverdue.isPending}>确认偿还</Button>
      </form>
    </Modal>
  );
}