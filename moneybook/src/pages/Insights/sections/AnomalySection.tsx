import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import { ExpandList } from '@/components/common/ExpandList';
import { buildAnomalyReport } from '@/api/anomaly';

/** 异常类型 → 图标与中文标签（金额离群 / 重复扣费 / 疑似盗刷） */
const ANOMALY_LABEL: Record<string, { icon: string; label: string }> = {
  amount: { icon: '⚠️', label: '金额离群' },
  repeat: { icon: '🔁', label: '重复扣费' },
  probe: { icon: '🛡️', label: '疑似盗刷' },
};

/**
 * 异常与疑似风险交易区块：本地规则引擎检测金额离群、重复扣费与疑似盗刷，
 * 展示「可靠度」为按规则强度（z 值／次数）估算的启发式分数，非真实准确率。
 * （自「智能洞察」页拆出，数据由 react-query 缓存按同一 queryKey 共享。）
 */
export default function AnomalySection() {
  const anomaly = useQuery({ queryKey: ['insights', 'anomaly'], queryFn: () => buildAnomalyReport() });
  const anom = anomaly.data ?? [];

  return (
    <section>
      <h3 className="mb-2 font-semibold">🛡️ 异常与疑似风险交易</h3>
      {anomaly.isLoading ? (
        <p className="text-sm text-muted">检测中…</p>
      ) : anom.length === 0 ? (
        <p className="text-sm text-muted">未检测到异常交易。</p>
      ) : (
        <Card className="divide-y divide-[var(--border)]">
          <ExpandList className="divide-y divide-[var(--border)]" items={anom} initial={8} render={(a, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                <span>{ANOMALY_LABEL[a.kind]?.icon ?? '⚠️'}</span>
                <b>{a.payee || '未知'}</b>
                <span style={{ color: '#EF4444' }}>{formatMoney(a.amount)}</span>
              </span>
              <span className="text-xs text-muted">{a.date} · {ANOMALY_LABEL[a.kind]?.label ?? a.kind}：{a.reason}</span>
              <span className="ml-2 text-[10px] text-[var(--color-primary-fg)]" title="可靠度＝按规则强度（z 值/次数）估算的启发式分数，非准确率">
                可靠 {Math.round(a.reliability * 100)}%
              </span>
            </div>
          )} />
        </Card>
      )}
    </section>
  );
}
