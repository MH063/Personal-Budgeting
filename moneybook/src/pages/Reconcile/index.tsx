// 银行对账页面：批次列表 / 新建向导（选账户+期间+期初期末余额）/ 匹配 / 差异报告
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/data-table/DataTable';
import { useAccounts } from '@/hooks/useAccounts';
import { useTransactionList } from '@/hooks/useTransactions';
import { useReconciliation, useReconItems, useReconDiff, exportReconDiff, parseBankStatement, importBankRows, type ReconDiffRow } from '@/hooks/useReconciliation';
import { listMatches } from '@/api/reconciliation';
import type { BankRow } from '@/api/reconciliation';
import { explainReconDiff } from '@/api/llm';
import { formatDate, formatMoney } from '@/lib/format';
import type { TransactionDetail } from '@/api/transactions';

type View = 'list' | 'wizard' | 'match' | 'done';

interface ReconRow {
  id: number;
  account_id: number;
  account_name: string;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number;
  bank_balance: number | null;
  calc_balance: number | null;
  diff_total: number;
  status: 'draft' | 'locked';
  created_at: string;
}

const MATCH_KIND_LABEL: Record<string, string> = {
  auto: '自动匹配',
  manual: '手动匹配',
  split: '拆分匹配',
  unmatched_bank: '银行有·本地无',
  unmatched_local: '本地有·银行无',
  amount_mismatch: '金额不符',
};

const MATCH_KIND_COLOR: Record<string, string> = {
  auto: '#10B981',
  manual: '#3B82F6',
  split: '#8B5CF6',
  unmatched_bank: '#F59E0B',
  unmatched_local: '#EF4444',
  amount_mismatch: '#EF4444',
};

