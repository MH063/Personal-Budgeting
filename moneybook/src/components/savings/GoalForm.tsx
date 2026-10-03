import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { IconPicker } from '@/components/ui/icon-picker';
import { AccountPicker } from '@/components/transaction/AccountPicker';
import { useAccounts } from '@/hooks/useAccounts';
import { useGoalMutations } from '@/hooks/useSavings';
import type { SavingsGoal } from '@/api/savings';

interface FormData {
  name: string;
  targetAmount: string;
  accountIds: number[];
  targetDate: string;
  icon: string;
  color: string;
  autoMonthly: string;
  autoAccountId?: number;
  autoDay: string;
  note: string;
}

export default function GoalForm({ open, onOpenChange, editTarget }: {
  open: boolean; onOpenChange: (v: boolean) => void; editTarget?: SavingsGoal | null;
}) {
  const { create, update } = useGoalMutations();
  const { data: allAccounts = [] } = useAccounts(true);
  const isEditing = !!editTarget;
  const { register, handleSubmit, setValue, watch, reset, formState } = useForm<FormData>({
    defaultValues: {
      name: '', targetAmount: '', accountIds: [], targetDate: dayjs().add(6, 'month').format('YYYY-MM-DD'),
      icon: '🎯', color: '#10B981', autoMonthly: '', autoDay: '1', note: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      name: editTarget?.name ?? '',
      targetAmount: editTarget ? String(editTarget.target_amount) : '',
      accountIds: editTarget?.account_ids?.length ? editTarget.account_ids : (editTarget?.account_id != null ? [editTarget.account_id] : []),
      targetDate: editTarget?.target_date ?? dayjs().add(6, 'month').format('YYYY-MM-DD'),
      icon: editTarget?.icon ?? '🎯',
      color: editTarget?.color ?? '#10B981',
      autoMonthly: editTarget && editTarget.auto_monthly > 0 ? String(editTarget.auto_monthly) : '',
      autoAccountId: editTarget?.auto_account_id ?? undefined,
      autoDay: editTarget?.auto_day ? String(editTarget.auto_day) : '1',
      note: editTarget?.note ?? '',
    });
    // 仅当目标 id 变化或弹窗打开/关闭时重置表单；
    // 不依赖 editTarget 对象引用，避免查询刷新导致对象重建而覆盖用户正在输入的金额
  }, [editTarget?.id, open, reset]);

  const accounts = allAccounts.filter((a) => a.type !== 'credit' && a.is_active);
  function toggleAccount(id: number) {
    const cur = watch('accountIds') || [];
    setValue('accountIds', cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], { shouldValidate: true });
  }

  async function onSubmit(d: FormData) {
    try {
      const autoMonthly = Number(d.autoMonthly) || 0;
      if (autoMonthly > 0 && !d.autoAccountId) { toast.error('启用自动计提请选择资金来源账户'); return; }
      const payload = {
        name: d.name, targetAmount: Number(d.targetAmount),
        accountIds: d.accountIds || [],
        targetDate: d.targetDate, icon: d.icon || '🎯', color: d.color || '#10B981',
        autoMonthly, autoAccountId: autoMonthly > 0 ? d.autoAccountId! : null, autoDay: Number(d.autoDay) || 1,
        note: d.note,
      };
      if (isEditing && editTarget) {
        await update.mutateAsync({ id: editTarget.id, p: payload });
        toast.success('储蓄目标已更新');
      } else {
        await create.mutateAsync(payload);
        toast.success('储蓄目标已创建');
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(`${isEditing ? '更新' : '创建'}失败：${(e as Error).message}`);
    }
  }

  const pending = isEditing ? update.isPending : create.isPending;

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title={isEditing ? '编辑储蓄目标' : '新建储蓄目标'} guard={{
      // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
      dirty: formState.isDirty,
      // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
      onSave: () => { void handleSubmit(onSubmit)(); },
    }}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">目标名称</label>
          <Input placeholder="如：欧洲旅行基金" required {...register('name')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">目标金额</label>
          <Input type="number" step="0.01" min="1" placeholder={isEditing ? '' : '10000'} required {...register('targetAmount')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">归集账户（可多选，存入资金转入所选账户）</label>
          {accounts.length === 0 ? (
            <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-muted">暂无可选账户</div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {accounts.map((a) => {
                const checked = (watch('accountIds') || []).includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAccount(a.id)}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${checked ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--border)]'}`}
                  >
                    <span className={`h-4 w-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${checked ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'border-[var(--border)] text-transparent'}`}>✓</span>
                    <span className="truncate">{a.icon} {a.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">目标日期（可选）</label>
          <Input type="date" {...register('targetDate')} />
        </div>
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium">每月自动计提</label>
            <span className="text-[11px] text-muted">到设定日自动从来源账户转入</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted">每月计提金额</label>
              <Input type="number" step="0.01" min="0" placeholder="0（填 0 关闭）" {...register('autoMonthly')} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">每月第几天（1-31）</label>
              <Input type="number" step="1" min="1" max="31" placeholder="1" {...register('autoDay')} />
            </div>
          </div>
          {Number(watch('autoMonthly')) > 0 || (isEditing && editTarget?.auto_account_id != null) ? (
            <div>
              <label className="mb-1 block text-xs text-muted">{isEditing && Number(watch('autoMonthly')) === 0 ? '资金来源账户（可留空表示清除，已停用自动计提）' : '资金来源账户'}</label>
              <AccountPicker excludeCredit value={watch('autoAccountId')} onChange={(id) => setValue('autoAccountId', id)} />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted">图标</label>
            <IconPicker value={watch('icon')} onChange={(v) => setValue('icon', v)} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">颜色</label>
            <input type="color" {...register('color')} className="h-9 w-full rounded-lg border border-[var(--border)]" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">备注</label>
          <Textarea rows={2} {...register('note')} />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? '保存中…' : isEditing ? '保存' : '创建'}
        </Button>
      </form>
    </Modal>
  );
}