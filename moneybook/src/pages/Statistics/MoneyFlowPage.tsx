import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { EChartsOption } from 'echarts';
import { useAIStore } from '@/stores/useAIStore';
import { useAiChat } from '@/hooks/useAiChat';
import { getMoneyFlowAnalysis, type FlowDimension } from '@/api/moneyflow';
import { buildMoneyFlowContext, MONEY_FLOW_SYSTEM } from '@/api/llm';
import { EChart } from '@/components/charts/EChart';
import StatsNav from './StatsNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DIMS: { key: FlowDimension; label: string }[] = [
  { key: 'category', label: '分类' },
  { key: 'account', label: '账户' },
  { key: 'tag', label: '标签' },
  { key: 'week', label: '按周' },
  { key: 'amount', label: '金额区间' },
  { key: 'type', label: '收支类型' },
];

const qStart = (() => {
  const m = (Math.floor(dayjs().month() / 3)) * 3 + 1; // 1-based 季度首月
  return dayjs(`${dayjs().year()}-${String(m).padStart(2, '0')}-01`);
})();

const presets = [
  { label: '本月', from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD') },
  { label: '上月', from: dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'), to: dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD') },
  { label: '本季', from: qStart.format('YYYY-MM-DD'), to: dayjs().format('YYYY-MM-DD') },
  { label: '本年', from: dayjs().startOf('year').format('YYYY-MM-DD'), to: dayjs().format('YYYY-MM-DD') },
];

export default function MoneyFlowPage() {
  const [dim, setDim] = useState<FlowDimension>('category');
  const [from, setFrom] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = useState(dayjs().endOf('month').format('YYYY-MM-DD'));
  const aiEnabled = useAIStore((s) => s.enabled);
  const ai = useAiChat();

  // 维度/时间范围变化后，上一次的 AI 解读已不对应当前数据：清空以免误导（需重新点击「开始分析」）
  const aiRef = useRef(ai);
  aiRef.current = ai;
  useEffect(() => {
    aiRef.current.setResult('');
    aiRef.current.setError('');
  }, [dim, from, to]);

  const { data, isLoading } = useQuery({
    queryKey: ['stats', 'money-flow', dim, from, to],
    queryFn: () => getMoneyFlowAnalysis({ dimension: dim, from, to }),
  });

  const expenseChart = useMemo<EChartsOption>(() => {
    const rows = (data?.items ?? []).filter((i) => i.expense > 0).slice(0, 15).reverse();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 30, top: 10, bottom: 8, containLabel: true },
      xAxis: { type: 'value', axisLabel: { formatter: '¥{value}' } },
      yAxis: { type: 'category', data: rows.map((r) => r.label) },
      series: [{
        name: '支出', type: 'bar', data: rows.map((r) => r.expense),
        itemStyle: { color: '#EF4444', borderRadius: 4 },
        barMaxWidth: 20,
      }],
    };
  }, [data]);

  const incomeChart = useMemo<EChartsOption>(() => {
    const rows = (data?.items ?? []).filter((i) => i.income > 0).slice(0, 10).reverse();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 30, top: 10, bottom: 8, containLabel: true },
      xAxis: { type: 'value', axisLabel: { formatter: '¥{value}' } },
      yAxis: { type: 'category', data: rows.map((r) => r.label) },
      series: [{
        name: '收入', type: 'bar', data: rows.map((r) => r.income),
        itemStyle: { color: '#10B981', borderRadius: 4 },
        barMaxWidth: 20,
      }],
    };
  }, [data]);

  function runAi() {
    if (!data) return;
    ai.run(buildMoneyFlowContext(data), MONEY_FLOW_SYSTEM);
  }

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">资金去向</h1>
      <StatsNav />

      {/* 维度 + 时间 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">分析维度：</span>
        {DIMS.map((d) => (
          <button
            key={d.key}
            onClick={() => setDim(d.key)}
            className="rounded-lg px-3 py-1.5 text-sm"
            style={dim === d.key ? { background: 'var(--color-primary)', color: '#fff' } : { border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => { setFrom(p.from); setTo(p.to); }}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            {p.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" />
          <span className="text-muted">至</span>
          <Input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" />
        </div>
      </div>

      {isLoading || !data ? (
        <p className="py-10 text-center text-sm text-muted">统计中…</p>
      ) : (
        <>
          {/* 本地汇总（完整原始数据，不脱敏） */}
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <div className="mb-2 text-sm font-semibold">支出 · 各维度去向（¥{data.totalExpense.toFixed(2)}）</div>
              <EChart option={expenseChart} height={320} />
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <div className="mb-2 flex items-center justify-between text-sm font-semibold">
                <span>收入 · 各维度来源（¥{data.totalIncome.toFixed(2)}）</span>
                <span className="font-normal text-muted">本地数据，完整展示</span>
              </div>
              <EChart option={incomeChart} height={320} />
            </div>
          </div>

          <div className="mt-5 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="mb-2 text-sm font-semibold">明细表（本地原始数据）</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1.5 pr-4">{DIMS.find((d) => d.key === dim)?.label ?? dim}</th>
                  <th className="py-1.5 pr-4 text-right">支出</th>
                  <th className="py-1.5 pr-4 text-right">收入</th>
                  <th className="py-1.5 text-right">笔数</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.label} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-4">{it.label}</td>
                    <td className="py-1.5 pr-4 text-right">{it.expense > 0 ? `¥${it.expense.toFixed(2)}` : '-'}</td>
                    <td className="py-1.5 pr-4 text-right">{it.income > 0 ? `¥${it.income.toFixed(2)}` : '-'}</td>
                    <td className="py-1.5 text-right text-muted">{it.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* AI 解读（云端路线，仅上送脱敏后的维度汇总） */}
          <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h3 className="font-semibold">🤖 AI 解读资金去向</h3>
                <p className="mt-0.5 text-xs text-muted">仅把「按当前维度的汇总金额 / 占比（已脱敏）」发送到你配置的接口，不含任何单笔明细；本地数据保持完整不受影响。</p>
              </div>
              <Button onClick={runAi} disabled={ai.loading}>{(ai.loading ? '分析中…' : '开始分析')}</Button>
            </div>

            {!aiEnabled ? (
              <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-sm text-muted">
                尚未开启 AI。开启后即可用自然语言解读资金去向。 <Link to="/settings?tab=ai" className="underline" style={{ color: 'var(--color-primary)' }}>去开启 →</Link>
              </div>
            ) : (
              <>
                {ai.loading || ai.result || ai.error ? (
                  <div className="mt-2 rounded-lg border border-[var(--border)] p-3">
                    {ai.error ? (
                      <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{ai.error}</p>
                    ) : (
                      <div className="whitespace-pre-wrap text-sm leading-relaxed">{ai.result}</div>
                    )}
                    {ai.loading && (
                      <button type="button" onClick={ai.stop} className="mt-2 text-xs text-muted hover:underline">停止生成</button>
                    )}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-[var(--border)] p-3 text-sm text-muted">
                    点击右上角「开始分析」，AI 将基于当前维度与时间范围的汇总数据，分析钱花在哪、如何优化。
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}