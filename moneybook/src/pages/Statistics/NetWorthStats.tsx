import { useQuery } from '@tanstack/react-query';
import StatsNav from './StatsNav';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/common/ChartCard';
import { NetWorthChart } from '@/components/charts/NetWorthChart';
import { getNetWorth, getNetWorthTrend } from '@/api/stats';

export default function NetWorthStats() {
  const { data: nw } = useQuery({ queryKey: ['stats', 'networth'], queryFn: getNetWorth });
  const { data: trend } = useQuery({ queryKey: ['stats', 'networth', 'trend'], queryFn: getNetWorthTrend });

  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">净资产统计</h1>
      <StatsNav />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard title="总资产" value={nw?.totalAssets ?? 0} color="#10B981" />
        <StatCard title="总负债" value={nw?.totalLiab ?? 0} color="#EF4444" />
        <StatCard title="净资产" value={nw?.netWorth ?? 0} color="#1E6FA9" />
      </div>
      <div className="mt-6">
        <ChartCard title="净资产趋势（基于累计盈余）">
          <NetWorthChart data={trend?.history ?? []} />
        </ChartCard>
      </div>
    </div>
  );
}