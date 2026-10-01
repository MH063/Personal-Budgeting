import type { EChartsOption } from 'echarts';
import { EChart } from './EChart';

export function CategoryPie({ data }: { data: { name: string; total: number; color: string }[] }) {
  const option: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
    legend: { bottom: 0 },
    series: [{
      name: '分类', type: 'pie', radius: ['40%', '70%'], center: ['50%', '44%'],
      data: data.map((d) => ({ name: d.name, value: d.total, itemStyle: { color: d.color } })),
      label: { formatter: '{b}\n{d}%' },
      labelLine: { length: 8, length2: 8 },
    }],
  };
  return <EChart option={option} height={300} />;
}