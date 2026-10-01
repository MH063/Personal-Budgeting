import type { EChartsOption } from 'echarts';
import { EChart } from './EChart';

export function NetWorthChart({ data }: { data: { month: string; net_worth: number }[] }) {
  const option: EChartsOption = {
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => `¥${Number(v).toFixed(2)}` },
    grid: { left: 60, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: data.map((d) => d.month) },
    yAxis: { type: 'value', axisLabel: { formatter: '¥{value}' } },
    series: [{
      name: '净资产', type: 'line', smooth: true, areaStyle: { opacity: 0.2 },
      data: data.map((d) => d.net_worth),
      itemStyle: { color: '#1E6FA9' },
    }],
  };
  return <EChart option={option} height={300} />;
}