export default function ReconcilePage() {
  const { list, create, remove, auto, manual, lock, unlock } = useReconciliation();
  const { data: accounts = [] } = useAccounts(false);
  const batches = list.data ?? [];

  const [view, setView] = useState<View>('list');
  const [active, setActive] = useState<ReconRow | null>(null);
  const [sameAccountBatch, setSameAccountBatch] = useState<number>(0);
  const [delTarget, setDelTarget] = useState<ReconRow | null>(null);

  async function onCreate() {
    // 向导参数：账户 + 期间 + 期初余额
    if (!sameAccountBatch) { toast.error('请选择对账账户'); return; }
    const account = accounts.find((a) => a.id === Number(sameAccountBatch));
    if (!account) { toast.error('账户不存在'); return; }
    // 默认期间：当月
    const start = dayjs().startOf('month').format('YYYY-MM-DD');
    const end = dayjs().endOf('month').format('YYYY-MM-DD');
    try {
      const id = await create.mutateAsync({
        accountId: account.id,
        periodStart: start,
        periodEnd: end,
        openingBalance: account.balance,
      });
      // create.mutateAsync 返回新批次 id；batches 为旧引用查不到新行，
      // 这里用返回 id 直接构造当前批次对象（余额/状态为初始值），进入匹配界面
      setActive({
        id,
        account_id: account.id,
        account_name: account.name,
        period_start: start,
        period_end: end,
        opening_balance: account.balance,
        bank_balance: null,
        calc_balance: null,
        diff_total: 0,
        status: 'draft',
        created_at: '',
      });
      setView('match');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function onDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast.success('已删除对账批次');
    } catch (e) {
      toast.error((e as Error).message);
    }
    setDelTarget(null);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="银行对账"
        description="导入银行流水并与本地交易核对，识别差异，完成对账。"
        action={view !== 'list' ? (
          <Button variant="outline" size="sm" onClick={() => { setView('list'); setActive(null); }}>← 返回批次</Button>
        ) : (
          <Button size="sm" onClick={() => { setSameAccountBatch(0); setView('wizard'); }}>新建对账</Button>
        )}
      />

      {view === 'list' && (
        <DataTable<ReconRow>
          columns={[
            { key: 'account', header: '账户', render: (r) => r.account_name },
            { key: 'period', header: '对账期间', render: (r) => `${r.period_start ?? '-'} ~ ${r.period_end ?? '-'}` },
            { key: 'opening', header: '期初余额', render: (r) => formatMoney(r.opening_balance) },
            { key: 'bank', header: '银行余额', render: (r) => r.bank_balance != null ? formatMoney(r.bank_balance) : '-' },
            { key: 'calc', header: '推算余额', render: (r) => r.calc_balance != null ? formatMoney(r.calc_balance) : '-' },
            { key: 'diff', header: '差异', render: (r) => r.diff_total > 0.001 ? <span className="font-semibold" style={{ color: 'var(--color-danger)' }}>{formatMoney(r.diff_total)}</span> : <span className="text-muted">0</span> },
            {
              key: 'status', header: '状态',
              render: (r) => r.status === 'locked'
                ? <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: '#10B98122', color: '#10B981' }}>已锁定</span>
                : <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: '#F59E0B22', color: '#F59E0B' }}>对账中</span>,
            },
            {
              key: 'actions', header: '操作',
              render: (r) => (
                <span className="flex gap-2">
                  <button className="text-xs" style={{ color: 'var(--color-primary)' }} onClick={(e) => { e.stopPropagation(); setActive(r); setView('match'); }}>对账</button>
                  {r.status === 'locked' && (
                    <button className="text-xs text-muted" onClick={(e) => { e.stopPropagation(); unlock.mutateAsync(r.id).then(() => toast.info('已解锁，可继续修改')).catch((err) => toast.error(err.message)); }}>解锁</button>
                  )}
                  <button className="text-xs" style={{ color: 'var(--color-danger)' }} onClick={(e) => { e.stopPropagation(); setDelTarget(r); }}>删除</button>
                </span>
              ),
            },
          ]}
          data={batches}
          isLoading={list.isLoading}
          onRowClick={(r) => { setActive(r); setView('match'); }}
        />
      )}

      {view === 'wizard' && (
        <div className="max-w-xl space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
            <h3 className="mb-3 font-semibold">新建对账批次</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm text-muted">选择账户</label>
                <select
                  value={sameAccountBatch}
                  onChange={(e) => setSameAccountBatch(Number(e.target.value))}
                  className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm"
                >
                  <option value={0}>请选择…</option>
                  {accounts.filter((a) => a.type !== 'receivable' && a.type !== 'payable').map((a) => (
                    <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted">期初余额将取当前账户余额，对账期间默认为本月。</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setView('list')}>取消</Button>
                <Button size="sm" onClick={onCreate}>创建批次</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {view === 'match' && active && (
        <MatchView
          key={active.id}
          batch={active}
          onBack={() => setView('list')}
          onLocked={() => setView('done')}
        />
      )}

      {view === 'done' && active && <DoneView batch={active} onBack={() => setView('list')} />}

      <ConfirmDialog
        open={delTarget != null}
        title="删除对账批次"
        description="将删除该批次的所有匹配记录，并解除对本地交易的锁定标记。确定删除吗？"
        confirmText="删除"
        danger
        onConfirm={onDelete}
        onClose={() => setDelTarget(null)}
      />
    </div>
  );
}

// 匹配视图：导入银行流水 → 自动匹配 → 手动配对 → 完成对账
function MatchView({ batch, onBack, onLocked }: { batch: ReconRow; onBack: () => void; onLocked: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { auto, manual, lock } = useReconciliation();
  const { data: items = [], isLoading } = useReconItems(batch.id);
  // 本地未匹配默认分页 20 条/页；翻页会触发 useReconDiff 按 page 重新拉取
  const [diffPage, setDiffPage] = useState(1);
  const diffPageSize = 20;
  const { data: diff } = useReconDiff(batch.id, { page: diffPage, pageSize: diffPageSize });
  const [endBalance, setEndBalance] = useState('');
  const [manualItemId, setManualItemId] = useState<number | null>(null); // 待配对流水
  // AI 对账差异解释：点击按钮异步请求（可重复点击刷新；AI 失败时回退本地兜底文案）
  const [aiDiffText, setAiDiffText] = useState('');
  const [aiDiffSource, setAiDiffSource] = useState<'ai' | 'local' | ''>('');
  const [aiDiffLoading, setAiDiffLoading] = useState(false);
  const { data: locals = [] } = useTransactionList({
    accountId: batch.account_id,
    from: batch.period_start ?? undefined,
    to: batch.period_end ?? undefined,
    limit: 200,
  });

  // 差异导出：把三类差异（银行有·本地无 / 本地有·银行无 / 金额不符）导出为 xlsx
  async function onExport(kind: 'xlsx' | 'csv') {
    try {
      const rows: ReconDiffRow[] = await exportReconDiff(batch.id);
      if (!rows.length) { toast.error('当前没有可导出的差异数据'); return; }
      const label: Record<string, string> = { bank_unmatched: '银行有·本地无', local_unmatched: '本地有·银行无', amount_mismatch: '金额不符' };
      const header = ['差异类型', '日期', '摘要/备注', '收入', '支出'];
      const sheetRows = rows.map((r) => [label[r.kind] ?? r.kind, r.date, r.summary, r.income || '', r.expense || '']);
      const data = [header, ...sheetRows];
      const XLSX = (await import('xlsx')).default;
      if (kind === 'xlsx') {
        // 写入工作簿并导出 .xlsx
        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '对账差异');
        const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `对账差异_批次${batch.id}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        // 导出 .csv（带 BOM 防止中文乱码）
        const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = '\uFEFF' + data.map((r) => r.map(esc).join(',')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `对账差异_批次${batch.id}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
      toast.success(`已导出 ${rows.length} 条差异`);
    } catch (err) {
      toast.error(`导出失败：${(err as Error).message}`);
    }
  }

  // AI 对账差异解释：未启用 AI 时由 explainReconDiff 返回本地兜底文案，功能始终可用
  async function onAiExplain() {
    if (aiDiffLoading) return;
    setAiDiffLoading(true);
    setAiDiffText('');
    setAiDiffSource('');
    try {
      const r = await explainReconDiff(batch.id);
      setAiDiffText(r.text);
      setAiDiffSource(r.source);
    } catch (err) {
      toast.error(`差异解释失败：${(err as Error).message}`);
    } finally {
      setAiDiffLoading(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const rows = await parseBankStatement(buf);
      if (!rows.length) { toast.error('未从文件中解析出有效流水行，请确认列包含日期/摘要/收入/支出'); return; }
      const n = await importBankRows(batch.id, rows);
      toast.success(`已导入 ${n} 条银行流水`);
      // 导入后自动尝试匹配
      const r = await auto.mutateAsync(batch.id);
      toast.info(`自动匹配 ${r.matched} 条，待处理 ${r.skipped} 条`);
    } catch (err) {
      toast.error(`导入失败：${(err as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onAuto() {
    const r = await auto.mutateAsync(batch.id);
    toast.info(`自动匹配 ${r.matched} 条，待处理 ${r.skipped} 条`);
  }

  async function pair(itemId: number, txId: number) {
    try {
      await manual.mutateAsync({ recId: batch.id, itemId, txId });
      toast.success('已配对');
    } catch (error) {
      toast.error((error as Error).message);
    }
    setManualItemId(null);
  }

  async function onLock() {
    if (!endBalance || Number.isNaN(Number(endBalance))) { toast.error('请填写银行期末余额'); return; }
    try {
      await lock.mutateAsync({ recId: batch.id, endBalance: Number(endBalance) });
      toast.success('对账完成，批次已锁定');
      onLocked();
    } catch (error) {
      // 差异 > 0 时锁定后抛错提示复核，但仍保持锁定状态
      toast.error((error as Error).message);
      onLocked();
    }
  }

  const unmatched = items.filter((i) => i.match_kind === 'unmatched_bank');
  const matched = items.filter((i) => ['auto', 'manual', 'split'].includes(i.match_kind));

  // 本地未匹配分页总页数
  const localTotal = diff?.localUnmatchedTotal ?? 0;
  const localTotalPages = Math.max(1, Math.ceil(localTotal / diffPageSize));

  return (
    <div className="space-y-5">
      {/* 步骤一：导入与自动匹配 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
        <h3 className="mb-3 font-semibold">步骤一：导入银行流水并自动匹配</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={onFile} className="hidden" />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>导入银行对账单</Button>
          <Button size="sm" onClick={onAuto} disabled={auto.isPending || !unmatched.length}>
            {auto.isPending ? '匹配中…' : '重新自动匹配'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onExport('xlsx')}>导出差异（Excel）</Button>
          <Button size="sm" variant="outline" onClick={() => onExport('csv')}>导出差异（CSV）</Button>
          <Button size="sm" variant="outline" onClick={onAiExplain} disabled={aiDiffLoading} title="让 AI 结合差异明细说明差在哪，并给出排查建议">
            {aiDiffLoading ? 'AI 分析中…' : '🤖 AI 解释差异'}
          </Button>
          <span className="text-xs text-muted">模板列：日期 / 摘要 / 收入 / 支出 / 余额</span>
        </div>
        {/* AI 差异解释结果（AI 未开启或失败时展示本地兜底文案，功能不中断） */}
        {aiDiffText && (
          <div className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-black/2 p-3 text-sm dark:bg-white/5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-medium">对账差异解释</span>
              <span className="text-[10px]" style={{ color: '#8b8b96' }}>
                {aiDiffLoading ? '分析中…' : aiDiffSource === 'ai' ? 'AI' : '本地'}
              </span>
            </div>
            {aiDiffText}
          </div>
        )}
      </div>

      {/* 步骤二：匹配结果与差异 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <h3 className="mb-3 font-semibold">已匹配（{matched.length}）</h3>
          {matched.length === 0 ? <EmptyState icon="✅" text="尚无匹配" /> : (
            <ul className="space-y-1.5 text-sm">
              {matched.map((m) => {
                let b: BankRow | null = null;
                try { b = JSON.parse(m.bank_row) as BankRow; } catch { /* ignore */ }
                return (
                  <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/5 px-3 py-2 dark:bg-white/5">
                    <span className="min-w-0 flex-1">
                      <span className="mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${MATCH_KIND_COLOR[m.match_kind]}22`, color: MATCH_KIND_COLOR[m.match_kind] }}>
                        {MATCH_KIND_LABEL[m.match_kind]}
                      </span>
                      {b?.summary || (m.transaction_id ? `本地 #${m.transaction_id}` : '-')}
                    </span>
                    <span className="shrink-0">
                      {b ? b.income > 0 ? `+${formatMoney(b.income)}` : `-${formatMoney(b.expense)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <h3 className="mb-3 font-semibold">待处理（{unmatched.length}）</h3>
          {unmatched.length === 0 ? <EmptyState icon="🎯" text="全部匹配完成" /> : (
            <ul className="space-y-1.5 text-sm">
              {unmatched.slice(0, 50).map((m) => {
                let b: BankRow | null = null;
                try { b = JSON.parse(m.bank_row) as BankRow; } catch { /* ignore */ }
                return (
                  <li key={m.id} className="rounded-lg border border-[var(--border)] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1">{b?.summary || '-'}</span>
                      <span className="shrink-0">{b ? b.income > 0 ? `+${formatMoney(b.income)}` : `-${formatMoney(b.expense)}` : ''}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <span>{b ? b.date : ''}</span>
                      <button className="hover:underline" style={{ color: 'var(--color-primary)' }} onClick={() => setManualItemId(m.id)}>手动配对</button>
                    </div>
                    {manualItemId === m.id && (
                      <div className="mt-2 border-t border-[var(--border)] pt-2">
                        <p className="mb-1.5 text-xs text-muted">选择要配对的本地交易：</p>
                        <div className="max-h-48 space-y-1 overflow-y-auto">
                          {locals.map((tx) => (
                            <button
                              key={tx.id}
                              type="button"
                              onClick={() => pair(m.id, tx.id)}
                              className="block w-full truncate rounded bg-black/5 px-2 py-1 text-left text-xs hover:opacity-80 dark:bg-white/5"
                            >
                              {formatDate(tx.date)} · {tx.category_name ?? tx.type} · {formatMoney(tx.amount)} {tx.note ? `· ${tx.note}` : ''}
                            </button>
                          ))}
                          {locals.length === 0 && <p className="text-xs text-muted">该期间内暂无本地交易可配对</p>}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* 本地有·银行无：期间内未被任何流水匹配的本地交易（双向核对，带分页） */}
      {localTotal > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <h3 className="mb-3 flex items-center gap-1.5 font-semibold" style={{ color: 'var(--color-danger)' }}>
            本地有·银行无（{localTotal}）
            <Hint text="这些本地交易在对账期间内，但银行流水中没有对应记录——请确认是否漏记、记错账户或属于其他期间。" />
          </h3>
          {diff?.localUnmatched && diff.localUnmatched.length > 0 ? (
            <>
              <ul className="space-y-1.5 text-sm">
                {diff.localUnmatched.map((t) => (
                  <li key={t.transaction_id} className="flex items-center justify-between gap-2 rounded-lg bg-black/5 px-3 py-2 dark:bg-white/5">
                    <span className="min-w-0 flex-1">
                      {formatDate(t.tx_date ?? '')} · {t.account_name ?? '未知账户'} · {t.tx_note || '（无备注）'}
                    </span>
                    <span className="shrink-0 font-semibold">{t.tx_amount != null ? formatMoney(Math.abs(t.tx_amount)) : '-'}</span>
                  </li>
                ))}
              </ul>
              {/* 分页控件 */}
              <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                <button
                  className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                  disabled={diffPage <= 1}
                  onClick={() => setDiffPage((p) => Math.max(1, p - 1))}
                >上一页</button>
                <span>第 {diffPage} / {localTotalPages} 页</span>
                <button
                  className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
                  disabled={diffPage >= localTotalPages}
                  onClick={() => setDiffPage((p) => p + 1)}
                >下一页</button>
              </div>
            </>
          ) : (
            <EmptyState icon="🌿" text="该页暂无本地未匹配交易" />
          )}
        </div>
      )}

      {/* 步骤三：完成对账 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
        <h3 className="mb-3 font-semibold">步骤三：完成对账</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted">银行期末余额</label>
            <Input
              type="number"
              step="0.01"
              value={endBalance}
              onChange={(e) => setEndBalance(e.target.value)}
              placeholder="如 12345.67"
              className="w-40"
            />
          </div>
          <div className="pb-1 text-sm text-muted">
            推算余额：{diff?.calcBalance != null ? formatMoney(diff.calcBalance) : '-'}
            {diff?.calcBalance != null && endBalance && Math.abs(Number(diff.calcBalance) - Number(endBalance)) > 0.001 && (
              <span className="ml-2" style={{ color: 'var(--color-danger)' }}>
                差异 {formatMoney(Math.abs(Number(diff.calcBalance) - Number(endBalance)))}
              </span>
            )}
          </div>
          <Button size="sm" onClick={onLock} disabled={unmatched.length > 0 || lock.isPending}>
            {lock.isPending ? '锁定中…' : '锁定对账'}
          </Button>
          {unmatched.length > 0 && (
            <span className="pb-1 text-xs text-muted">还有 {unmatched.length} 条未配对流水，请先手动配对或确认差异。</span>
          )}
        </div>
      </div>
    </div>
  );
}

// 完成视图：对账结果摘要
function DoneView({ batch, onBack }: { batch: ReconRow; onBack: () => void }) {
  const { data: items = [] } = useReconItems(batch.id);
  const recs = items.length;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6">
      <h3 className="mb-3 text-lg font-bold">🎉 对账完成（批次 #{batch.id}）</h3>
      <p className="mb-4 text-sm text-muted">
        {batch.account_name} · {batch.period_start ?? '-'} ~ {batch.period_end ?? '-'}
      </p>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-muted">期初余额</div>
          <div className="text-lg font-semibold">{formatMoney(batch.opening_balance)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">银行余额</div>
          <div className="text-lg font-semibold">{batch.bank_balance != null ? formatMoney(batch.bank_balance) : '-'}</div>
        </div>
        <div>
          <div className="text-xs text-muted">推算余额</div>
          <div className="text-lg font-semibold">{batch.calc_balance != null ? formatMoney(batch.calc_balance) : '-'}</div>
        </div>
        <div>
          <div className="text-xs text-muted">差异</div>
          <div className="text-lg font-semibold" style={{ color: batch.diff_total > 0.001 ? 'var(--color-danger)' : 'var(--color-success)' }}>
            {formatMoney(batch.diff_total)}
          </div>
        </div>
      </div>
      <p className="text-sm text-muted">匹配记录 {recs} 条。</p>
      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={onBack}>返回批次列表</Button>
      </div>
    </div>
  );
}