// 规划页 · 年度预算总览区块
// -----------------------------------------------------------------------------
// 展示「年度预算 vs 年度实际、时间/消耗进度、年末线性外推、逐月柱状图」。
// 数据来自 api/planning.getAnnualBudgetOverview（真实库表聚合），不使用任何模拟数据。
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Select } from '@/components/ui/select';
import { EChart } from '@/components/charts/EChart';
import { formatMoney } from '@/lib/format';
import { getAnnualBudgetOverview, type AnnualBudgetOverview } from '@/api/planning';
import type { EChartsOption } from 'echarts';

/** 指标卡：标题 + 金额（可标红）+ 可选副标题 */
function Kpi({ label, value, hint, danger }: { label: string; value: string; hint?: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-semibold" style={danger ? { color: 'var(--color-danger)' } : undefined}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

/** 进度条行：标签 + 百分比条 + 数值 */
function ProgressRow({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs text-muted">{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function AnnualBudgetSection() {
  const nowYear = dayjs().year();
  const yearOptions = [nowYear + 1, nowYear, nowYear - 1, nowYear - 2].map((y) => ({
    value: String(y),
    label: `${y} 年`,
  }));
  const [year, setYear] = useState(String(nowYear));
  const [data, setData] = useState<AnnualBudgetOverview | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAnnualBudgetOverview(year)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { console.error('[规划] 年度总览加载失败', e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [year]);

  const p = data?.progress;
  const option: EChartsOption = data
    ? {
        tooltip: { trigger: 'axis' },
        legend: { data: ['预算基线', '实际支出'], top: 0 },
        grid: { left: 8, right: 8, top: 36, bottom: 0, containLabel: true },
        xAxis: { type: 'category', data: data.monthly.map((m) => `${Number(m.ym.slice(5))}月`) },
        yAxis: { type: 'value' },
        series: [
          { name: '预算基线', type: 'bar', data: data.monthly.map((m) => m.budget), itemStyle: { color: '#94A3B8' } },
          { name: '实际支出', type: 'bar', data: data.monthly.map((m) => m.actual), itemStyle: { color: '#3B82F6' } },
        ],
      }
    : {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">年度</span>
        <Select value={year} onChange={setYear} options={yearOptions} className="w-32" />
        {loading && <span className="text-xs text-muted">加载中…</span>}
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="年度预算" value={`¥${formatMoney(data.yearBudget)}`} />
            <Kpi label="年度已支出" value={`¥${formatMoney(data.yearActual)}`} />
            <Kpi label="年末预计支出" value={`¥${formatMoney(p?.forecastYearEnd ?? 0)}`} hint="按当前节奏线性外推" />
            <Kpi
              label="年末预计结余"
              value={`${(p?.forecastRemaining ?? 0) >= 0 ? '+' : ''}¥${formatMoney(p?.forecastRemaining ?? 0)}`}
              danger={(p?.forecastRemaining ?? 0) < 0}
            />
          </div>

          {data.yearBudget <= 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-black/5 p-3 text-xs text-muted dark:bg-white/5">
              尚未设置年度预算：可在「设置 → 预算」中按「年度」周期新增一条预算（分类留空即为总预算），或按分类分别设定年度额度。
            </div>
          )}

          <div className="space-y-2">
            <ProgressRow label="时间进度" value={p?.timeRatio ?? 0} color="var(--color-primary)" />
            <ProgressRow
              label="预算消耗"
              value={p?.usedRatio ?? 0}
              color={(p?.usedRatio ?? 0) >= 1 ? 'var(--color-danger)' : 'var(--color-warning)'}
            />
            <div className="text-xs text-muted">
              节奏比 {((p?.paceRatio ?? 0) * 100).toFixed(0)}%
              {p?.offTrack ? '：已超出预算节奏，年末预计超支' : '：处于预算节奏内'}
            </div>
          </div>

          <EChart option={option} height={280} />
        </>
      )}
    </div>
  );
}
