import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { listTransactionsDetailed, type TransactionDetail } from '@/api/transactions';
import { useAccounts } from '@/hooks/useAccounts';
import { useCategories } from '@/hooks/useCategories';
import { useTags } from '@/hooks/useTags';
import { useFilterStore } from '@/stores/useFilterStore';
import { listTagsByTransactions } from '@/api/tags';
import { parseSearchQuery } from '@/api/aiSearch';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '@/components/data-table/DataTable';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { downloadCSV } from '@/lib/export';
import { TX_TYPES } from '@/lib/constants';
import { formatMoney, moneyColor, formatDate } from '@/lib/format';
import { useTransactionList, useTransactionMutations } from '@/hooks/useTransactions';
import { createTemplate, type TxnTemplatePayload } from '@/api/txnTemplate';

const PAGE_SIZE = 50;

export default function TransactionList({ type, onEdit }: { type?: string; onEdit?: (tx: TransactionDetail) => void }) {
  const [search, setSearch] = useState('');
  const [semanticText, setSemanticText] = useState('');
  const [accountId, setAccountId] = useState('0');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minAmt, setMinAmt] = useState('');
  const [maxAmt, setMaxAmt] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [categoryId, setCategoryId] = useState('0');
  const [page, setPage] = useState(0);
  const [delTarget, setDelTarget] = useState<TransactionDetail | null>(null);
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  // 批量选择与批量删除
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const { remove } = useTransactionMutations();
  const { data: accounts = [] } = useAccounts(false);
  const { data: cats = [] } = useCategories((type === 'expense' || type === 'income') ? type : undefined);
  const { data: tags = [] } = useTags();

  // 消费来自命令面板等的跨页面快速筛选（下钻），挂载时应用一次
  const quickSearch = useFilterStore((s) => s.quickSearch);
  const setQuickSearch = useFilterStore((s) => s.setQuickSearch);
  useEffect(() => {
    if (quickSearch) {
      setSearch(quickSearch);
      setPage(0);
      setQuickSearch('');
    }
    // 仅挂载时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data = [], isLoading } = useTransactionList({
    type: type === 'all' ? undefined : type,
    search: search || undefined,
    accountId: accountId !== '0' ? Number(accountId) : undefined,
    categoryId: categoryId !== '0' ? Number(categoryId) : undefined,
    from: from || undefined,
    to: to || undefined,
    minAmount: minAmt !== '' ? Number(minAmt) : undefined,
    maxAmount: maxAmt !== '' ? Number(maxAmt) : undefined,
    tagIds: tagIds.length ? tagIds : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  // 当前页交易的标签映射
  const { data: tagMap = {} } = useQuery({
    queryKey: ['txTagsMap', data.map((r) => r.id)],
    queryFn: () => listTagsByTransactions(data.map((r) => r.id)),
  });

  // 筛选/翻页变化时重置页码并清空已选（避免误删"看不见的行"）
  const resetPage = () => { setPage(0); setSelectedIds([]); };

  /** AI 语义搜索：把自然语言解析为过滤条件套用到列表（解析可选上云，命中查询全在本地） */
  async function doSemanticSearch() {
    const nl = semanticText.trim();
    if (!nl) { toast.info('请输入自然语言查询，如「上个月咖啡花了多少」'); return; }
    try {
      const crit = await parseSearchQuery(nl, { categoryNames: cats.map((c) => c.name).filter(Boolean) });
      setSearch(crit.search ?? '');
      setCategoryId(crit.categoryName ? String(cats.find((c) => c.name === crit.categoryName)?.id ?? 0) : '0');
      setFrom(crit.from ?? '');
      setTo(crit.to ?? '');
      setMinAmt(crit.minAmount != null ? String(crit.minAmount) : '');
      setMaxAmt(crit.maxAmount != null ? String(crit.maxAmount) : '');
      setPage(0);
      toast.info(`已按「${crit.label}」检索${crit.categoryName ? ` · 分类=${crit.categoryName}` : ''}${crit.search ? ` · 关键词=${crit.search}` : ''}`);
    } catch (e) {
      toast.error(`语义搜索失败：${(e as Error).message}`);
    }
  }

  const currentFilters = {
    type: type === 'all' ? undefined : type,
    search: search || undefined,
    accountId: accountId !== '0' ? Number(accountId) : undefined,
    categoryId: categoryId !== '0' ? Number(categoryId) : undefined,
    from: from || undefined,
    to: to || undefined,
    minAmount: minAmt !== '' ? Number(minAmt) : undefined,
    maxAmount: maxAmt !== '' ? Number(maxAmt) : undefined,
    tagIds: tagIds.length ? tagIds : undefined,
  };

  const toggleTag = (id: number) => {
    setTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setPage(0);
  };

  async function handleExport() {
    const rows = await listTransactionsDetailed({ ...currentFilters, limit: 100000 });
    // 导出纯数值（非带 ¥ 的格式化字符串），便于再导入或表格软件做数值计算/排序。
    // 金额列带符号反映对净资产的影响（收入 +、支出/借出/还出 -、转账 0），
    // 另设独立的收入/支出列，方便按方向筛选汇总。
    downloadCSV(
      `交易记录_${new Date().toISOString().slice(0, 10)}.csv`,
      ['日期', '类型', '分类', '账户', '备注', '支付时间', '付款方式', '收款方全称', '订单号', '商家订单号', '金额', '收入', '支出'],
      rows.map((r) => [
        formatDate(r.date),
        TX_TYPES[r.type]?.label ?? r.type,
        r.category_name ?? '-',
        r.account_name + (r.to_account_name ? ` → ${r.to_account_name}` : ''),
        r.note || '',
        r.pay_time ?? '',
        r.pay_method ?? '',
        r.payee ?? '',
        r.order_no ?? '',
        r.merchant_order_no ?? '',
        // 金额列带符号
        (r.type === 'income' || r.type === 'borrow' || r.type === 'repay_in') ? r.amount
          : (r.type === 'expense' || r.type === 'lend' || r.type === 'repay_out') ? -r.amount : 0,
        ['income', 'borrow', 'repay_in'].includes(r.type) ? r.amount : 0,
        ['expense', 'lend', 'repay_out'].includes(r.type) ? r.amount : 0,
      ])
    );
    toast.success(`已导出 ${rows.length} 条记录`);
  }

  const columns = [
    {
      key: 'date', header: '日期',
      render: (r: TransactionDetail) => formatDate(r.date),
    },
    {
      key: 'category', header: '分类',
      render: (r: TransactionDetail) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setCategoryId(r.category_id != null ? String(r.category_id) : '0'); resetPage(); }}
          className="flex items-center gap-1.5 hover:underline"
          title={r.category_id != null ? '按此分类筛选（下钻）' : '该分类不可筛选'}
        >
          {r.category_icon && <span>{r.category_icon}</span>}
          {r.category_name ?? TX_TYPES[r.type]?.label ?? '-'}
        </button>
      ),
    },
    {
      key: 'account', header: '账户',
      render: (r: TransactionDetail) => (
        <span>
          {r.account_icon} {r.account_name}
          {r.to_account_name ? ` → ${r.to_account_name}` : ''}
        </span>
      ),
    },
    {
      key: 'note', header: '备注',
      render: (r: TransactionDetail) => r.note || '-',
    },
    {
      key: 'txinfo', header: '交易信息',
      render: (r: TransactionDetail) => {
        const parts = [
          r.pay_time ? `时间 ${r.pay_time}` : '',
          r.pay_method ? r.pay_method : '',
          r.payee ? `收款 ${r.payee}` : '',
          r.order_no ? `订单 ${r.order_no}` : '',
          r.merchant_order_no ? `商家单 ${r.merchant_order_no}` : '',
        ].filter(Boolean);
        if (!parts.length) return <span className="text-muted">-</span>;
        return (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted">
            {parts.map((p, i) => <span key={i}>{p}</span>)}
          </span>
        );
      },
    },
    {
      key: 'tags', header: '标签',
      render: (r: TransactionDetail) => {
        const ts = tagMap[r.id];
        if (!ts || ts.length === 0) return <span className="text-muted">-</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {ts.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleTag(t.id); }}
                className="rounded-full px-1.5 py-0.5 text-[10px] font-medium transition hover:opacity-80"
                style={{
                  background: tagIds.includes(t.id) ? t.color : `${t.color}22`,
                  color: tagIds.includes(t.id) ? '#fff' : t.color,
                  outline: tagIds.includes(t.id) ? 'none' : '1px solid transparent',
                }}
                title={tagIds.includes(t.id) ? '点击移除该标签筛选' : '点击加入该标签筛选'}
              >
                {t.name}
              </button>
            ))}
          </span>
        );
      },
    },
    {
      key: 'amount', header: '金额',
      render: (r: TransactionDetail) => {
        const sign = TX_TYPES[r.type]?.sign ?? '+';
        const show = r.type === 'transfer' ? '±' : sign;
        return (
          <span className="font-semibold" style={{ color: moneyColor(show === '-' ? -r.amount : r.amount) }}>
            {show} {formatMoney(r.amount)}
          </span>
        );
      },
    },
    {
      key: 'actions', header: '操作',
      render: (r: TransactionDetail) => r.loan_id != null ? (
        <span className="text-xs text-muted" title="贷款生成的交易，请到「借贷」页管理">贷款记录</span>
      ) : (
        <div className="flex gap-1">
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(r); }}
              className="rounded px-2 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5"
            >
              编辑
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setDelTarget(r); }}
            className="rounded px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-black/5 dark:hover:bg-white/5"
          >
            删除
          </button>
        </div>
      ),
    },
  ];

  async function confirmDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast.success('删除成功');
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
    setDelTarget(null);
  }

  /** 本页选中集里可删除的交易（贷款生成的交易需到「借贷」页管理，跳过） */
  const selectedRows = data.filter((r) => selectedIds.includes(r.id));
  const deletableRows = selectedRows.filter((r) => r.loan_id == null);
  const skippedLoanCount = selectedRows.length - deletableRows.length;

  /**
   * 批量删除：顺序逐笔删除（SQLite 写操作串行更稳，避免并发写锁冲突），
   * 统计成功/失败；完成后清空选择并回到第 1 页（当前页可能已空）。
   * 每笔删除都会写入回收站快照，可在「回收站」中恢复。
   */
  async function confirmBatchDelete() {
    const ids = deletableRows.map((r) => r.id);
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
    setPage(0);
    if (fail === 0) {
      toast.success(`已删除 ${ok} 笔交易${skippedLoanCount ? `（跳过 ${skippedLoanCount} 笔贷款交易）` : ''}`);
    } else {
      toast.warning(`已删除 ${ok} 笔，${fail} 笔删除失败，请重试`);
    }
  }

  /** 把这笔已有记账另存为常用交易模板（含标签；还款类 repayment 交易不支持存模板） */
  async function handleSaveTpl(tx: TransactionDetail, name: string, tagIds: number[]) {
    // 还款类交易（repay_in/repay_out）不是模板允许类型，防御性拦截
    if (tx.type === 'repay_in' || tx.type === 'repay_out') {
      toast.warning('还款类交易暂不支持存为模板');
      return false;
    }
    try {
      await createTemplate({
        name,
        type: tx.type as TxnTemplatePayload['type'],
        amount: tx.amount,
        categoryId: tx.category_id ?? undefined,
        accountId: tx.account_id,
        toAccountId: tx.to_account_id ?? undefined,
        note: tx.note,
        payee: tx.payee ?? '',
        payMethod: tx.pay_method ?? '',
        tagIds,
      });
      toast.success(`已把该笔另存为模板「${name}」`);
      return true;
    } catch (e) {
      toast.error(`保存模板失败：${(e as Error).message}`);
      return false;
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="🤖 语义搜索：如 上个月咖啡花了多少"
          value={semanticText}
          onChange={(e) => setSemanticText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSemanticSearch(); }}
          className="max-w-[240px]"
        />
        <Button variant="outline" size="sm" onClick={() => void doSemanticSearch()}>语义搜索</Button>
        <Input
          placeholder="搜索备注/收款方/订单号…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); resetPage(); }}
          className="max-w-[160px]"
        />
        <select
          value={accountId}
          onChange={(e) => { setAccountId(e.target.value); resetPage(); }}
          className="h-9 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
        >
          <option value="0">全部账户</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
        </select>
        <select
          value={categoryId}
          onChange={(e) => { setCategoryId(e.target.value); resetPage(); }}
          className="h-9 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
        >
          <option value="0">全部分类</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
        {categoryId !== '0' && (
          <button
            type="button"
            title="清除分类筛选"
            onClick={() => { setCategoryId('0'); resetPage(); }}
            className="flex h-9 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            {(() => { const c = cats.find((x) => x.id === Number(categoryId)); return <>{c?.icon} {c?.name}</>; })()}
            <span className="text-muted">✕</span>
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted">标签</span>
          {tags.map((t) => {
            const on = tagIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggleTag(t.id)}
                className="rounded-full px-2 py-1 text-xs font-medium transition hover:opacity-80"
                style={{ background: on ? t.color : `${t.color}22`, color: on ? '#fff' : t.color }}
              >
                {t.name}
              </button>
            );
          })}
          {tagIds.length > 0 && (
            <button type="button" onClick={() => { setTagIds([]); setPage(0); }} className="text-xs text-muted hover:underline">
              清除标签
            </button>
          )}
        </div>
        <input
          type="date"
          value={from}
          onChange={(e) => { setFrom(e.target.value); resetPage(); }}
          className="h-9 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
        />
        <span className="text-xs text-muted">至</span>
        <input
          type="date"
          value={to}
          onChange={(e) => { setTo(e.target.value); resetPage(); }}
          className="h-9 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
        />
        <Input
          type="number"
          placeholder="最小金额"
          value={minAmt}
          onChange={(e) => { setMinAmt(e.target.value); resetPage(); }}
          className="max-w-[110px]"
        />
        <Input
          type="number"
          placeholder="最大金额"
          value={maxAmt}
          onChange={(e) => { setMaxAmt(e.target.value); resetPage(); }}
          className="max-w-[110px]"
        />
        <div className="ml-auto flex items-center gap-2">
          {/* 批量选择/批量删除：进入批量模式后每行出现复选框 */}
          {selectMode ? (
            <>
              <span className="text-sm text-muted">已选 {selectedIds.length} 条</span>
              <Button
                variant="danger"
                size="sm"
                disabled={!selectedIds.length || batchBusy}
                onClick={() => setBatchDeleteOpen(true)}
              >
                {batchBusy ? '删除中…' : '删除选中'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setSelectMode(false); setSelectedIds([]); }}>
                退出批量
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setSelectMode(true)}>批量选择</Button>
          )}
          <Button variant="outline" size="sm" onClick={handleExport}>导出 CSV</Button>
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => { setPage(page - 1); setSelectedIds([]); }}>
            上一页
          </Button>
          <span className="text-sm text-muted">第 {page + 1} 页</span>
          <Button variant="outline" size="sm" disabled={data.length < PAGE_SIZE} onClick={() => { setPage(page + 1); setSelectedIds([]); }}>
            下一页
          </Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={data}
        isLoading={isLoading}
        onRowClick={(r) => setDetail(r)}
        selectable={selectMode}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
      />
      <ConfirmDialog
        open={!!delTarget}
        title="删除交易"
        description={`确认删除这笔 ${TX_TYPES[delTarget?.type ?? '']?.label ?? ''} 记录？此操作不可撤销。`}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDelTarget(null)}
      />
      {/* 批量删除二次确认：明示可恢复（回收站）与贷款交易跳过规则，防误删 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        title="批量删除交易"
        description={`确认删除选中的 ${deletableRows.length} 笔交易？删除后可在「回收站」中恢复。${
          skippedLoanCount ? `另有 ${skippedLoanCount} 笔贷款生成的交易将被跳过，请到「借贷」页管理。` : ''
        }`}
        confirmText={`删除 ${deletableRows.length} 笔`}
        danger
        onConfirm={() => void confirmBatchDelete()}
        onClose={() => setBatchDeleteOpen(false)}
      />
      {/* 交易详情抽屉：点行打开，展示基础字段 + 交易明细 5 字段 + 标签 */}
      <TransactionDetailSheet
        tx={detail}
        tagMap={tagMap}
        onClose={() => setDetail(null)}
        onEdit={(r) => { setDetail(null); onEdit?.(r); }}
        onSaveTpl={(r, name, tagIds) => handleSaveTpl(r, name, tagIds)}
      />
    </div>
  );
}

