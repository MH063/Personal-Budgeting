import { useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { useQueryClient } from '@tanstack/react-query';
import { useRecurring, useRecurringMutations } from '@/hooks/useRecurring';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { applyDueRecurring, type Recurring, type RecurringInput } from '@/api/recurring';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { AccountPicker } from '@/components/transaction/AccountPicker';
import { CategoryPicker } from '@/components/transaction/CategoryPicker';
import { DataTable } from '@/components/data-table/DataTable';
import { formatMoney, formatDate } from '@/lib/format';

const TYPE_LABEL: Record<string, string> = { income: '收入', expense: '支出', transfer: '转账' };
const TYPE_OPTIONS = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
];
const FREQ_OPTIONS = [
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
];

type RecurringType = Recurring['type'];
type RecurringFreq = Recurring['frequency'];

interface FormState {
  type: RecurringType;
  amount: string;
  categoryId: number | undefined;
  accountId: number | undefined;
  toAccountId: number | undefined;
  note: string;
  frequency: RecurringFreq;
  interval: string;
  startDate: string;
  endDate: string;
}

const emptyForm = (): FormState => ({
  type: 'expense',
  amount: '',
  categoryId: undefined,
  accountId: undefined,
  toAccountId: undefined,
  note: '',
  frequency: 'monthly',
  interval: '1',
  startDate: dayjs().format('YYYY-MM-DD'),
  endDate: '',
});

