import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import StatsNav from './StatsNav';
import { getCashFlow } from '@/api/stats';
import { FlowSankey } from '@/components/charts/FlowSankey';
import { Input } from '@/components/ui/input';

const qStartMonth = (Math.floor((dayjs().month()) / 3)) * 3 + 1; // 1-based 季度首月
const presets = [
  { label: '本月', ym: dayjs().format('YYYY-MM') },
  { label: '上月', ym: dayjs().subtract(1, 'month').format('YYYY-MM') },
  { label: '本季', start: dayjs(`${dayjs().year()}-${String(qStartMonth).padStart(2, '0')}-01`) },
  { label: '本年', start: dayjs().startOf('year') },
];

export default function FlowStats() {
  const [from, setFrom] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = useState(dayjs().endOf('month').format('YYYY-MM-DD'));

  const { data = { nodes: [], links: [] }, isLoading } = useQuery({
    queryKey: ['stats', 'flow', from, to],
    queryFn: () => getCashFlow(from, to),
  });

  const totals = useMemo(() => {
    let income = 0, expense = 0, transfer = 0;
    for (const l of data.links) {
      if (l.source.startsWith('收入')) income += l.value;
      else if (l.target.startsWith('支出')) expense += l.value;
      else transfer += l.value;
    }
    return {
      income: Math.round(income * 100) / 100,
      expense: Math.round(expense * 100) / 100,
      transfer: Math.round(transfer) ,
    };
  }, [data]);

  function applyPreset(s: { label: string; ym?: string; start?: dayjs.Dayjs }) {
    if (s.ym) { setFrom(dayjs(`${s.ym}-01`).format('YYYY-MM-DD')); setTo(dayjs(`${s.ym}-01`).endOf('month').format('YYYY-MM-DD')); }
    else if (s.start) { setFrom(s.start.format('YYYY-MM-DD')); setTo(dayjs().format('YYYY-MM-DD')); }
  }

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">资金流向</h1>
      <StatsNav />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p)}
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

      {isLoading ? (
        <p className="py-10 text-center text-sm text-muted">统计中…</p>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="mb-3 flex flex-wrap gap-6 text-sm">
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#10B981' }} />收入 ¥{totals.income.toFixed(2)}</span>
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#3B82F6' }} />转账 ¥{totals.transfer.toFixed(2)}</span>
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#EF4444' }} />支出 ¥{totals.expense.toFixed(2)}</span>
          </div>
          <FlowSankey data={data} />
          <p className="mt-2 text-xs text-muted">链路：收入(分类) → 账户 → 转账 → 账户 → 支出(分类)。悬停节点可高亮其全部资金走向。</p>
        </div>
      )}
    </div>
  );
}