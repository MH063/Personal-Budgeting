import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { formatMoney } from '@/lib/format';
import type { Account } from '@/api/accounts';
import type { Holding } from '@/api/holdings';
import { useHoldings, useHoldingSummary, useHoldingMutations } from '@/hooks/useHoldings';

interface FormData {
  symbol: string;
  name: string;
  quantity: string;
  cost: string;
  price: string;
  note: string;
}
const EMPTY: FormData = { symbol: '', name: '', quantity: '', cost: '', price: '', note: '' };

export default function HoldingsModal({ open, onOpenChange, account }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account: Account;
}) {
  const { data: holdings = [] } = useHoldings(account.id);
  const { data: summary } = useHoldingSummary(account.id);
  const { create, update, remove } = useHoldingMutations();
  const { register, handleSubmit, reset, setValue, formState } = useForm<FormData>({ defaultValues: EMPTY });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Holding | null>(null);

  useEffect(() => {
    if (!open) { setEditingId(null); reset(EMPTY); }
  }, [open, reset]);

  function startEdit(h: Holding) {
    setEditingId(h.id);
    setValue('symbol', h.symbol);
    setValue('name', h.name);
    setValue('quantity', String(h.quantity));
    setValue('cost', String(h.cost));
    setValue('price', String(h.price));
    setValue('note', h.note);
  }
  function cancelEdit() {
    setEditingId(null);
    reset(EMPTY);
  }

  async function onSubmit(d: FormData) {
    const name = d.name.trim();
    const quantity = Number(d.quantity || 0);
    const cost = Number(d.cost || 0);
    const price = Number(d.price || 0);
    if (!name) { toast.error('请输入持仓名称'); return; }
    if (quantity <= 0) { toast.error('数量必须大于 0'); return; }
    try {
      if (editingId != null) {
        await update.mutateAsync({ id: editingId, p: { symbol: d.symbol.trim(), name, quantity, cost, price, note: d.note } });
        toast.success('持仓已更新');
      } else {
        await create.mutateAsync({ accountId: account.id, p: { symbol: d.symbol.trim(), name, quantity, cost, price, note: d.note } });
        toast.success('已添加持仓');
      }
      cancelEdit();
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    }
  }

  function onDelete(h: Holding) {
    // 统一用 ConfirmDialog 做危险操作确认（替换 window.confirm）
    setDeleteTarget(h);
  }
  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast.success('已删除持仓');
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
    setDeleteTarget(null);
  }

  const marketValue = summary?.marketValue ?? 0;
  const costValue = summary?.costValue ?? 0;
  const profit = summary?.profit ?? 0;
  const totalAssets = account.balance + marketValue;

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title={`持仓 · ${account.name}`} wide guard={{
      // 未保存守卫：录到一半误按 Esc/✕ 时不直接关闭，先确认防输入丢失
      dirty: formState.isDirty,
      // 「保存并关闭」：触发校验+提交，成功后弹窗自行关闭
      onSave: () => { void handleSubmit(onSubmit)(); },
    }}>
      {/* 汇总：现金 / 市值 / 总资产 / 盈亏 */}
      <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm lg:grid-cols-4">
        <div>
          <div className="text-xs text-muted">现金</div>
          <div className="font-semibold">{formatMoney(account.balance)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">持仓市值</div>
          <div className="font-semibold">{formatMoney(marketValue)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">总资产</div>
          <div className="font-bold text-[var(--color-primary-fg)]">{formatMoney(totalAssets)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">持仓盈亏</div>
          <div className="font-semibold" style={{ color: profit >= 0 ? '#10B981' : '#EF4444' }}>
            {profit >= 0 ? '+' : ''}{formatMoney(profit)}
            <span className="ml-1 text-xs text-muted">
              {costValue > 0 ? ` ${((profit / costValue) * 100).toFixed(2)}%` : ''}
            </span>
          </div>
        </div>
      </div>

      {/* 持仓列表 */}
      <div className="mb-4 space-y-2">
        {holdings.length === 0 && (
          <p className="rounded-lg border border-dashed border-[var(--border)] p-4 text-sm text-muted">
            暂无持仓。添加一笔持仓后，账户的「总资产」将按 现金 + 市值 计算。
          </p>
        )}
        {holdings.map((h) => {
          const mv = h.quantity * h.price;
          const cv = h.quantity * h.cost;
          const pf = mv - cv;
          return (
            <div key={h.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{h.name}</span>
                  {h.symbol && <span className="text-xs text-muted">{h.symbol}</span>}
                </div>
                <div className="text-xs text-muted">
                  {h.quantity} × {formatMoney(h.price)} = {formatMoney(mv)}
                  <span className="ml-2">成本 {formatMoney(cv)}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold" style={{ color: pf >= 0 ? '#10B981' : '#EF4444' }}>
                  {pf >= 0 ? '+' : ''}{formatMoney(pf)}
                </span>
                <div className="flex gap-2 text-xs">
                  <button onClick={() => startEdit(h)} className="rounded px-1.5 py-0.5 text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5">编辑</button>
                  <button onClick={() => onDelete(h)} className="rounded px-1.5 py-0.5 text-[var(--color-danger)] hover:bg-black/5 dark:hover:bg-white/5">删除</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 添加 / 编辑表单 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h4 className="mb-3 text-sm font-semibold">{editingId != null ? '编辑持仓' : '添加持仓'}</h4>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs text-muted">名称 *</label>
              <Input placeholder="如：沪深300" {...register('name')} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">代码</label>
              <Input placeholder="如：510300" {...register('symbol')} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">数量 *</label>
              <Input type="number" step="any" min="0" {...register('quantity')} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">单位成本</label>
              <Input type="number" step="0.0001" min="0" {...register('cost')} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">当前价格</label>
              <Input type="number" step="0.0001" min="0" {...register('price')} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">备注</label>
            <Input placeholder="可选" {...register('note')} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={create.isPending || update.isPending}>
              {editingId != null ? '保存' : '添加'}
            </Button>
            {editingId != null && (
              <Button type="button" variant="outline" onClick={cancelEdit}>取消</Button>
            )}
          </div>
        </form>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          添加/编辑持仓会按「数量 × 单位成本」从该账户现金中扣减或返还；改价格只影响市值与盈亏，不动现金。
        </p>
      </div>

      <ConfirmDialog
        open={deleteTarget != null}
        title="删除持仓"
        description={deleteTarget ? `删除持仓「${deleteTarget.name}」？将按成本 ${formatMoney(deleteTarget.cost * deleteTarget.quantity)} 返还可投现金。` : ''}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </Modal>
  );
}