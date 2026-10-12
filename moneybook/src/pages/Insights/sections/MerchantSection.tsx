import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Card } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { ExpandList } from '@/components/common/ExpandList';
import { buildMerchantReport } from '@/api/merchant';
import { getMoneyFlowAnalysis } from '@/api/moneyflow';

/**
 * 商户画像与消费去向区块：
 *  - 按「消费金额」「消费频次」两个视角聚合商户；
 *  - 另给近 3 个月按分类的消费去向（与统计页「资金去向」同口径，便于双视角对齐）。
 * （自「智能洞察」页拆出，展示与交互保持不变。）
 */
export default function MerchantSection() {
  const merchant = useQuery({ queryKey: ['insights', 'merchant'], queryFn: () => buildMerchantReport() });
  // 按分类消费去向（与统计「资金去向」同口径），供与「按商户」双视角对齐
  const catFlow = useQuery({
    queryKey: ['insights', 'cat-flow'],
    queryFn: () => getMoneyFlowAnalysis({
      dimension: 'category',
      from: dayjs().subtract(3, 'month').startOf('month').format('YYYY-MM-DD'),
      to: dayjs().endOf('day').format('YYYY-MM-DD'),
    }),
  });

  return (
    <section>
      <h3 className="mb-2 font-semibold">🏪 商户画像与消费去向</h3>
      {merchant.isLoading ? (
        <p className="text-sm text-muted">聚合中…</p>
      ) : !merchant.data || merchant.data.bySpend.length === 0 ? (
        <p className="text-sm text-muted">暂无带收款方的支出记录。</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h4 className="mb-2 text-sm font-medium">🛍️ 消费金额 TOP</h4>
            <ul className="space-y-1.5 text-xs">
              <ExpandList className="space-y-1.5" items={merchant.data.bySpend} initial={8} render={(m) => (
                <li key={m.name} className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 py-1 last:border-0">
                  <span className="truncate">{m.name}<span className="ml-1 text-muted">·{m.category ?? ''}</span></span>
                  <span className="shrink-0 font-medium">{formatMoney(m.total)}<span className="ml-1 text-[10px] text-muted">{m.count} 笔</span></span>
                </li>
              )} />
            </ul>
          </Card>
          <Card className="p-4">
            <h4 className="mb-2 text-sm font-medium">🔁 高频消费商户</h4>
            <ul className="space-y-1.5 text-xs">
              <ExpandList className="space-y-1.5" items={merchant.data.byFrequency} initial={8} render={(m) => (
                <li key={m.name} className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 py-1 last:border-0">
                  <span className="truncate">{m.name}</span>
                  <span className="shrink-0 text-muted">{m.count} 次 · 平均 {formatMoney(m.avg)}</span>
                </li>
              )} />
            </ul>
          </Card>
        </div>
      )}

      {/* 按分类消费去向 —— 与统计「资金去向」同口径，与「按商户」互为视图 */}
      {catFlow.data && (catFlow.data.items ?? []).some((i) => i.expense > 0) && (
        <Card className="mt-4 p-4">
          <h4 className="mb-2 text-sm font-medium">🧭 按分类消费去向（近 3 月 · 与统计「资金去向」同口径）</h4>
          <ul className="space-y-1.5 text-xs">
            {(catFlow.data.items ?? []).filter((i) => i.expense > 0).slice(0, 8).map((i) => (
              <li key={i.label} className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 py-1 last:border-0">
                <span className="truncate">{i.label}</span>
                <span className="shrink-0 font-medium" style={{ color: '#EF4444' }}>{formatMoney(i.expense)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
