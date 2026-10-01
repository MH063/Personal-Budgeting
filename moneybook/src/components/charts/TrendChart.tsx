import type { EChartsOption } from 'echarts';
import { EChart } from './EChart';

export function TrendChart({ data }: { data: { month: string; income: number; expense: number }[] }) {
  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['收入', '支出'], top: 0 },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: data.map((d) => d.month) },
    yAxis: { type: 'value', axisLabel: { formatter: '¥{value}' } },
    series: [
      {
        name: '收入', type: 'line', smooth: true, data: data.map((d) => d.income),
        itemStyle: { color: '#10B981' }, areaStyle: { opacity: 0.15 },
      },
      {
        name: '支出', type: 'line', smooth: true, data: data.map((d) => d.expense),
        itemStyle: { color: '#EF4444' }, areaStyle: { opacity: 0.15 },
      },
    ],
  };
  return <EChart option={option} height={300} />;
}