import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { ExpandList } from '@/components/common/ExpandList';
import { buildHealthReview } from '@/api/healthScore';
import { buildExpenseForecast } from '@/api/predict';

/** 支出趋势 → 图标、颜色与中文标签（上升 / 下降 / 平稳） */
const TREND_META = {
  up: { icon: '📈', color: '#EF4444', label: '上升' },
  down: { icon: '📉', color: '#10B981', label: '下降' },
  flat: { icon: '➖', color: '#64748B', label: '平稳' },
} as const;

/**
 * 评估与预算区块：财务健康评分（含分项因子）、可削减的弹性支出建议、
 * 以及下月支出预测与建议预算（含按分类的环比趋势与样本可靠度）。
 * 「可靠度」为基于样本量与波动的启发式估算，非预测准确率。
 * （自「智能洞察」页拆出，展示与交互保持不变。）
 */
export default function HealthBudgetSection() {
  const health = useQuery({ queryKey: ['insights', 'health'], queryFn: () => buildHealthReview() });
  const forecast = useQuery({ queryKey: ['insights', 'forecast'], queryFn: () => buildExpenseForecast() });
  const f = forecast.data;

  return (
    <section>
      <h3 className="mb-2 font-semibold">🎯 评估与预算（健康评分 · 省钱建议 · 下月预测）</h3>
      {health.isLoading ? (
        <p className="text-sm text-muted">评估中…</p>
      ) : health.data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <div className="flex items-center gap-4">
              <div
                className="flex h-16 w-16 items-center justify-center rounded-full text-lg font-bold text-white"
                style={{ background: health.data.score.score >= 80 ? '#10B981' : health.data.score.score >= 60 ? '#F59E0B' : '#EF4444' }}
              >
                {health.data.score.score}
              </div>
              <div>
                <div className="font-semibold">{health.data.score.label}</div>
                <div className="text-xs text-muted">综合本地指标评分（0-100）</div>
              </div>
            </div>
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {health.data.score.factors.map((x) => (
                <li key={x.name} className="flex justify-between gap-2 border-b border-[var(--border)]/60 py-1 last:border-0">
                  <span>{x.note}</span>
                  <span style={{ color: x.delta >= 0 ? '#10B981' : '#EF4444' }}>{x.delta >= 0 ? `+${x.delta}` : x.delta}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4">
            <h4 className="mb-2 text-sm font-medium">💰 可省之处</h4>
            {health.data.suggestions.length === 0 ? (
              <p className="text-xs text-muted">暂无可削减的弹性支出建议。</p>
            ) : (
              <ul className="space-y-2">
                <ExpandList className="space-y-2" items={health.data.suggestions} initial={5} render={(s) => (
                  <li key={s.scene} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                    <span className="text-amber-500">💡</span> {s.msg}
                  </li>
                )} />
              </ul>
            )}
          </Card>
        </div>
      ) : (
        <p className="text-sm text-muted">暂无法评估。</p>
      )}
      {/* 下月支出预测与预算建议 —— 与健康评分/省钱建议同属「评估与预算」 */}
      {forecast.isLoading ? (
        <p className="mt-4 text-sm text-muted">计算下月预测中…</p>
      ) : !f || f.categories.length === 0 ? (
        <p className="mt-4 text-sm text-muted">暂无足够历史支出数据。</p>
      ) : (
        <Card className="mt-4 p-4">
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            <span className="text-muted">上月支出（分期摊销后） <b>{formatMoney(f.totalLast)}</b></span>
            <span className="text-muted">下月预测 <b className="text-[var(--color-primary-fg)]">{formatMoney(f.totalPredicted)}</b></span>
            <span className="text-muted">
              变化 <b style={{ color: f.totalPredicted >= f.totalLast ? '#EF4444' : '#10B981' }}>
                {f.totalPredicted >= f.totalLast ? '+' : ''}{formatMoney(f.totalPredicted - f.totalLast)}
              </b>
            </span>
          </div>
          <div className="space-y-2">
            {f.categories.map((c) => {
              const m = TREND_META[c.trend];
              return (
                <div key={c.name} className="flex items-center gap-2 py-1 text-sm">
                  <span className="w-24 shrink-0 truncate">{c.icon} {c.name}</span>
                  <span className="w-24 text-muted">上月（含分摊） {formatMoney(c.lastActual)}</span>
                  <span className="w-24 font-medium">预测 {formatMoney(c.predicted)}</span>
                  <span className="w-14">
                    {m.icon} {c.momPct != null ? `${c.momPct > 0 ? '+' : ''}${c.momPct}%` : m.label}
                  </span>
                  <span className="text-xs text-muted">建议预算 {formatMoney(c.suggestedBudget)}</span>
                  {c.sampleMonths < 3 ? (
                    <span className="text-[10px] text-muted" title="样本不足 3 个月，暂不显示可靠度">数据不足</span>
                  ) : (
                    <span className="text-[10px] text-[var(--color-primary-fg)]" title="可靠度＝基于样本量与波动的启发式估算，非预测准确率；样本月份数越多越可信">
                      可靠 {Math.round(c.reliability * 100)}% · {c.sampleMonths} 个月
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </section>
  );
}
