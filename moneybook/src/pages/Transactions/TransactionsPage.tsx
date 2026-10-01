import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import TransactionList from '@/components/transaction/TransactionList';
import TransactionForm from '@/components/transaction/TransactionForm';
import type { TransactionDetail } from '@/api/transactions';

/** 流水页支持的五类交易（与 TransactionForm 一致）。 */
const TABS = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'lend', label: '借出' },
  { value: 'borrow', label: '借入' },
] as const;
type FlowType = (typeof TABS)[number]['value'];

const DESC: Record<FlowType, string> = {
  expense: '记录与查看支出流水',
  income: '记录与查看收入流水',
  transfer: '账户间资金流转，不影响净资产',
  lend: '借给他人，记录借出流水',
  borrow: '向他人或机构借款，记录借入流水',
};

/**
 * 统一"流水"页：收入/支出/转账/借出/借入合并为一页，用 URL ?type= 驱动类型 Tab。
 * 复用 TransactionList（按类型过滤）与 TransactionForm（按类型预置），并统一具备编辑能力。
 * 旧入口 /income /expense /transfer 由路由重定向到此处对应 Tab（见 App.tsx）。
 */
export default function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('type');
  const active: FlowType = (TABS as readonly { value: FlowType }[]).some((t) => t.value === raw) ? (raw as FlowType) : 'expense';
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TransactionDetail | null>(null);

  /** 全局快捷键「快速记账」以 ?new=1 跳转进来：打开新建表单后立即清掉参数，
   *  保证下次再按快捷键仍能触发（参数不残留导致 effect 不再变化） */
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setEditTarget(null);
    setOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  function switchType(t: FlowType) {
    setSearchParams({ type: t }, { replace: true }); // 用 URL 表达 Tab，方便深链/刷新/共享
  }

  function handleEdit(tx: TransactionDetail) {
    setEditTarget(tx);
    setOpen(true);
  }

  function handleClose(v: boolean) {
    setOpen(v);
    if (!v) setEditTarget(null);
  }

  const label = TABS.find((t) => t.value === active)?.label ?? '';

  return (
    <div>
      <PageHeader
        title="流水记账"
        description={DESC[active]}
        action={
          <button
            onClick={() => { setEditTarget(null); setOpen(true); }}
            className="rounded-lg px-3 py-1.5 text-sm text-white"
            style={{ background: 'var(--color-primary)' }}
          >
            ＋ 记{label}
          </button>
        }
      />
      {/* 类型 Tab（唯一状态在 URL） */}
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-black/5 p-1 dark:bg-white/5">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => switchType(t.value)}
            className={`whitespace-nowrap rounded-md px-4 py-1.5 text-sm transition-colors ${t.value === active ? 'bg-[var(--color-primary)] font-medium text-white shadow-sm' : 'text-[var(--color-primary-fg)] hover:opacity-80'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <TransactionList type={active} onEdit={handleEdit} />
      <TransactionForm open={open} onOpenChange={handleClose} defaultType={active} editTarget={editTarget} />
    </div>
  );
}