import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { IconPicker } from '@/components/ui/icon-picker';
import { ACCOUNT_TYPES } from '@/lib/constants';
import { useAccountMutations } from '@/hooks/useAccounts';
import type { Account } from '@/api/accounts';

const TYPE_OPTIONS: SelectOption[] = ACCOUNT_TYPES.map((t) => ({
  value: t.key, label: t.label, icon: t.icon,
}));

interface FormData {
  name: string;
  type: string;
  initialBalance: string;
  icon: string;
  color: string;
  note: string;
}

export default function AccountForm({ open, onOpenChange, editTarget }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  editTarget?: Account | null;
}) {
  const { create, update } = useAccountMutations();
  const isEditing = !!editTarget;
  const { register, handleSubmit, setValue, watch, reset } = useForm<FormData>({
    defaultValues: {
      name: editTarget?.name ?? '',
      type: editTarget?.type ?? 'cash',
      initialBalance: editTarget ? String(editTarget.balance) : '0',
      icon: editTarget?.icon ?? '💳',
      color: editTarget?.color ?? '#1E6FA9',
      note: editTarget?.note ?? '',
    },
  });

  // 弹窗打开或编辑目标变化时，用目标数据重建表单（防止残留上一账户的数据）
  useEffect(() => {
    if (!open) return;
    reset({
      name: editTarget?.name ?? '',
      type: editTarget?.type ?? 'cash',
      initialBalance: editTarget ? String(editTarget.balance) : '0',
      icon: editTarget?.icon ?? '💳',
      color: editTarget?.color ?? '#1E6FA9',
      note: editTarget?.note ?? '',
    });
  }, [editTarget?.id, open, reset]);

  async function onSubmit(d: FormData) {
    try {
      if (isEditing && editTarget) {
        await update.mutateAsync({
          id: editTarget.id,
          p: {
            name: d.name, type: d.type,
            // 金额：编辑态直接校正「当前余额」（后端按流水净额反推初始余额，保证重算幂等）
            balance: Number(d.initialBalance || 0),
            icon: d.icon || '💳', color: d.color || '#1E6FA9', note: d.note,
          },
        });
        toast.success('账户已更新');
      } else {
        await create.mutateAsync({
          name: d.name, type: d.type, initialBalance: Number(d.initialBalance || 0),
          icon: d.icon || '💳', color: d.color || '#1E6FA9', note: d.note,
        });
        toast.success('账户创建成功');
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(`${isEditing ? '更新' : '创建'}失败：${(e as Error).message}`);
    }
  }

  const pending = isEditing ? update.isPending : create.isPending;

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title={isEditing ? '编辑账户' : '新建账户'}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">账户名称</label>
          <Input placeholder="如：招商银行卡" required {...register('name')} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">类型</label>
          <Select<string> value={watch('type')} onChange={(v) => setValue('type', v)} options={TYPE_OPTIONS} />
          {/* 类型与别名归并提醒：避免用户创建互相包含/重复的账户 */}
          {(() => {
            const t = watch('type');
            if (t.includes('credit')) return <p className="mt-1 text-xs text-muted text-[var(--color-warning,#F59E0B)]">信用卡类会包含 花呗 / 信用 / 白条 等；如已建“花呗”“白条”等账户则无需重复创建，否则导入/匹配时会归并为同一账户。</p>;
            if (t.includes('bank')) return <p className="mt-1 text-xs text-muted text-[var(--color-warning,#F59E0B)]">银行卡类：如“招商银行卡(1055)”与“招商银行卡”会被视为同一账户，请勿重复创建。</p>;
            if (t.includes('ewallet')) return <p className="mt-1 text-xs text-muted text-[var(--color-warning,#F59E0B)]">电子钱包类：支付宝账户/支付宝余额、微信/零钱/零钱通 会归并为同一账户，请避免重复创建。</p>;
            return null;
          })()}
        </div>
        {/* 金额：新建填「初始余额」；编辑直接显示并可改「账户余额」——
            用户所说的账户金额就是界面上的当前余额，必须可改且所见即所得 */}
        <div>
          <label className="mb-1 block text-sm text-muted">{isEditing ? '账户余额' : '初始余额'}</label>
          <Input type="number" step="0.01" {...register('initialBalance')} />
          <p className="mt-1 text-xs text-muted">
            {isEditing
              ? '修改后即按此金额校正账户余额（会同步调整初始余额，不影响已记录的流水）。'
              : '该账户在开始记账前的历史余额（信用卡/花呗等负债账户通常填 0）。'}
          </p>
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
