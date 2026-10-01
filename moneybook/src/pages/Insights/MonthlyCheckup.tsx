import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { analyzeLocally, type LocalDiagnosis, type AnalysisDimension } from '@/api/analysis';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';
import { getKV, setKV } from '@/api/kv';
import { DIM_KEY } from '@/lib/constants';
import { StatCard } from '@/components/common/StatCard';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/**
 * 月度体检：由原"统计 → 洞察"迁入智能洞察页的区块组件。
 * 承载：按维度分析、收支结构、支出去向集中度、趋势与资产、预算执行、本地自主建议、
 *       AI 深度分析（体检/预算/下月预测）与写预算。
 * 说明：健康分以"综合健康评分（computeHealthScore）"为唯一口径，此处"支出健康度"
 *       明确标注为其子指标，避免 36 vs 72 的困惑。
 */

const scoreColor = (s: number) => (s >= 80 ? '#10B981' : s >= 60 ? '#3B82F6' : s >= 40 ? '#F59E0B' : '#EF4444');

const DIM_LABEL: Record<AnalysisDimension, string> = { category: '分类', account: '账户', tag: '标签', amount: '金额区间', week: '周' };
const DIM_OPTIONS: { value: AnalysisDimension; label: string }[] = [
  { value: 'category', label: '按分类' },
  { value: 'account', label: '按账户' },
  { value: 'tag', label: '按标签' },
  { value: 'amount', label: '按金额区间' },
  { value: 'week', label: '按周' },
];
const DIM_STORE_KEY = DIM_KEY;

const priorityMeta: Record<1 | 2 | 3, { label: string; color: string; border: string; bg: string }> = {
  1: { label: '高优先', color: '#EF4444', border: 'var(--color-danger)/40', bg: 'var(--color-danger)/10' },
  2: { label: '中优先', color: '#F59E0B', border: 'rgba(245,158,11,.4)', bg: 'rgba(245,158,11,.1)' },
  3: { label: '低优先', color: 'var(--color-primary)', border: 'var(--color-primary)/40', bg: 'var(--color-primary)/10' },
};

function diffColor(v: number | null) {
  if (v === null) return 'var(--muted)';
  return v >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
}

