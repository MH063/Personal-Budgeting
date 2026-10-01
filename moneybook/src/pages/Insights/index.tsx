import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { PageHeader } from '@/components/common/PageHeader';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import { buildExpenseForecast } from '@/api/predict';
import { buildSubscriptionReminders, nextDueDate, cancellationGuide } from '@/api/subscription';
import { buildAnomalyReport } from '@/api/anomaly';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';
import { buildHealthReview } from '@/api/healthScore';
import { buildReport, type ReportResult } from '@/api/report';
import { buildMerchantReport } from '@/api/merchant';
import { cleanTransaction } from '@/api/txnClean';
import MonthlyCheckup from './MonthlyCheckup';
import { getMoneyFlowAnalysis } from '@/api/moneyflow';

/**
 * 智能洞察：聚合展示三类本地规则引擎的结果
 *  - 支出预测与预算建议（predict）
 *  - 订阅 / 重复扣费到期提醒（subscription）
 *  - 反欺诈 / 异常交易（anomaly）
 * 全部为本地计算，无网络、不泄露数据。
 */

const TREND_META = {
  up: { icon: '📈', color: '#EF4444', label: '上升' },
  down: { icon: '📉', color: '#10B981', label: '下降' },
  flat: { icon: '➖', color: '#64748B', label: '平稳' },
} as const;

const ANOMALY_LABEL: Record<string, { icon: string; label: string }> = {
  amount: { icon: '⚠️', label: '金额离群' },
  repeat: { icon: '🔁', label: '重复扣费' },
  probe: { icon: '🛡️', label: '疑似盗刷' },
};

const SUB_CATEGORY_LABEL: Record<string, string> = {
  subscription: '订阅', housing: '住房', personal: '家庭转账', other: '其他',
};

