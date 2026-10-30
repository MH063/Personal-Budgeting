import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import { StatCard } from '@/components/common/StatCard';
import { ChartCard } from '@/components/common/ChartCard';
import { TrendChart } from '@/components/charts/TrendChart';
import { CategoryPie } from '@/components/charts/CategoryPie';
import { getMonthlySurplus, getCategoryDistribution, getNetWorth, getBudgetVsActual, getInsights } from '@/api/stats';
import { useOverdueLoans } from '@/hooks/useLoans';
import { getTodoItems, type TodoItem } from '@/api/todos';
import { computeSpendable, markShadowedBudgets } from '@/lib/budgetRemaining';
import { formatMoney } from '@/lib/format';
import AiAssistant from '@/components/ai/AiAssistant';
import AdvancedAnalysis from '@/components/ai/AdvancedAnalysis';

export default function Dashboard() {
  const start = dayjs().startOf('month').format('YYYY-MM-DD');
  const end = dayjs().endOf('month').format('YYYY-MM-DD');
  const halfYear = dayjs().subtract(6, 'month').startOf('month').format('YYYY-MM-DD');

  const { data: trend = [] } = useQuery({
    queryKey: ['stats', 'trend', halfYear, end],
    queryFn: () => getMonthlySurplus(halfYear, end),
  });
  const { data: expenseDist = [] } = useQuery({
    queryKey: ['stats', 'pie', 'expense', start, end],
    queryFn: () => getCategoryDistribution('expense', start, end),
  });
  const { data: networth } = useQuery({
    queryKey: ['stats', 'networth'],
    queryFn: getNetWorth,
  });
  const { data: budgetVs = [] } = useQuery({
    queryKey: ['budget', 'vs', dayjs().format('YYYY-MM')],
    queryFn: () => getBudgetVsActual(dayjs().format('YYYY-MM')),
  });
  const { data: overdue = [] } = useOverdueLoans();
  const { data: todos = [] } = useQuery({
    queryKey: ['todos'],
    queryFn: getTodoItems,
  });
  const { data: insights } = useQuery({
    queryKey: ['stats', 'insights', dayjs().format('YYYY-MM')],
    queryFn: () => getInsights(),
  });

  const thisMonth = trend.find((t) => t.month === dayjs().format('YYYY-MM'));
  // 存在总预算时，分类预算只是明细（已被总预算覆盖），不单独计入超支判断，避免同一笔支出重复报警
  const budgetRows = markShadowedBudgets(budgetVs);
  // 本月剩余可花：有预算才展示；无预算时整块隐藏，不用模拟数据占位
  const spendable = computeSpendable(budgetVs);

  // 严重度配色：边框/底色用 color-mix 做透明叠加。
  // 历史缺陷：此前误把 Tailwind 的「/40」透明度语法写进 inline style
  // （如 'var(--color-primary)/40'），该值不是合法 CSS 会被浏览器整条丢弃，
  // 导致边框与底色实际从未生效（亮暗两套主题都受影响）。
  const severityStyles = (s: TodoItem['severity']) =>
    s === 'danger'
      ? { border: 'color-mix(in srgb, var(--color-danger) 50%, transparent)', bg: 'color-mix(in srgb, var(--color-danger) 10%, transparent)', color: 'var(--color-danger)' }
      : s === 'warning'
        ? { border: 'color-mix(in srgb, var(--color-warning, #F59E0B) 50%, transparent)', bg: 'color-mix(in srgb, var(--color-warning, #F59E0B) 10%, transparent)', color: 'var(--color-warning, #F59E0B)' }
        : { border: 'color-mix(in srgb, var(--color-primary) 40%, transparent)', bg: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', color: 'var(--color-primary)' };

  return (
    <div className="space-y-6">
      <AiAssistant />
      {todos.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 flex items-center gap-1.5 font-semibold">
            🔔 待办/提醒
            <span className="rounded-full px-2 py-0.5 text-xs font-normal text-white" style={{ background: 'var(--color-danger)' }}>{todos.length}</span>
          </h3>
          <div className="space-y-2">
            {todos.map((t, i) => {
              const st = severityStyles(t.severity);
              return (
                <Link
                  key={`${t.kind}-${i}`}
                  to={t.link}
                  className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm"
                  style={{ borderColor: st.border, background: st.bg }}
                >
                  <span className="mt-0.5">{t.kind === 'overdue_loan' || t.kind === 'over_budget' ? '⚠️' : t.kind === 'goal_auto' ? '🔄' : '⏰'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium" style={{ color: st.color }}>{t.title}</div>
                    <div className="truncate text-xs text-muted">{t.detail}</div>
                  </div>
                  <span className="shrink-0 text-xs text-muted">前往 →</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {insights && insights.rules.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 font-semibold">💡 智能建议</h3>
            <Link to="/insights" className="text-xs text-muted hover:underline">更多 →</Link>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {insights.rules.slice(0, 4).map((r, i) => {
              const st = severityStyles(r.severity as TodoItem['severity']);
              return (
                <div key={i} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: st.border, background: st.bg }}>
                  {/* 严重=⛔、警告=⚠️、提示=💡：修正此前 warning 误用了无意义字符 🁢 */}
                  <span>{r.severity === 'danger' ? '⛔' : r.severity === 'warning' ? '⚠️' : '💡'}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium" style={{ color: st.color }}>{r.title}</div>
                    <div className="truncate text-xs text-muted">{r.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 深度智能分析：月度异常 + 单笔离群 + 下月支出回归预测 */}
      <AdvancedAnalysis />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="本月收入" value={thisMonth?.income ?? 0} color="#10B981" />
        <StatCard title="本月支出" value={thisMonth?.expense ?? 0} color="#EF4444" />
        <StatCard title="本月盈余" value={thisMonth?.surplus ?? 0} color={(thisMonth?.surplus ?? 0) >= 0 ? '#10B981' : '#EF4444'} />
        <StatCard title="净资产" value={networth?.netWorth ?? 0} color="#1E6FA9" />
      </div>

      {/* 本月剩余可花：预算总额度 − 已用，并折算成「每天还能花多少」 */}
      {spendable.hasBudget && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="font-semibold">本月剩余可花</h3>
              <p className="mt-1 text-xs text-muted">
                {spendable.scope === 'total' ? '按总预算计算' : '按各分类预算合计计算'} · 额度 {formatMoney(spendable.totalBudget)} · 已用 {formatMoney(spendable.spent)}
              </p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold" style={{ color: spendable.overBudget ? 'var(--color-danger)' : '#10B981' }}>
                {formatMoney(spendable.remaining)}
              </div>
              <div className="text-xs text-muted">
                剩余 {spendable.daysLeft} 天 · 日均可用 {formatMoney(spendable.perDay)}
              </div>
            </div>
          </div>
          {spendable.overBudget && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>
              已超出预算 {formatMoney(Math.abs(spendable.remaining))}，建议压缩非必需支出或调整预算。
            </p>
          )}
        </div>
      )}

      {budgetVs.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 font-semibold">本月预算</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {budgetRows.map((b) => {
              const pct = b.budget_amount > 0 ? (b.actual / b.budget_amount) * 100 : 0;
              // 被总预算覆盖的分类行：只作为明细展示，不单独判超支（额度不可与总预算叠加）
              const over = !b.shadowed && b.actual > b.budget_amount;
              return (
                <div key={b.id} className={`rounded-lg border border-[var(--border)] p-3${b.shadowed ? ' opacity-60' : ''}`}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {b.category_icon} {b.category_name ?? '总预算'}
                      {b.shadowed && <span className="ml-1 text-[10px] text-muted">已含于总预算</span>}
                    </span>
                    <span className={over ? 'font-semibold' : 'text-muted'} style={over ? { color: 'var(--color-danger)' } : {}}>
                      {over ? `超支 ${b.actual.toFixed(2)}` : (b.actual / Math.max(b.budget_amount, 1) * 100).toFixed(0) + '%'}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(pct, 100)}%`,
                        background: over ? 'var(--color-danger)' : pct >= 80 ? '#F59E0B' : 'var(--color-primary)',
                      }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-xs text-muted">
                    <span>已用 {b.actual.toFixed(2)}</span>
                    <span>预算 {b.budget_amount.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="近 6 个月收支趋势">
          <TrendChart data={trend} />
        </ChartCard>
        <ChartCard title="本月支出分类">
          <CategoryPie data={expenseDist} />
        </ChartCard>
      </div>
    </div>
  );
}