export default function RecurringManage() {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useRecurring();
  const { create, update, remove } = useRecurringMutations();
  const { data: accounts = [] } = useAccounts(true);
  const { data: expenseCats = [] } = useCategories('expense');
  const { data: incomeCats = [] } = useCategories('income');

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Recurring | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Recurring | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());

  const accountName = (id: number | null | undefined) => accounts.find((a) => a.id === id)?.name ?? '-';
  const catName = (id: number | null | undefined) => {
    const c = [...expenseCats, ...incomeCats].find((c) => c.id === id);
    return c ? `${c.icon} ${c.name}` : '';
  };

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function openAdd() {
    setEditing(null);
    setForm(emptyForm());
    setOpen(true);
  }
  function openEdit(r: Recurring) {
    setEditing(r);
    setForm({
      type: r.type,
      amount: String(r.amount),
      categoryId: r.category_id ?? undefined,
      accountId: r.account_id,
      toAccountId: r.to_account_id ?? undefined,
      note: r.note ?? '',
      frequency: r.frequency,
      interval: String(r.interval || 1),
      startDate: r.start_date,
      endDate: r.end_date ?? '',
    });
    setOpen(true);
  }

  async function onSubmit() {
    const amount = Number(form.amount);
    if (!amount || amount <= 0) { toast.error('请输入有效金额'); return; }
    if (!form.accountId) { toast.error('请选择账户'); return; }
    const payload: RecurringInput = {
      type: form.type,
      amount,
      categoryId: form.type === 'transfer' ? undefined : form.categoryId,
      accountId: form.accountId,
      toAccountId: form.type === 'transfer' ? form.toAccountId : undefined,
      note: form.note.trim(),
      frequency: form.frequency,
      interval: Number(form.interval) || 1,
      startDate: form.startDate || dayjs().format('YYYY-MM-DD'),
      endDate: form.endDate || undefined,
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, p: payload });
        toast.success('周期性记账已更新');
      } else {
        await create.mutateAsync(payload);
        toast.success('周期性记账已添加');
      }
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  }

  async function onDelete(r: Recurring) {
    // 统一用 ConfirmDialog 做危险操作确认（替换 window.confirm）
    setDeleteTarget(r);
  }
  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast.success('已删除');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
    setDeleteTarget(null);
  }

  async function onApplyDue() {
    const n = await applyDueRecurring();
    toast.success(`已生成 ${n} 笔到期交易`);
    qc.invalidateQueries({ queryKey: ['recurring'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
  }

  const showCategory = form.type !== 'transfer';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button onClick={openAdd}>新增周期性记账</Button>
        <Button variant="outline" onClick={onApplyDue}>立即生成到期记录</Button>
      </div>

      <DataTable<Recurring>
        data={items}
        isLoading={isLoading}
        columns={[
          {
            key: 'type', header: '类型',
            render: (r) => <span>{TYPE_LABEL[r.type]}</span>,
          },
          {
            key: 'name', header: '名称',
            render: (r) => <span>{r.note || catName(r.category_id) || '-'}</span>,
          },
          {
            key: 'amount', header: '金额',
            render: (r) => <span className="font-medium">{formatMoney(r.amount)}</span>,
          },
          {
            key: 'account', header: '账户',
            render: (r) => r.type === 'transfer'
              ? <span>{accountName(r.account_id)} → {accountName(r.to_account_id)}</span>
              : <span>{accountName(r.account_id)}</span>,
          },
          {
            key: 'freq', header: '周期',
            render: (r) => <span>{FREQ_OPTIONS.find((o) => o.value === r.frequency)?.label}×{r.interval}</span>,
          },
          {
            key: 'next', header: '下次执行',
            render: (r) => <span>{formatDate(r.next_run)}</span>,
          },
          {
            key: 'status', header: '状态',
            render: (r) => (
              <span className="text-xs" style={{ color: r.is_active ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {r.is_active ? '启用' : '已停用'}
              </span>
            ),
          },
          {
            key: 'actions', header: '操作',
            render: (r) => (
              <div className="flex gap-1">
                <button
                  onClick={() => openEdit(r)}
                  className="rounded px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/5"
                >
                  编辑
                </button>
                <button
                  onClick={() => onDelete(r)}
                  className="rounded px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  删除
                </button>
              </div>
            ),
          },
        ]}
      />

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? '编辑周期性记账' : '新增周期性记账'} wide>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="col-span-1 text-xs text-muted">类型
            <Select value={form.type} onChange={(v) => set('type', v as RecurringType)} options={TYPE_OPTIONS} placeholder="类型" />
          </label>
          <label className="text-xs text-muted">金额
            <Input type="number" step="0.01" min="0.01" placeholder="金额" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
          </label>
          <div className="text-xs text-muted">账户
            <AccountPicker value={form.accountId} onChange={(id) => set('accountId', id)} excludeCredit />
          </div>
          {showCategory && (
            <div className="text-xs text-muted">分类
              <CategoryPicker
                type={form.type === 'transfer' ? 'expense' : form.type}
                value={form.categoryId}
                onChange={(id) => set('categoryId', id)}
              />
            </div>
          )}
          {form.type === 'transfer' && (
            <div className="text-xs text-muted">转入账户
              <AccountPicker value={form.toAccountId} onChange={(id) => set('toAccountId', id)} excludeCredit exclude={form.accountId ? [form.accountId] : []} label="转入账户" />
            </div>
          )}
          <label className="text-xs text-muted">备注
            <Input placeholder="如：房租" value={form.note} onChange={(e) => set('note', e.target.value)} />
          </label>
          <label className="text-xs text-muted">频率
            <Select value={form.frequency} onChange={(v) => set('frequency', v as RecurringFreq)} options={FREQ_OPTIONS} placeholder="频率" />
          </label>
          <label className="text-xs text-muted">间隔
            <Input type="number" step="1" min="1" placeholder="间隔" value={form.interval} onChange={(e) => set('interval', e.target.value)} />
          </label>
          <label className="text-xs text-muted">开始日期
            <Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </label>
          <label className="text-xs text-muted">结束日期（可选）
            <Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={onSubmit}>{editing ? '保存' : '添加'}</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget != null}
        title="删除周期性记账"
        description={deleteTarget ? `确认删除「${deleteTarget.note || TYPE_LABEL[deleteTarget.type]}」这条周期性记账吗？` : ''}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}