export default function MonthlyCheckup() {
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  // 记忆上次分析维度（settings 表 kv.stats.dim）
  const [dim, setDim] = useState<AnalysisDimension>(() => {
    const saved = getKV(DIM_STORE_KEY);
    const hit = DIM_OPTIONS.find((o) => o.value === saved);
    return hit ? hit.value : 'category';
  });
  useEffect(() => { setKV(DIM_STORE_KEY, dim); }, [dim]);
  const { data, isLoading } = useQuery({
    queryKey: ['stats', 'local-diagnosis', month, dim],
    queryFn: () => analyzeLocally(month, { dimension: dim }),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-0.5">
          {DIM_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setDim(o.value)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${dim === o.value ? 'bg-[var(--color-primary)] text-white' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading || !data ? (
        <p className="py-10 text-center text-sm text-muted">分析中…</p>
      ) : (
        <>
          <LocalDiagnosisPanel d={data} />
          {/* AI 深度分析已并入全局 AI 助手弹窗（避免与仪表盘/智能洞察重复调用、重复计费），
              入口会把当前选择的月份与维度带入弹窗，体检/预测据此分析对应月份 */}
          <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold">🤖 AI 深度分析（体检 / 下月预测 / 预算建议）</h3>
                <div className="text-xs text-muted">
                  在本地诊断之上，由 AI 完成归因解释与前瞻；仅上送脱敏汇总（不含单笔明细）。已统一到全局 AI 助手弹窗，
                  将以当前选择的月份与维度进行分析。
                </div>
              </div>
              <Button size="sm" onClick={() => useAiAssistantStore.getState().openAssistant({ month, dim })}>
                打开 AI 助手
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 本地自主分析 + 建议（纯本地规则，不依赖 AI） */
function LocalDiagnosisPanel({ d }: { d: LocalDiagnosis }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="本月收入" value={d.income} color="#10B981" />
        <StatCard title="本月支出" value={d.expense} color="#EF4444" />
        <StatCard title="本月结余" value={d.surplus} color={d.surplus >= 0 ? '#10B981' : '#F59E0B'} />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="text-xs text-muted">支出健康度（综合评分子指标）</div>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-bold" style={{ color: scoreColor(d.healthScore) }}>{d.healthScore}</span>
            <span className="mb-1 text-sm text-muted">{d.scoreLabel}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div className="h-full rounded-full" style={{ width: `${d.healthScore}%`, background: scoreColor(d.healthScore) }} />
          </div>
          <p className="mt-1 text-[10px] text-muted">综合健康评分以「❤️ 财务健康评分」为准，本指标为其构成之一。</p>
        </div>
      </div>

      {/* 结构 & 集中度 & 走势 */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="mb-2 text-sm font-semibold">收支结构</div>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted">刚性支出</span><span>¥{d.fixedExpense.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted">弹性支出</span><span>¥{d.flexibleExpense.toFixed(2)}</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div className="h-full rounded-full" style={{ width: `${d.fixedRatio * 100}%`, background: 'var(--color-primary)' }} />
            </div>
            <div className="flex justify-between text-xs text-muted"><span>刚性占比 {(d.fixedRatio * 100).toFixed(0)}%</span><span>储蓄率 {(d.savingsRate * 100).toFixed(1)}%</span></div>
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="mb-2 text-sm font-semibold">支出去向集中度（按{DIM_LABEL[d.dimension]}）</div>
          {d.topExpense.length === 0 ? (
            <p className="text-sm text-muted">本月无支出。</p>
          ) : (
            <>
              <div className="space-y-1 text-sm">
                {d.topExpense.map((c) => (
                  <div key={c.name} className="flex justify-between">
                    <span className="truncate">{c.icon}{c.name}</span>
                    <span className="text-muted">¥{c.total.toFixed(2)} · {c.ratio}%</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">首位占 {d.top1Ratio}%，前 5 位累计 {d.top5Ratio}%</p>
            </>
          )}
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="mb-2 text-sm font-semibold">趋势与资产</div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted">支出环比</span><span style={{ color: diffColor(d.expMomPct) }}>{d.expMomPct === null ? '—' : `${d.expMomPct > 0 ? '+' : ''}${d.expMomPct}%`}</span></div>
            <div className="flex justify-between"><span className="text-muted">支出同比</span><span style={{ color: diffColor(d.expYoYPct) }}>{d.expYoYPct === null ? '—' : `${d.expYoYPct > 0 ? '+' : ''}${d.expYoYPct}%`}</span></div>
            <div className="flex justify-between"><span className="text-muted">净资产变化</span><span style={{ color: diffColor(d.netWorthChangePct) }}>{d.netWorthChangePct === null ? '—' : `${d.netWorthDelta >= 0 ? '+' : ''}¥${d.netWorthDelta.toFixed(2)}（${d.netWorthChangePct}%）`}</span></div>
            <div className="flex justify-between"><span className="text-muted">预算执行</span><span>{d.budgetOverCount} 超支 · {d.budgetAlertCount} 近上限</span></div>
          </div>
        </div>
      </div>

      {/* 本地建议 */}
      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">🧭 本地自主建议（不依赖 AI）</h3>
          <span className="text-xs text-muted">本地规则即时生成，始终可用</span>
        </div>
        {d.advice.length === 0 ? (
          <p className="text-sm text-muted">本月暂无特别建议。</p>
        ) : (
          <div className="space-y-2">
            {/* 去重：储蓄率结论已由「财务健康评分」factors 统一呈现，避免同页重复出现 */}
            {d.advice.filter((a) => !/储蓄率/.test(a.title)).map((a, i) => {
              const p = priorityMeta[a.priority];
              return (
                <div key={i} className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm" style={{ borderColor: p.border, background: p.bg }}>
                  <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs text-white" style={{ background: p.color }}>{p.label}</span>
                  <div className="min-w-0">
                    <div className="font-medium" style={{ color: p.color }}>{a.title}</div>
                    <div className="text-xs leading-relaxed text-muted">{a.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}