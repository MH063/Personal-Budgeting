import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AccountPicker } from '@/components/transaction/AccountPicker';
import { useLoanMutations } from '@/hooks/useLoans';
import { getLoanRemainingInterest, getLoanNextDue } from '@/api/loans';
import { formatMoney } from '@/lib/format';
import type { Loan } from '@/api/loans';

const round2 = (x: number): number => Number(x.toFixed(2));

export default function RepaymentForm({ loan, open, onOpenChange }: {
  loan: Loan | null; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const { repay } = useLoanMutations();
  const [accountId, setAccountId] = useState<number | undefined>();
  const { register, handleSubmit, setValue, watch, reset, formState } = useForm<{ amount: string; interest: string; date: string; note: string }>({
    defaultValues: { amount: '', interest: '', date: dayjs().format('YYYY-MM-DD'), note: '' },
  });

  // 建议利息 = 预计总利息 - 已记账利息（实时取，覆盖已部分/全额还过息的情况）
  const { data: remainingInterest = 0 } = useQuery({
    queryKey: ['loanRemainingInterest', loan?.id, open],
    queryFn: () => (loan ? getLoanRemainingInterest(loan) : Promise.resolve(0)),
    enabled: !!loan && open,
  });
  // 下一期应还（期次化还款一键填充依据）
  const { data: nextDue } = useQuery({
    queryKey: ['loanNextDue', loan?.id, open],
    queryFn: () => (loan ? getLoanNextDue(loan) : Promise.resolve(null)),
    enabled: !!loan && open,
    refetchInterval: 0,
  });

  const isInstallment = !!loan && loan.periods != null && loan.periods > 0 && loan.method !== 'balloon';

  // loan 变化或弹窗打开时重置表单；默认"一次性还清本息"
  useEffect(() => {
    if (open && loan) {
      const sugg = round2(Number(remainingInterest));
      // 期次化还款：默认填"本期应还"（若不超余额）；其余默认还清剩余本息
      let amount = round2(loan.remaining + sugg);
      let interest = sugg;
      if (isInstallment && nextDue && nextDue.period > 0) {
        amount = round2(nextDue.payment);
        interest = round2(nextDue.interest);
        if (amount > loan.remaining + sugg + 0.01) { amount = round2(loan.remaining + sugg); interest = sugg; }
      }
      reset({
        amount: amount > 0 ? String(amount) : '',
        interest: interest > 0 ? String(interest) : '',
        date: dayjs().format('YYYY-MM-DD'),
        note: '',
      });
      setAccountId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan?.id, open, reset, remainingInterest, nextDue]);

  if (!loan) return null;

  const amountVal = Number(watch('amount')) || 0;
  const interestVal = Number(watch('interest')) || 0;
  const principalVal = Math.max(0, round2(amountVal - interestVal));

  const fillThisPeriod = () => {
    if (!nextDue || nextDue.period <= 0) { toast.info('当前无可用的"本期应还"'); return; }
    setValue('amount', String(round2(nextDue.payment)));
    setValue('interest', String(round2(nextDue.interest)), { shouldValidate: true });
  };
  const fillAll = () => {
    const sugg = round2(Number(remainingInterest));
    setValue('amount', String(round2(loan.remaining + sugg) > 0 ? round2(loan.remaining + sugg) : 0));
    setValue('interest', sugg > 0 ? String(sugg) : '', { shouldValidate: true });
  };

  async function onSubmit(d: { amount: string; interest: string; date: string; note: string }) {
    try {
      if (!accountId) { toast.error('请选择账户'); return; }
      const interest = Number(d.interest) || 0;
      if (interest > Number(d.amount) + 0.0001) { toast.error('利息不能大于还款总金额'); return; }
      await repay.mutateAsync({
        id: loan!.id,
        p: { amount: Number(d.amount), interest, period: nextDue?.period && nextDue.period > 0 ? nextDue.period : null, accountId, date: d.date, note: d.note },
      });
      toast.success('还款成功');
      onOpenChange(false);
    } catch (e) {
      toast.error(`还款失败：${(e as Error).message}`);
    }
  }

  const suggestHint = nextDue && nextDue.period > 0
    ? `本期应还（第 ${nextDue.period} 期）：本金 ${formatMoney(nextDue.principal)} + 利息 ${formatMoney(nextDue.interest)} = ${formatMoney(nextDue.payment)}`
    : null;

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title={`向 ${loan.counterparty} 还款`} guard={{
      // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
      dirty: formState.isDirty,
      // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
      onSave: () => { void handleSubmit(onSubmit)(); },
    }}>
      <div className="mb-3 rounded-lg bg-black/5 p-3 text-sm dark:bg-white/5">
        剩余待还本金：<strong>¥{loan.remaining.toFixed(2)}</strong>（{loan.direction === 'lend' ? '借出待收' : '借入待还'}）
        建议剩余利息：<strong style={{ color: '#F59E0B' }}>¥{remainingInterest.toFixed(2)}</strong>
        {suggestHint && <div className="mt-1 text-xs text-muted">{suggestHint}</div>}
      </div>
      {isInstallment && nextDue && nextDue.period > 0 && (
        <div className="mb-3 flex gap-2">
          <Button type="button" size="sm" variant="outline" className="flex-1" onClick={fillThisPeriod}>本期应还（第 {nextDue.period} 期）</Button>
          {loan.remaining + Number(remainingInterest) > nextDue.payment + 0.01 && (
            <Button type="button" size="sm" variant="ghost" className="flex-1" onClick={fillAll}>还清全部本息</Button>
          )}
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">还款总金额</label>
          <Input type="number" step="0.01" min="0.01" placeholder="本金+利息" required {...register('amount')} />
          <p className="mt-1 text-[11px] text-muted">本金 + 利息的合计实付金额；可随需调整。</p>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">其中利息（{loan.direction === 'lend' ? '计为收入' : '计为支出'}）</label>
          <Input type="number" step="0.01" min="0" placeholder="0" {...register('interest')} onChange={(e) => { setValue('interest', e.target.value, { shouldValidate: true }); }} />
          <p className="mt-1 text-[11px] text-muted">建议值按已记账利息自动计算；本金部分仅冲抵剩余，不计入收支。</p>
        </div>
        {amountVal > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
            <div>
              <div className="text-muted">本金（冲抵剩余）</div>
              <div style={{ color: '#10B981' }}>{formatMoney(principalVal)}</div>
            </div>
            <div className="text-center">
              <div className="text-muted">利息（收支）</div>
              <div style={{ color: '#F59E0B' }}>{formatMoney(interestVal)}</div>
            </div>
            <div className="text-right">
              <div className="text-muted">还款后剩余</div>
              <div>{formatMoney(Math.max(0, loan.remaining - principalVal))}</div>
            </div>
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm text-muted">资金账户</label>
          <AccountPicker excludeCredit value={accountId} onChange={setAccountId} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">日期</label>
          <Input type="date" {...register('date')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">备注</label>
          <Input placeholder="备注（可选）" {...register('note')} />
        </div>
        <Button type="submit" className="w-full" disabled={repay.isPending}>确认还款</Button>
      </form>
    </Modal>
  );
}