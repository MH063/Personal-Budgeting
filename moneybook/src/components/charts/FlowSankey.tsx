import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import { EChart } from './EChart';
import type { CashFlow } from '@/api/stats';

// 收入/支出使用 `收入 · ` / `支出 · ` 前缀，账户无前缀
function nameColor(name: string): string {
  if (name.startsWith('收入')) return '#10B981';
  if (name.startsWith('支出')) return '#EF4444';
  return '#64748B'; // 账户
}

export function FlowSankey({ data }: { data: CashFlow }) {
  const option = useMemo<EChartsOption>(() => {
    const nodes = data.nodes.map((n) => ({ name: n.name, itemStyle: { color: nameColor(n.name) } }));
    const links = data.links.map((l) => ({
      source: l.source,
      target: l.target,
      value: l.value,
      itemStyle: { color: l.color, opacity: 0.55 },
      lineStyle: { color: l.color, opacity: 0.4, width: 1 },
    }));
    return {
      toolbox: { feature: { saveAsImage: { title: '保存图片' } } },
      tooltip: { trigger: 'item', triggerOn: 'mousemove', formatter: '{b}: ¥{c}' },
      series: [{
        type: 'sankey',
        left: 30, right: 30, top: 20, bottom: 30,
        nodeAlign: 'justify',
        nodeWidth: 14,
        nodeGap: 12,
        emphasis: { focus: 'adjacency' },
        label: { show: true, fontSize: 11 },
        data: nodes,
        links,
      }],
    };
  }, [data]);

  if (data.links.length === 0) {
    return <p className="py-10 text-center text-sm text-muted">当前区间内暂无收入/支出/转账记录</p>;
  }
  return <EChart option={option} height={480} />;
}