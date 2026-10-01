import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import StatsNav from './StatsNav';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/common/ChartCard';
import { CategoryPie } from '@/components/charts/CategoryPie';
import { getCategoryDistribution, getMonthlySurplus } from '@/api/stats';

export default function ExpenseStats() {
  const start = dayjs().startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  const { data: dist = [] } = useQuery({ queryKey: ['stats', 'pie', 'expense', start, end], queryFn: () => getCategoryDistribution('expense', start, end) });
  const { data: trend = [] } = useQuery({ queryKey: ['stats', 'trend', start, end], queryFn: () => getMonthlySurplus(start, end) });
  const thisMonth = trend.find((t) => t.month === dayjs().format('YYYY-MM'));

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">支出统计</h1>
      <StatsNav />
      <StatCard title="本月支出" value={thisMonth?.expense ?? 0} color="#EF4444" />
      <div className="mt-6">
        <ChartCard title="本月支出分类占比">
          <CategoryPie data={dist} />
        </ChartCard>
      </div>
    </div>
  );
}