/** 交易详情抽屉：以字段清单形式展示一笔交易的全部信息（5 字段 + 标签） */
function TransactionDetailSheet({ tx, tagMap, onClose, onEdit, onSaveTpl }: {
  tx: TransactionDetail | null;
  tagMap: Record<number, { id: number; name: string; color: string }[]>;
  onClose: () => void;
  onEdit: (r: TransactionDetail) => void;
  onSaveTpl: (r: TransactionDetail, name: string, tagIds: number[]) => Promise<boolean>;
}) {
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplBusy, setTplBusy] = useState(false);
  if (!tx) return null;
  const rows: { label: string; value: React.ReactNode; highlight?: boolean }[] = [
    { label: '类型', value: TX_TYPES[tx.type]?.label ?? tx.type },
    { label: '金额', value: formatMoney(tx.amount), highlight: true },
    { label: '日期', value: formatDate(tx.date) },
    { label: '账户', value: `${tx.account_icon} ${tx.account_name}${tx.to_account_name ? ` → ${tx.to_account_name}` : ''}` },
  ];
  if (tx.category_name) rows.push({ label: '分类', value: `${tx.category_icon ?? ''} ${tx.category_name}` });
  if (tx.note) rows.push({ label: '备注', value: tx.note });
  // 交易明细 5 字段
  if (tx.pay_time) rows.push({ label: '支付时间', value: tx.pay_time });
  if (tx.pay_method) rows.push({ label: '付款方式', value: tx.pay_method });
  if (tx.payee) rows.push({ label: '收款方全称', value: tx.payee });
  if (tx.order_no) rows.push({ label: '订单号', value: tx.order_no });
  if (tx.merchant_order_no) rows.push({ label: '商家订单号', value: tx.merchant_order_no });
  // 标签
  const txs = tagMap[tx.id] ?? [];
  if (txs.length) {
    rows.push({ label: '标签', value: (
      <span className="flex flex-wrap gap-1">
        {txs.map((t) => (
          <span key={t.id} className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ background: `${t.color}22`, color: t.color }}>{t.name}</span>
        ))}
      </span>
    ) });
  }
  return (
    <Sheet open={!!tx} onClose={onClose} title="交易详情">
      <div className="space-y-0 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-4 border-b border-[var(--border)] py-2 last:border-0">
            <span className="shrink-0 text-muted">{r.label}</span>
            <span className="text-right" style={r.highlight ? { fontWeight: 600, color: moneyColor(tx.type === 'expense' || tx.type === 'lend' || tx.type === 'repay_out' ? -tx.amount : tx.amount) } : undefined}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
      {onEdit && (
        <div className="mt-4 flex items-center justify-end gap-2">
          {/* 还款类交易（repay_in/repay_out）非模板允许类型，不提供「存为模板」 */}
          {tx.type !== 'repay_in' && tx.type !== 'repay_out' && !savingTpl && (
            <Button variant="outline" size="sm" onClick={() => setSavingTpl(true)}>存为模板</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onEdit(tx)}>编辑</Button>
        </div>
      )}
      {savingTpl && tx.type !== 'repay_in' && tx.type !== 'repay_out' && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            placeholder="模板名称，如：每月房租"
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            className="max-w-[240px]"
            autoFocus
          />
          <Button
            size="sm"
            disabled={tplBusy || !tplName.trim()}
            onClick={() => {
              const name = tplName.trim();
              if (!name) return;
              setTplBusy(true);
              void onSaveTpl(tx, name, (tagMap[tx.id] ?? []).map((t) => t.id)).then((ok) => {
                setTplBusy(false);
                if (ok) { setSavingTpl(false); setTplName(''); }
              });
            }}
          >
            {tplBusy ? '保存中…' : '保存模板'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setSavingTpl(false); setTplName(''); }}>取消</Button>
        </div>
      )}
    </Sheet>
  );
}
