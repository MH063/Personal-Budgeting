import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/PageHeader';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { formatMoney } from '@/lib/format';
import { ExpandList } from '@/components/common/ExpandList';
import { buildExpenseForecast } from '@/api/predict';
import { buildSubscriptionReminders, nextDueDate, cancellationGuide } from '@/api/subscription';
import { buildAnomalyReport } from '@/api/anomaly';
import { buildDupReport, aiVerifyDuplicates, listDupReviews, saveDupReview, deleteDupReview, type DupSuspect, type DupVerdict, type DupReview } from '@/api/dupDetect';
import { readAIConfig } from '@/stores/useAIStore';
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
 *  - 疑似重复记账（dupDetect：本地候选 + 可选 AI 判定，识别「同商户不同订单号」的重复消费）
 * 核心计算全部本地完成；仅用户主动触发「AI 判定」且允许明细时才上云（文本已脱敏）。
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

/** 疑似重复判定的展示口径（dup=疑似重复 / ok=正常两笔 / uncertain=待核查） */
const DUP_VERDICT_META: Record<DupVerdict, { icon: string; label: string; color: string }> = {
  dup: { icon: '🔴', label: '疑似重复', color: '#EF4444' },
  ok: { icon: '🟢', label: '正常消费', color: '#10B981' },
  uncertain: { icon: '🟡', label: '待核查', color: '#F59E0B' },
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
  // 疑似重复记账：默认本地启发式判定；用户点「AI 判定」后以 AI 结果覆盖展示
  const dup = useQuery({ queryKey: ['insights', 'dup'], queryFn: () => buildDupReport() });
  const [dupVerified, setDupVerified] = useState<DupSuspect[] | null>(null);
  const [dupAiBusy, setDupAiBusy] = useState(false);
  // 判定持久化（dup_reviews 表）：user=人工复核结果（最高优先），ai=AI 判定缓存（刷新不丢）
  const [userReviews, setUserReviews] = useState<Record<string, DupReview>>({});
  const [aiReviews, setAiReviews] = useState<Record<string, DupReview>>({});
  // 「已处理」折叠区展开状态（用户判定的配对可从待处理列表回顾）
  const [processedOpen, setProcessedOpen] = useState(false);

  // 载入本账本已持久化的全部判定（用户 + AI），刷新页面后人工复核结果不丢失
  useEffect(() => {
    void listDupReviews()
      .then((rs) => {
        const user: Record<string, DupReview> = {};
        const ai: Record<string, DupReview> = {};
        for (const r of rs) {
          if (r.source === 'user') user[r.pair_key] = r;
          else ai[r.pair_key] = r;
        }
        setUserReviews(user);
        setAiReviews(ai);
      })
      .catch(() => { /* 库暂不可用时静默，功能降级为纯内存判定 */ });
  }, []);

  // 派生展示：用户已判定的配对移出「待处理」列表（可在已处理中回顾）；
  // 其余待处理配对若已有 AI 判定缓存，用缓存覆盖展示（AI 判定刷新后同样不丢）
  const suspects = dupVerified ?? dup.data ?? [];
  const handled = suspects.filter((s) => userReviews[s.key]);
  const shown = suspects
    .filter((s) => !userReviews[s.key])
    .map((s) => {
      const ai = aiReviews[s.key];
      if (!ai) return s;
      return {
        ...s,
        verdict: ai.verdict,
        source: 'ai' as const,
        reliability: 0.9,
        reason: `AI 判定：${ai.verdict === 'dup' ? '疑似重复' : '正常两笔'}`,
      };
    });

  const [report, setReport] = useState<ReportResult | null>(null);
  const [reporting, setReporting] = useState<'week' | 'month' | null>(null);
  const [cleanInput, setCleanInput] = useState('');
  const [cleanOut, setCleanOut] = useState(cleanTransaction(''));
  const [cleanTouched, setCleanTouched] = useState(false);

  /** AI 判定疑似重复：仅当启用 AI 且允许明细时上云（文本脱敏），否则维持本地判定 */
  async function aiVerifyDups() {
    if (dupAiBusy) return;
    const suspects2 = dupVerified ?? dup.data ?? [];
    if (!suspects2.length) return;
    setDupAiBusy(true);
    try {
      const out = await aiVerifyDuplicates(suspects2);
      setDupVerified(out);
      // AI 判定结果持久化（source='ai' 缓存）：刷新/重进后 AI 判定不丢失，用户判定可覆盖
      for (const s of out) {
        if (s.source === 'ai') {
          try { await saveDupReview(s.key, s.verdict, 'ai'); } catch { /* 单条写入失败不阻断整体 */ }
        }
      }
      setAiReviews((prev) => {
        const next = { ...prev };
        for (const s of out) if (s.source === 'ai') next[s.key] = { pair_key: s.key, verdict: s.verdict, source: 'ai' } as DupReview;
        return next;
      });
      const dups = out.filter((s) => s.verdict === 'dup').length;
      toast.success(`AI 判定完成：${dups} 条疑似重复、${out.length - dups} 条正常/待核查（结果已保存）`);
    } catch (e) {
      toast.error(`AI 判定失败：${(e as Error).message}`);
    } finally {
      setDupAiBusy(false);
    }
  }

  /** 用户人工判定某对疑似重复（确认重复 / 标记正常 / 待核查）：落库持久化，判定后移入「已处理」 */
  async function reviewDupPair(key: string, verdict: DupVerdict) {
    try {
      await saveDupReview(key, verdict, 'user');
      setUserReviews((prev) => ({ ...prev, [key]: { pair_key: key, verdict, source: 'user' } as DupReview }));
      toast.success(verdict === 'ok' ? '已标记为正常消费，不再提示' : verdict === 'dup' ? '已确认重复记账' : '已标记为待核查');
    } catch (e) {
      toast.error(`保存判定失败：${(e as Error).message}`);
    }
  }

  /** 撤销人工判定：删除持久化记录，该配对回到待处理列表重新复核 */
  async function undoDupReview(key: string) {
    try {
      await deleteDupReview(key, 'user');
      setUserReviews((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast.success('已撤销人工判定');
    } catch (e) {
      toast.error(`撤销失败：${(e as Error).message}`);
    }
  }

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
      <section className="flex items-center gap-1.5">
        <Button type="button" onClick={() => useAiAssistantStore.getState().openAssistant()}>💬 打开 AI 助手（连续对话 · 报告 · 体检）</Button>
        <Hint text="仪表盘、智能洞察与月度体检的 AI 能力已合并到此弹窗，同一对话内共享上下文，避免重复调用、重复计费；启用 AI 后仅上送脱敏聚合事实，不上送单笔明细。" />
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
            <ExpandList className="divide-y divide-[var(--border)]" items={sub.items} initial={8} render={(b) => (
              <div key={b.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="text-muted">🔄 {b.label}</span>
                  <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" title={b.isSubscription ? cancellationGuide(b) : `非可取消订阅：${b.reason || ''}`}>{SUB_CATEGORY_LABEL[b.category] ?? '其他'}</span>
                  {b.isSubscription && (
                    <span className="ml-1 text-[10px] text-muted" title={cancellationGuide(b)}>可取消</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted">{b.hits} 个月 · {formatMoney(b.amount)}/月 · 置信 {Math.round(b.confidence * 100)}%</span>
              </div>
            )} />
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

      {/* —— 疑似重复记账（识别「同商户不同订单号」的重复消费：本地启发式 + 可选 AI 判定 + 用户人工复核） —— */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">🔎 疑似重复记账</h3>
          <Button type="button" onClick={aiVerifyDups} disabled={dupAiBusy || !suspects.length}>
            {dupAiBusy ? '判定中…' : '🤖 AI 判定'}
          </Button>
          <span className="text-xs text-muted">
            {readAIConfig().enabled && readAIConfig().allowDetail
              ? 'AI 判定将上云（文本已脱敏）；否则仅本地启发式'
              : 'AI 未开启或未允许发送明细，当前仅本地启发式'}
          </span>
          {handled.length > 0 && <span className="text-xs text-muted">已人工处理 {handled.length} 条</span>}
        </div>
        {dup.isLoading ? (
          <p className="text-sm text-muted">检测中…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted">
            {handled.length > 0 ? '全部疑似重复已处理完毕。' : '未发现短时同商户疑似重复消费。'}
          </p>
        ) : (
          <Card className="divide-y divide-[var(--border)]">
            <ExpandList className="divide-y divide-[var(--border)]" items={shown} initial={8} render={(s) => (
              <div key={s.key} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{s.a.payee || '未知商户'}</b>
                  <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" style={{ color: DUP_VERDICT_META[s.verdict].color }}>
                    {DUP_VERDICT_META[s.verdict].icon} {DUP_VERDICT_META[s.verdict].label}
                  </span>
                  <span className="text-[10px] text-muted">
                    可靠 {Math.round(s.reliability * 100)}% · {s.source === 'ai' ? 'AI 判定' : '本地启发式'}
                  </span>
                </div>
                <div className="mt-1 space-y-0.5 text-xs text-muted">
                  <div>① {s.a.date} · {formatMoney(s.a.amount)} · 订单号{s.a.orderNo ? ` ${s.a.orderNo}` : '：无'}</div>
                  <div>② {s.b.date} · {formatMoney(s.b.amount)} · 订单号{s.b.orderNo ? ` ${s.b.orderNo}` : '：无'}</div>
                </div>
                <div className="mt-1 text-xs">{s.reason}</div>
                {/* 人工复核：不只依赖 AI，用户可自行判定；判定落库，刷新不丢 */}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => reviewDupPair(s.key, 'dup')}>确认重复</Button>
                  <Button size="sm" variant="outline" onClick={() => reviewDupPair(s.key, 'ok')}>标记正常</Button>
                  <Button size="sm" variant="ghost" onClick={() => reviewDupPair(s.key, 'uncertain')}>待核查</Button>
                </div>
              </div>
            )} />
          </Card>
        )}

        {/* 已处理折叠区：用户人工判定的配对（持久化，可展开回顾或撤销重新复核） */}
        {handled.length > 0 && (
          <Card className="mt-2">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium"
              onClick={() => setProcessedOpen(!processedOpen)}
            >
              <span>✓ 已处理 {handled.length} 条疑似重复</span>
              <span className="text-xs text-muted">{processedOpen ? '收起 ▲' : '展开 ▼'}</span>
            </button>
            {processedOpen && (
              <div className="divide-y divide-[var(--border)]">
                {handled.map((s) => (
                  <div key={s.key} className="px-4 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{s.a.payee || '未知商户'}</b>
                      <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10" style={{ color: DUP_VERDICT_META[s.verdict].color }}>
                        {DUP_VERDICT_META[s.verdict].icon} {DUP_VERDICT_META[s.verdict].label}
                      </span>
                      <span className="text-[10px] text-muted">人工判定</span>
                    </div>
                    <div className="mt-1 space-y-0.5 text-xs text-muted">
                      <div>① {s.a.date} · {formatMoney(s.a.amount)} · 订单号{s.a.orderNo ? ` ${s.a.orderNo}` : '：无'}</div>
                      <div>② {s.b.date} · {formatMoney(s.b.amount)} · 订单号{s.b.orderNo ? ` ${s.b.orderNo}` : '：无'}</div>
                    </div>
                    <div className="mt-2">
                      <Button size="sm" variant="ghost" onClick={() => undoDupReview(s.key)}>撤销判定（重新复核）</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </section>
    </div>
  );
}