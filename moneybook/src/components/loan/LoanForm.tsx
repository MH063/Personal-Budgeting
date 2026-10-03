import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { AccountPicker } from '@/components/transaction/AccountPicker';
import { useLoanMutations } from '@/hooks/useLoans';
import { Switch } from '@/components/ui/switch';
import type { Loan, LoanMethod } from '@/api/loans';

interface FormData {
  direction: string;
  counterparty: string;
  principal: string;
  accountId?: number;
  date: string;
  dueDate: string;
  rate: string;
  periods: string;
  compound: boolean;
  method: LoanMethod;
  firstRepayDate: string;
  repayDay: string;
  note: string;
}

const DIR_OPTIONS: SelectOption[] = [
  { value: 'lend', label: '借出（我借钱给别人）', color: '#F59E0B' },
  { value: 'borrow', label: '借入（我从别人借钱）', color: '#3B82F6' },
];

const METHOD_OPTIONS: SelectOption[] = [
  { value: 'balloon', label: '到期一次还本付息', color: '#8B5CF6' },
  { value: 'equal_principal', label: '等额本金', color: '#3B82F6' },
  { value: 'equal_payment', label: '等额本息', color: '#10B981' },
];

export default function LoanForm({ open, onOpenChange, editTarget }: {
  open: boolean; onOpenChange: (v: boolean) => void; editTarget?: Loan | null;
}) {
  const { create, update } = useLoanMutations();
  const isEditing = !!editTarget;
  const { register, handleSubmit, watch, setValue, reset, formState } = useForm<FormData>({
    defaultValues: {
      direction: 'lend', counterparty: '', principal: '', date: dayjs().format('YYYY-MM-DD'), dueDate: '',
      rate: '0', periods: '', compound: false, method: 'balloon', firstRepayDate: '', repayDay: '', note: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      direction: editTarget?.direction ?? 'lend',
      counterparty: editTarget?.counterparty ?? '',
      principal: editTarget ? String(editTarget.principal) : '',
      accountId: editTarget?.account_id ?? undefined,
      date: editTarget?.date ?? dayjs().format('YYYY-MM-DD'),
      dueDate: editTarget?.due_date ?? '',
      rate: editTarget ? String(Number(editTarget.rate) || 0) : '0',
      periods: editTarget?.periods ? String(editTarget.periods) : '',
      compound: Number(editTarget?.compound) === 1,
      method: editTarget?.method ?? 'balloon',
      firstRepayDate: editTarget?.first_repay_date ?? '',
      repayDay: editTarget?.repay_day ? String(editTarget.repay_day) : '',
      note: editTarget?.note ?? '',
    });
  }, [editTarget?.id, open, reset]);

  async function onSubmit(d: FormData) {
    try {
      const method: LoanMethod = d.method ?? 'balloon';
      if (isEditing && editTarget) {
        await update.mutateAsync({
          id: editTarget.id,
          p: {
            counterparty: d.counterparty, date: d.date, dueDate: d.dueDate || null, rate: Number(d.rate) || 0,
            periods: d.periods ? Number(d.periods) : null, compound: d.compound, method,
            firstRepayDate: d.firstRepayDate || null,
            repayDay: d.repayDay ? Number(d.repayDay) : null,
            note: d.note,
          },
        });
        toast.success('借贷信息已更新');
      } else {
        if (!d.accountId) { toast.error('请选择账户'); return; }
        await create.mutateAsync({
          direction: d.direction as 'lend' | 'borrow',
          counterparty: d.counterparty,
          principal: Number(d.principal),
          accountId: d.accountId,
          date: d.date,
          dueDate: d.dueDate || undefined,
          rate: Number(d.rate) || 0,
          periods: d.periods ? Number(d.periods) : undefined,
          compound: d.compound,
          method,
          firstRepayDate: d.firstRepayDate || null,
          repayDay: d.repayDay ? Number(d.repayDay) : null,
          note: d.note,
        });
        toast.success('借贷记录已建立');
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(isEditing ? `更新失败：${(e as Error).message}` : `失败：${(e as Error).message}`);
    }
  }

  const pending = isEditing ? update.isPending : create.isPending;

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title={isEditing ? '编辑借贷' : '建立借贷'} guard={{
      // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
      dirty: formState.isDirty,
      // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
      onSave: () => { void handleSubmit(onSubmit)(); },
    }}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">类型</label>
          {isEditing ? (
            <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
              {DIR_OPTIONS.find((o) => o.value === watch('direction'))?.label}（不可修改）
            </div>
          ) : (
            <Select<string> value={watch('direction')} onChange={(v) => setValue('direction', v)} options={DIR_OPTIONS} />
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">对方</label>
          <Input placeholder="姓名 / 机构" required {...register('counterparty')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">金额</label>
          {isEditing ? (
            <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-muted">
              {Number(watch('principal') || 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}（初始金额不可修改）
            </div>
          ) : (
            <Input type="number" step="0.01" min="0.01" placeholder="0.00" required {...register('principal')} />
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">资金账户</label>
          {isEditing ? (
            <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-muted">关联账户（金额不可改，账户不变）</div>
          ) : (
            <AccountPicker excludeCredit value={watch('accountId')} onChange={(id) => setValue('accountId', id)} />
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">日期</label>
          <Input type="date" {...register('date')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">约定还款日（可选）</label>
          <Input type="date" {...register('dueDate')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted">年利率（%，可选）</label>
            <Input type="number" step="0.01" min="0" placeholder="如 6" {...register('rate')} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">期数（期，可选）</label>
            <Input type="number" step="1" min="1" placeholder="如 12" {...register('periods')} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted">还款方式</label>
            <Select<string> value={watch('method')} onChange={(v) => setValue('method', v as LoanMethod)} options={METHOD_OPTIONS} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">计息方式</label>
            <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] px-3">
              <Switch checked={watch('compound')} onChange={(v) => setValue('compound', v)} />
              <span className="text-sm">{watch('compound') ? '复利' : '单利'}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted">开始还款日期（可选）</label>
            <Input type="date" {...register('firstRepayDate')} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">固定还款日（每月几号）</label>
            <Input type="number" step="1" min="1" max="31" placeholder="如 5" {...register('repayDay')} />
          </div>
        </div>
        <p className="text-xs text-muted">
          {watch('method') === 'balloon'
            ? '到期一次还本付息：利息 = 本金 × 年利率 × 计息天数 ÷ 365（复利按月滚动）。计息天数为放款日至到期/开始还款日（都未填则至今）。'
            : `${watch('method') === 'equal_principal' ? '等额本金：每期本金相等，利息随余额递减' : '等额本息：每期还款总额相等'}。期数为还款期次，日利率按年利率÷12 折算，基于剩余本金计息。`}
        </p>
        <div>
          <label className="mb-1 block text-sm text-muted">备注</label>
          <Textarea rows={2} {...register('note')} />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? '保存中…' : isEditing ? '保存' : '保存'}
        </Button>
      </form>
    </Modal>
  );
}