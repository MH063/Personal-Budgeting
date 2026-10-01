import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import StatsNav from './StatsNav';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/common/ChartCard';
import { TrendChart } from '@/components/charts/TrendChart';
import { getMonthlySurplus, getSavingsRate } from '@/api/stats';

export default function SurplusStats() {
  const start = dayjs().startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  const halfYear = dayjs().subtract(6, 'month').startOf('month').format('YYYY-MM-DD');
  const { data: trend = [] } = useQuery({ queryKey: ['stats', 'trend', halfYear, end], queryFn: () => getMonthlySurplus(halfYear, end) });
  const { data: rate } = useQuery({ queryKey: ['stats', 'rate', start, end], queryFn: () => getSavingsRate(start, end) });
  const thisMonth = trend.find((t) => t.month === dayjs().format('YYYY-MM'));

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">盈余统计</h1>
      <StatsNav />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard title="本月收入" value={thisMonth?.income ?? 0} color="#10B981" />
        <StatCard title="本月支出" value={thisMonth?.expense ?? 0} color="#EF4444" />
        <StatCard title="本月储蓄率" value={(rate?.rate ?? 0) * 100} color="#8B5CF6" suffix="%" />
      </div>
      <div className="mt-6">
        <ChartCard title="近 6 个月收支趋势（盈余 = 收入 − 支出）">
          <TrendChart data={trend} />
        </ChartCard>
      </div>
    </div>
  );
}