// 规划页 · 场景预测区块
// -----------------------------------------------------------------------------
// 在「近 N 月基线」之上叠加假设（收入涨跌、各分类支出调整、每月额外储蓄、一次性收支），
// 用纯函数 simulateCashflow 推演未来 N 个月的现金流与累计结余。
// 全程本地计算，不写库、不调接口返回模拟数据；基线来自真实流水聚合。
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { EChart } from '@/components/charts/EChart';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import { formatMoney } from '@/lib/format';
import { getPlanningBaseline, type PlanningBaseline } from '@/api/planning';
import { simulateCashflow } from '@/lib/cashflowPlan';
import type { EChartsOption } from 'echarts';

/** 可编辑的分类支出基线行 */
interface ItemRow { name: string; icon: string; base: string; deltaPct: string; }
/** 可编辑的一次性收支行 */
interface OneOffRow { ym: string; amount: string; label: string; }

const MONTH_OPTIONS: SelectOption[] = [
  { value: '6', label: '未来 6 个月' },
  { value: '12', label: '未来 12 个月' },
  { value: '24', label: '未来 24 个月' },
];

export default function CashflowScenarioSection() {
  const [baseline, setBaseline] = useState<PlanningBaseline | null>(null);
  const [loading, setLoading] = useState(true);

  // 假设参数（输入统一用字符串，避免受控输入被 Number 归零）
  const [incomeBase, setIncomeBase] = useState('0');
  const [incomeDeltaPct, setIncomeDeltaPct] = useState('0');
  const [extraSaving, setExtraSaving] = useState('0');
  const [months, setMonths] = useState('12');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [oneOffs, setOneOffs] = useState<OneOffRow[]>([]);

  // 加载基线并回填默认值（仅在首次加载后执行，不覆盖用户后续编辑）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPlanningBaseline(6)
      .then((b) => {
        if (cancelled) return;
        setBaseline(b);
        setIncomeBase(String(b.incomeAvg));
        setItems(b.expenseItems.map((c) => ({ name: c.name, icon: c.icon, base: String(c.base), deltaPct: '0' })));
      })
      .catch((e) => { console.error('[规划] 场景基线加载失败', e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const startYm = dayjs().add(1, 'month').format('YYYY-MM');

  // 预算结果：假设变化即时重算（纯函数，无副作用）
  const result = useMemo(
    () => simulateCashflow({
      startYm,
      months: Number(months) || 12,
      incomeBase: Number(incomeBase) || 0,
      incomeDeltaPct: Number(incomeDeltaPct) || 0,
      expenseItems: items.map((it) => ({ name: it.name, base: Number(it.base) || 0, deltaPct: Number(it.deltaPct) || 0 })),
      extraMonthlySaving: Number(extraSaving) || 0,
      oneOffs: oneOffs
        .filter((o) => o.ym && Number(o.amount) !== 0)
        .map((o) => ({ ym: o.ym, amount: Number(o.amount) || 0, label: o.label || undefined })),
    }),
    [startYm, months, incomeBase, incomeDeltaPct, items, extraSaving, oneOffs]
  );

  const updateItem = (i: number, patch: Partial<ItemRow>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addOneOff = () =>
    setOneOffs((prev) => [...prev, { ym: dayjs().format('YYYY-MM'), amount: '', label: '' }]);
  const updateOneOff = (i: number, patch: Partial<OneOffRow>) =>
    setOneOffs((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const removeOneOff = (i: number) => setOneOffs((prev) => prev.filter((_, idx) => idx !== i));

  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['累计结余', '当月净现金流'], top: 0 },
    grid: { left: 8, right: 8, top: 36, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: result.rows.map((r) => r.ym) },
    yAxis: { type: 'value' },
    series: [
      {
        name: '累计结余', type: 'line', smooth: true, symbolSize: 6,
        data: result.rows.map((r) => r.cumulative),
        itemStyle: { color: '#3B82F6' }, lineStyle: { width: 3 },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: '#EF4444', type: 'dashed' } },
      },
      {
        name: '当月净现金流', type: 'bar', barMaxWidth: 18,
        data: result.rows.map((r) => r.net),
        itemStyle: { color: '#94A3B8' },
      },
    ],
  };

  return (
    <div className="space-y-4">
      {loading && <div className="text-xs text-muted">正在加载基线…</div>}
      {baseline && (
        <div className="text-xs text-muted">
          基线取自近 {baseline.windowMonths} 个月流水（有效样本 {baseline.sampleMonths} 个月）：
          月均收入 ¥{formatMoney(baseline.incomeAvg)}，月均支出 ¥{formatMoney(baseline.expenseTotal)}。
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="space-y-1">
          <span className="text-xs text-muted">月收入基线</span>
          <Input type="number" step="0.01" value={incomeBase} onChange={(e) => setIncomeBase(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">收入变化（%）</span>
          <Input type="number" step="1" value={incomeDeltaPct} onChange={(e) => setIncomeDeltaPct(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">每月额外储蓄</span>
          <Input type="number" step="0.01" value={extraSaving} onChange={(e) => setExtraSaving(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">推演时长</span>
          <Select value={months} onChange={setMonths} options={MONTH_OPTIONS} />
        </label>
      </div>

      {/* 分类支出调整 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
        <div className="mb-2 text-sm font-medium">分类支出调整</div>
        {items.length === 0 ? (
          <div className="text-xs text-muted">近半年无支出数据，无法生成分类基线。</div>
        ) : (
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={`${it.name}-${i}`} className="grid grid-cols-[1fr_1fr_1fr] items-center gap-2">
                <span className="truncate text-sm">{it.icon} {it.name}</span>
                <Input type="number" step="0.01" value={it.base} onChange={(e) => updateItem(i, { base: e.target.value })} />
                <div className="flex items-center gap-1">
                  <Input type="number" step="1" value={it.deltaPct} onChange={(e) => updateItem(i, { deltaPct: e.target.value })} />
                  <span className="text-xs text-muted">%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 一次性收支 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">一次性收支（正=收入，负=支出）</span>
          <Button variant="outline" size="sm" onClick={addOneOff}>添加</Button>
        </div>
        {oneOffs.length === 0 ? (
          <div className="text-xs text-muted">未添加一次性项。</div>
        ) : (
          <div className="space-y-2">
            {oneOffs.map((o, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
                <Input type="month" value={o.ym} onChange={(e) => { if (e.target.value) updateOneOff(i, { ym: e.target.value }); }} />
                <Input type="number" step="0.01" placeholder="金额" value={o.amount} onChange={(e) => updateOneOff(i, { amount: e.target.value })} />
                <Input placeholder="备注" value={o.label} onChange={(e) => updateOneOff(i, { label: e.target.value })} />
                <button
                  type="button"
                  onClick={() => { removeOneOff(i); toast.success('已移除'); }}
                  className="rounded px-2 py-1 text-xs text-muted hover:bg-black/5 dark:hover:bg-white/5"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="text-xs text-muted">期末累计结余</div>
          <div className="mt-1 font-semibold" style={{ color: result.endBalance < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
            {result.endBalance < 0 ? '-' : '+'}¥{formatMoney(result.endBalance)}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="text-xs text-muted">最低点（{result.minYm || '—'}）</div>
          <div className="mt-1 font-semibold" style={{ color: result.minCumulative < 0 ? 'var(--color-danger)' : 'inherit' }}>
            ¥{formatMoney(result.minCumulative)}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="text-xs text-muted">入不敷出月份</div>
          <div className="mt-1 font-semibold" style={{ color: result.deficitMonths.length ? 'var(--color-danger)' : 'inherit' }}>
            {result.deficitMonths.length} 个月
          </div>
        </div>
      </div>

      {result.rows.length > 0 && <EChart option={option} height={300} />}
    </div>
  );
}
