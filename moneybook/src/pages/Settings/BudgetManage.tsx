import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { execute } from '@/api/db';
import { getBudgetVsActualAdvanced, type BudgetPeriod, type BudgetVsActualAdvancedRow } from '@/api/stats';
import { currentLedgerId } from '@/lib/ledger';
import { deleteBudgetSafe } from '@/api/trash';
import { useCategories } from '@/hooks/useCategories';
import { BUDGET_WARN_PERCENT } from '@/lib/budgetGuard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { DataTable } from '@/components/data-table/DataTable';
import { EChart } from '@/components/charts/EChart';
import type { EChartsOption } from 'echarts';
import { formatMoney } from '@/lib/format';

const PERIOD_OPTIONS: SelectOption[] = [
  { value: 'monthly', label: '月度' },
  { value: 'quarterly', label: '季度' },
  { value: 'yearly', label: '年度' },
];

const periodLabel = (p: BudgetPeriod) => PERIOD_OPTIONS.find((o) => o.value === p)?.label ?? p;

export default function BudgetManage() {
  const [budgets, setBudgets] = useState<BudgetVsActualAdvancedRow[]>([]);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [queryPeriod, setQueryPeriod] = useState<BudgetPeriod>('monthly');
  const [anchor, setAnchor] = useState(dayjs().format('YYYY-MM'));
  const [expandedUsable, setExpandedUsable] = useState<Set<number>>(new Set());
  const { data: cats = [] } = useCategories('expense');

  const toggleUsable = (id: number) => {
    setExpandedUsable((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const load = async () => {
    const rows = await getBudgetVsActualAdvanced({ period: queryPeriod, anchor });
    setBudgets(rows);
  };

  useEffect(() => { load(); }, [queryPeriod, anchor]);

  const catOptions: SelectOption[] = [
    { value: '', label: '全部（总预算）' },
    ...cats.map((c) => ({ value: String(c.id), label: `${c.icon} ${c.name}` })),
  ];

  async function onCreate() {
    if (!amount || Number(amount) <= 0) { toast.error('请输入有效金额'); return; }
    const start = new Date().toISOString().slice(0, 10);
    await execute(
      `INSERT INTO budgets (category_id, amount, period, start_date, ledger_id) VALUES ($1,$2,$3,$4,$5)`,
      [categoryId ? Number(categoryId) : null, Number(amount), period, start, currentLedgerId()]
    );
    toast.success('预算已添加');
    setAmount(''); setCategoryId('');
    load();
  }

  async function onDelete(id: number) {
    // 预算删除进入回收站，可在「回收站」页恢复
    await deleteBudgetSafe(id);
    toast.success('已删除（可在回收站恢复）');
    load();
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 font-semibold">新增预算</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Select value={categoryId} onChange={setCategoryId} options={catOptions} />
          <Select<BudgetPeriod> value={period} onChange={setPeriod} options={PERIOD_OPTIONS} placeholder="周期" />
          <Input type="number" step="0.01" min="0.01" placeholder="金额" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button onClick={onCreate}>添加</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">查询周期</span>
          <Select<BudgetPeriod> value={queryPeriod} onChange={setQueryPeriod} options={PERIOD_OPTIONS} className="w-28" />
        </div>
        <Input
          type="month"
          value={anchor}
          onChange={(e) => { if (e.target.value) setAnchor(e.target.value); }}
          className="w-40"
        />
        <span className="text-xs text-muted">{queryPeriod === 'monthly' ? '当月' : queryPeriod === 'quarterly' ? '当季' : '当年'}</span>
      </div>

      {budgets.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 font-semibold">预算 vs 实际</h3>
          <BudgetActualChart rows={budgets} />
        </div>
      )}

      <DataTable
        data={budgets}
        columns={[
          {
            key: 'category', header: '分类',
            render: (r: BudgetVsActualAdvancedRow) => {
              // 红点（超支）/ 黄点（接近上限）/ 无点（正常）
              const pct = r.usable > 0 ? (r.actual / r.usable) * 100 : (r.actual > 0 ? 100 : 0);
              const dotOn = pct >= 100 ? 'var(--color-danger)' : pct >= BUDGET_WARN_PERCENT ? 'var(--color-warning)' : null;
              return (
                <span className="inline-flex items-center gap-1.5">
                  {dotOn && <span className="inline-block h-2 w-2 rounded-full" style={{ background: dotOn }} />}
                  {r.category_icon} {r.category_name ?? '全部'}
                </span>
              );
            },
          },
          {
            key: 'period', header: '周期',
            render: (r: BudgetVsActualAdvancedRow) => <span>{periodLabel(r.period)}</span>,
          },
          {
            key: 'budget', header: '预算',
            render: (r: BudgetVsActualAdvancedRow) => <span className="font-medium">{formatMoney(r.period_amount)}</span>,
          },
          {
            key: 'rolled_in', header: '滚入',
            render: (r: BudgetVsActualAdvancedRow) => (
              <span className="font-medium text-muted">{formatMoney(r.rolled_in)}</span>
            ),
          },
          {
            key: 'usable', header: '可用',
            render: (r: BudgetVsActualAdvancedRow) => {
              const open = expandedUsable.has(r.id);
              const source = r.rollover_source;
              return (
                <div>
                  <button
                    type="button"
                    onClick={() => toggleUsable(r.id)}
                    title={open ? '收起明细' : '展开明细'}
                    className="flex items-center gap-1 font-medium"
                  >
                    <span
                      className={`inline-block text-[10px] leading-none text-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                    >
                      ▶
                    </span>
                    {formatMoney(r.usable)}
                  </button>
                  {open && (
                    <div className="mt-1 space-y-0.5 text-xs text-muted">
                      <div>
                        期初 {formatMoney(r.period_amount)} + 滚入 {formatMoney(r.rolled_in)}
                        <span className="ml-1 font-medium text-[var(--text)]">¥{formatMoney(r.usable)}</span>
                      </div>
                      {source && (
                        <div>
                          滚入来自上期 {source.prev_period} 结余 ¥{formatMoney(source.prev_surplus)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            },
          },
          {
            key: 'actual', header: '实际支出',
            render: (r: BudgetVsActualAdvancedRow) => {
              const over = r.status === 'over';
              return (
                <span className="font-medium" style={{ color: over ? 'var(--color-danger)' : 'inherit' }}>
                  {formatMoney(r.actual)}
                </span>
              );
            },
          },
          {
            key: 'diff', header: '剩余',
            render: (r: BudgetVsActualAdvancedRow) => {
              const diff = r.usable - r.actual;
              return (
                <span className="font-medium" style={{ color: diff < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
                  {diff >= 0 ? '+' : ''}{formatMoney(diff)}
                </span>
              );
            },
          },
          {
            key: 'progress', header: '进度',
            render: (r: BudgetVsActualAdvancedRow) => {
              const pct = r.usable > 0 ? Math.min(100, (r.actual / r.usable) * 100) : 0;
              // 进度条配色：超支红 / 接近上限黄 / 正常主色
              const barColor = pct >= 100 ? 'var(--color-danger)'
                : pct >= BUDGET_WARN_PERCENT ? 'var(--color-warning)' : 'var(--color-primary)';
              return (
                <div className="flex items-center gap-2">
                  <div className="h-2 w-20 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: barColor }}
                    />
                  </div>
                  <span className="text-xs text-muted">{pct.toFixed(0)}%</span>
                </div>
              );
            },
          },
          {
            key: 'actions', header: '操作',
            render: (r: BudgetVsActualAdvancedRow) => (
              <button
                onClick={() => onDelete(r.id)}
                className="rounded px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-black/5 dark:hover:bg-white/5"
              >
                删除
              </button>
            ),
          },
        ]}
      />
    </div>
  );
}

function BudgetActualChart({ rows }: { rows: BudgetVsActualAdvancedRow[] }) {
  const names = rows.map((r) => r.category_name ?? '全部');
  const budgets = rows.map((r) => Math.round(r.period_amount * 100) / 100);
  const actuals = rows.map((r) => Math.round(r.actual * 100) / 100);
  const option: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `¥${Number(v).toFixed(2)}` },
    legend: { data: ['预算', '实际'], top: 0 },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: names, axisLabel: { interval: 0, rotate: rows.length > 4 ? 25 : 0 } },
    yAxis: { type: 'value', axisLabel: { formatter: '¥{value}' } },
    series: [
      { name: '预算', type: 'bar', barMaxWidth: 28, data: budgets, itemStyle: { color: '#3B82F6' } },
      { name: '实际', type: 'bar', barMaxWidth: 28, data: actuals, itemStyle: { color: '#EF4444' } },
    ],
  };
  return <EChart option={option} height={300} />;
}