export default function InsightsPage() {
  const forecast = useQuery({ queryKey: ['insights', 'forecast'], queryFn: () => buildExpenseForecast() });
  const subscription = useQuery({ queryKey: ['insights', 'subscription'], queryFn: () => buildSubscriptionReminders() });
  const anomaly = useQuery({ queryKey: ['insights', 'anomaly'], queryFn: () => buildAnomalyReport() });
  const health = useQuery({ queryKey: ['insights', 'health'], queryFn: () => buildHealthReview() });
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

  const f = forecast.data;
  const sub = subscription.data;
  const anom = anomaly.data ?? [];

  const [report, setReport] = useState<ReportResult | null>(null);
  const [reporting, setReporting] = useState<'week' | 'month' | null>(null);
  const [cleanInput, setCleanInput] = useState('');
  const [cleanOut, setCleanOut] = useState(cleanTransaction(''));
  const [cleanTouched, setCleanTouched] = useState(false);

  async function genReport(period: 'week' | 'month') {
    if (reporting) return;
    setReporting(period);
    try {
      const res = await buildReport(period);
      setReport(res);
    } finally {
      setReporting(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="智能洞察"
        description="本地引擎：支出预测、订阅提醒、异常检测、财务问答、健康评分与省钱建议、周/月报、商户画像"
      />

      {/* —— AI 助手统一入口（合并原「财务问答」与月度体检「AI 深度分析」） —— */}
      <section>
        <Button type="button" onClick={() => useAiAssistantStore.getState().openAssistant()}>💬 打开 AI 助手（连续对话 · 报告 · 体检）</Button>
        <p className="mt-2 text-xs text-muted">
          仪表盘、智能洞察与月度体检的 AI 能力已合并到此弹窗，同一对话内共享上下文，避免重复调用、重复计费；
          启用 AI 后仅上送脱敏聚合事实，不上送单笔明细。
        </p>
      </section>

      {/* —— 月度体检（并入智能洞察的统一区块，与各引擎连贯展示） —— */}
      <section>
        <h3 className="mb-2 font-semibold">📋 月度体检</h3>
        <MonthlyCheckup />
      </section>

      {/* —— 交易字段清洗 —— */}
      <section>
        <h3 className="mb-2 font-semibold">🧹 交易字段清洗</h3>
        <Card className="p-4">
          <input
            value={cleanInput}
            onChange={(e) => { setCleanInput(e.target.value); setCleanOut(cleanTransaction(e.target.value)); setCleanTouched(true); }}
            placeholder="粘贴备注/收款方，如：微信支付 100.00 手续费 2.00 优惠 5"
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm outline-none"
          />
          {cleanTouched && (
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              <div className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-muted">实付</div><div className="font-medium">{cleanOut.paid != null ? `¥${cleanOut.paid.toFixed(2)}` : '—'}</div>
              </div>
              <div className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-muted">原价 / 优惠</div>
                <div className="font-medium">{cleanOut.original != null ? `¥${cleanOut.original}` : '—'}{cleanOut.discount ? `（省¥${cleanOut.discount}）` : ''}</div>
              </div>
              <div className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-muted">手续/税费</div>
                <div className="font-medium">{cleanOut.fee != null ? `¥${cleanOut.fee.toFixed(2)}` : '—'}</div>
              </div>
              <div className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-muted">净消费</div><div className="font-medium">{cleanOut.cleanAmount != null ? `¥${cleanOut.cleanAmount.toFixed(2)}` : '—'}</div>
              </div>
              <div className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-muted">支付方式</div><div className="font-medium">{cleanOut.payMethod ? `${cleanOut.payMethod.icon} ${cleanOut.payMethod.name}` : '—'}</div>
              </div>
              <div className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-muted">状态</div>
                <div className="font-medium">{cleanOut.isRefund ? '退款/退货' : '正常'}</div>
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* —— 财务健康评分与省钱建议 —— */}
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
                  {health.data.suggestions.map((s) => (
                    <li key={s.scene} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                      <span className="text-amber-500">💡</span> {s.msg}
                    </li>
                  ))}
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
              <span className="text-muted">上月支出 <b>{formatMoney(f.totalLast)}</b></span>
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
                    <span className="w-24 text-muted">上月 {formatMoney(c.lastActual)}</span>
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

      {/* —— 自动周报/月报 —— */}
      <section>
        <h3 className="mb-2 font-semibold">📄 自动周报 / 月报</h3>
        <Card className="p-4">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={reporting != null} onClick={() => void genReport('week')}>
              {reporting === 'week' ? '生成中…' : '生成周报'}
            </Button>
            <Button variant="outline" size="sm" disabled={reporting != null} onClick={() => void genReport('month')}>
              {reporting === 'month' ? '生成中…' : '生成月报'}
            </Button>
          </div>
          {report && (
            <div className="mt-3 overflow-auto rounded-lg border border-[var(--border)] bg-black/2 px-3 py-2 dark:bg-white/5">
              <div className="mb-1 text-xs text-muted">
                {report.title} · {report.range}{report.source === 'ai' && <span className="ml-1 text-[10px] text-[var(--color-primary-fg)]">AI 总结</span>}
              </div>
              <pre className="whitespace-pre-wrap text-xs leading-relaxed">{report.text}</pre>
            </div>
          )}
        </Card>
      </section>

      {/* —— 商户画像与消费去向 —— */}
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
                {merchant.data.bySpend.map((m) => (
                  <li key={m.name} className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 py-1 last:border-0">
                    <span className="truncate">{m.name}<span className="ml-1 text-muted">·{m.category ?? ''}</span></span>
                    <span className="shrink-0 font-medium">{formatMoney(m.total)}<span className="ml-1 text-[10px] text-muted">{m.count} 笔</span></span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="p-4">
              <h4 className="mb-2 text-sm font-medium">🔁 高频消费商户</h4>
              <ul className="space-y-1.5 text-xs">
                {merchant.data.byFrequency.map((m) => (
                  <li key={m.name} className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 py-1 last:border-0">
                    <span className="truncate">{m.name}</span>
                    <span className="shrink-0 text-muted">{m.count} 次 · 平均 {formatMoney(m.avg)}</span>
                  </li>
                ))}
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

      {/* —— 订阅 / 重复扣费 —— */}
      <section>
        <h3 className="mb-2 font-semibold">🔁 订阅与重复扣费</h3>
        {subscription.isLoading ? (
          <p className="text-sm text-muted">识别中…</p>
        ) : !sub || sub.items.length === 0 ? (
          <p className="text-sm text-muted">未发现明显的月度固定重复扣费。</p>
        ) : (
          <Card className="divide-y divide-[var(--border)]">
            {sub.dueSoon.map((b) => (
              <div key={b.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning,#F59E0B)]" />
                  <b>{b.label}</b>
                  <span className="text-muted">· 每月 {formatMoney(b.amount)}</span>
                  <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" title={b.isSubscription ? cancellationGuide(b) : `非可取消订阅：${b.reason || ''}`}>{SUB_CATEGORY_LABEL[b.category] ?? '其他'}</span>
                </span>
                <span className="text-xs text-[var(--color-warning,#F59E0B)]">将到期 {nextDueDate(b) ?? '--'} · 置信 {Math.round(b.confidence * 100)}%</span>
              </div>
            ))}
            {sub.items.map((b) => (
              <div key={b.key} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="min-w-0">
                  <span className="text-muted">🔄 {b.label}</span>
                  <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" title={b.isSubscription ? cancellationGuide(b) : `非可取消订阅：${b.reason || ''}`}>{SUB_CATEGORY_LABEL[b.category] ?? '其他'}</span>
                  {b.isSubscription && (
                    <span className="ml-1 text-[10px] text-muted" title={cancellationGuide(b)}>可取消</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted">{b.hits} 个月 · {formatMoney(b.amount)}/月 · 置信 {Math.round(b.confidence * 100)}%</span>
              </div>
            ))}
          </Card>
        )}
        {sub && sub.priceUp.length > 0 && (
          <Card className="mt-2 border-[var(--color-warning,#F59E0B)]/40">
            <div className="px-4 py-2.5">
              <div className="mb-1 text-xs font-medium text-[var(--color-warning,#F59E0B)]">⚠️ 订阅变价提醒</div>
              <ul className="space-y-1 text-sm">
                {sub.priceUp.map((c) => (
                  <li key={c.payee} className="flex items-center justify-between">
                    <span>{c.payee}：{formatMoney(c.prevAmount)} → <b>{formatMoney(c.currAmount)}</b>（{Math.round((c.ratio - 1) * 100)}%↑）</span>
                    <span className="text-[10px] text-muted">最近 {c.date ?? '--'}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        )}
      </section>

      {/* —— 异常交易 —— */}
      <section>
        <h3 className="mb-2 font-semibold">🛡️ 异常与疑似风险交易</h3>
        {anomaly.isLoading ? (
          <p className="text-sm text-muted">检测中…</p>
        ) : anom.length === 0 ? (
          <p className="text-sm text-muted">未检测到异常交易。</p>
        ) : (
          <Card className="divide-y divide-[var(--border)]">
            {anom.map((a, i) => (
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
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}