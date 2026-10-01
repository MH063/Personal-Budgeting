import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import StatsNav from './StatsNav';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/common/ChartCard';
import { CategoryPie } from '@/components/charts/CategoryPie';
import { getMonthlySurplus, getCategoryDistribution, getNetWorth, getSavingsRate, getPeriodComparison } from '@/api/stats';

function pct(cur: number, base: number) {
  if (!base) return { text: '—', gap: 0 };
  const gap = ((cur - base) / base) * 100;
  const arrow = gap > 0 ? '↗' : gap < 0 ? '↘' : '→';
  return { text: `${arrow} ${Math.round(gap)}%`, gap };
}

function diffBadge(cur: number, base: number, goodWhenDown: boolean) {
  const { text, gap } = pct(cur, base);
  if (gap === 0) return <span className="text-muted">{text}</span>;
  const good = goodWhenDown ? gap < 0 : gap > 0;
  return <span style={{ color: good ? 'var(--color-primary)' : 'var(--color-danger)' }}>{text}</span>;
}

export default function Overview() {
  const start = dayjs().startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  const yearStart = dayjs().startOf('year').format('YYYY-MM-DD');

  const { data: trend = [] } = useQuery({ queryKey: ['stats', 'trend', yearStart, end], queryFn: () => getMonthlySurplus(yearStart, end) });
  const { data: dist = [] } = useQuery({ queryKey: ['stats', 'pie', 'expense', start, end], queryFn: () => getCategoryDistribution('expense', start, end) });
  const { data: nw } = useQuery({ queryKey: ['stats', 'networth'], queryFn: getNetWorth });
  const { data: rate } = useQuery({ queryKey: ['stats', 'rate', start, end], queryFn: () => getSavingsRate(start, end) });
  const { data: cmp = [] } = useQuery({ queryKey: ['stats', 'cmp', dayjs().format('YYYY-MM')], queryFn: () => getPeriodComparison(dayjs().format('YYYY-MM')) });

  const thisMonth = trend.find((t) => t.month === dayjs().format('YYYY-MM'));
  const [cur, prev, lastYear] = cmp;

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">统计</h1>
      <StatsNav />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="本月收入" value={thisMonth?.income ?? 0} color="#10B981" />
        <StatCard title="本月支出" value={thisMonth?.expense ?? 0} color="#EF4444" />
        <StatCard title="净资产" value={nw?.netWorth ?? 0} color="#1E6FA9" />
        <StatCard title="本月储蓄率" value={(rate?.rate ?? 0) * 100} color="#8B5CF6" suffix="%" />
      </div>

      {typeof cur !== 'undefined' && prev && lastYear && (
        <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 font-semibold">收支对比</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 font-medium">指标</th>
                <th className="py-1.5 font-medium">本月 {cur.ym}</th>
                <th className="py-1.5 font-medium">环比(上月)</th>
                <th className="py-1.5 font-medium">同比(去年同期)</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: '收入', c: cur.income, p: prev.income, l: lastYear.income, goodWhenDown: false },
                { label: '支出', c: cur.expense, p: prev.expense, l: lastYear.expense, goodWhenDown: true },
                { label: '盈余', c: cur.surplus, p: prev.surplus, l: lastYear.surplus, goodWhenDown: false },
              ].map((row) => (
                <tr key={row.label} className="border-t border-[var(--border)]">
                  <td className="py-2 font-medium">{row.label}</td>
                  <td className="py-2">{row.c.toFixed(2)}</td>
                  <td className="py-2">{diffBadge(row.c, row.p, row.goodWhenDown)}</td>
                  <td className="py-2">{diffBadge(row.c, row.l, row.goodWhenDown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">绿色表示向好（收入/盈余上升、支出下降），红色表示需注意。</p>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="本月支出分类占比">
          <CategoryPie data={dist} />
        </ChartCard>
      </div>
    </div>
  );
}