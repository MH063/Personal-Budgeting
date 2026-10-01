// 深度智能分析（ex5）展示卡片
// -----------------------------------------------------------------------------
// 在「智能建议」下新增「深度分析」：展示 月度支出异常突增、单笔交易离群、
// 以及基于线性回归的下月支出预测。数据来自 stats.getAdvancedAnalysis ，
// 统计逻辑集中在 lib/analytics.ts（纯函数，可测）。
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { getAdvancedAnalysis } from '@/api/stats';

const money = (n: number) => `¥${n.toFixed(2)}`;

export default function AdvancedAnalysis() {
  const ym = dayjs().format('YYYY-MM');
  const { data } = useQuery({
    queryKey: ['advanced-analysis', ym],
    queryFn: () => getAdvancedAnalysis(ym),
  });

  // 数据尚未就绪或完全没有异常/预测时，不渲染该区块，避免空卡片干扰
  if (!data) return null;
  const hasAny = data.anomalies.length > 0 || data.txAnomalies.length > 0;
  if (!hasAny && data.forecast.direction === 'flat') return null;

  const trendTxt =
    data.forecast.direction === 'up' ? '📈 预计上涨'
      : data.forecast.direction === 'down' ? '📉 预计回落'
        : '➖ 基本平稳';

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="mb-3 flex items-center gap-1.5 font-semibold">🔬 深度分析</h3>

      {/* 下月支出预测 */}
      <div className="mb-3 flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
        <span className="text-muted">下月支出预测</span>
        <span className="inline-flex items-center gap-2 font-semibold">
          <span>{trendTxt}</span>
          <span>{money(data.forecast.next)}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {/* 月度支出异常 */}
        {data.anomalies.map((a, i) => (
          <div key={`a-${i}`} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: a.level === 'danger' ? 'var(--color-danger)/50' : 'var(--color-warning, #F59E0B)/50',
              background: a.level === 'danger' ? 'var(--color-danger)/10' : 'var(--color-warning, #F59E0B)/10',
            }}>
            <span>{a.level === 'danger' ? '⚠️' : '🁢'}</span>
            <div className="min-w-0">
              <div className="font-medium">{a.label} 支出 {money(a.value)}</div>
              <div className="text-xs text-muted">较前几期均值 {money(a.baseline)} 增长 {Math.round(a.diffRatio * 100)}%</div>
            </div>
          </div>
        ))}

        {/* 单笔交易离群 */}
        {data.txAnomalies.map((t, i) => (
          <div key={`t-${i}`} className="flex items-start gap-2 rounded-lg border border-[var(--color-warning, #F59E0B)/50] bg-[var(--color-warning, #F59E0B)/10] px-3 py-2 text-sm">
            <span>🔎</span>
            <div className="min-w-0">
              <div className="font-medium">{t.categoryName} 单笔 {money(t.amount)}</div>
              <div className="text-xs text-muted">为该分类均值 {money(t.baseline)} 的 {t.multiple} 倍</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}