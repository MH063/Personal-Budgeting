import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '@/components/common/PageHeader';
import { listRecurring, type Recurring } from '@/api/recurring';
import { listGoals, type SavingsGoal } from '@/api/savings';
import { listLoans, getLoanNextDue, type Loan } from '@/api/loans';
import { listTransactionsDetailed, type TransactionDetail } from '@/api/transactions';
import {
  normalizeEvents,
  groupByDay,
  buildEvents,
  type CalendarEvent,
  type CalendarEventKind,
  type LoanDueSrc,
} from '@/lib/calendarEvents';
import { formatMoney } from '@/lib/format';

// 事件类型对应的展示信息：图标 + 颜色 + 「去处理」跳转目标
const KIND_META: Record<CalendarEventKind, { icon: string; color: string; label: string; link: string; action: string }> = {
  recurring: { icon: '🔄', color: 'var(--color-primary)', label: '周期记账', link: '/settings?tab=recurring', action: '去生成' },
  savings: { icon: '🎯', color: '#10B981', label: '储蓄计提', link: '/savings', action: '去计提' },
  loan: { icon: '💳', color: '#F59E0B', label: '借贷还款', link: '/loans', action: '去处理' },
};

const WEEK_HEADER = ['一', '二', '三', '四', '五', '六', '日'];

// 借贷侧：逐笔用 getLoanNextDue 推算本期应还（落在本月的才保留），转成组装层需要的结构
function loansToDue(loans: Loan[]): LoanDueSrc[] {
  const out: LoanDueSrc[] = [];
  for (const loan of loans) {
    if (loan.remaining <= 0.0001) continue;
    const due = getLoanNextDue(loan);
    if (!due?.dueDate) continue;
    out.push({
      id: loan.id,
      direction: loan.direction,
      counterparty: loan.counterparty,
      dueDate: due.dueDate,
      payment: due.payment,
    });
  }
  return out;
}

/** 网格小字用的紧凑金额（万级缩写，避免数字把格子撑破） */
function compactAmt(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

/** 交易类型 → 展示符号与颜色（转账/借还等为中性资金转移，不加正负号） */
function txMeta(type: TransactionDetail['type']): { sign: string; color: string } {
  if (type === 'expense') return { sign: '-', color: 'var(--color-danger)' };
  if (type === 'income') return { sign: '+', color: 'var(--color-success)' };
  return { sign: '', color: 'var(--fg)' };
}

/** 单条计划事件行（含「去处理」直达链接） */
function EventRow({ e }: { e: CalendarEvent }) {
  const meta = KIND_META[e.kind];
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
      <span>{meta.icon}</span>
      <span className="w-20 shrink-0 text-xs text-muted">{e.date.slice(5)}</span>
      <span className="min-w-0 flex-1 truncate">{e.title}</span>
      <span className="shrink-0 font-semibold" style={{ color: meta.color }}>{formatMoney(e.amount)}</span>
      <Link to={meta.link} className="shrink-0 text-xs text-[var(--color-primary-fg)] hover:underline">
        {meta.action} →
      </Link>
    </div>
  );
}

/** 单条实际流水行（分类图标 + 备注/收款方 + 账户 + 带符号金额） */
function FlowRow({ t }: { t: TransactionDetail }) {
  const meta = txMeta(t.type);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
      <span>{t.category_icon || '💳'}</span>
      <span className="min-w-0 flex-1 truncate">{t.note || t.payee || t.category_name || '交易'}</span>
      <span className="shrink-0 text-xs text-muted">{t.account_name}</span>
      <span className="shrink-0 font-semibold" style={{ color: meta.color }}>
        {meta.sign}{formatMoney(t.amount)}
      </span>
    </div>
  );
}

export default function CalendarPage() {
  // 当前锚定月份（切换上/下月时改变）
  const [anchor, setAnchor] = useState<Dayjs>(() => dayjs().startOf('month'));
  // 选中的天（该月几号），null 表示查看全月清单
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // 只读拉取三类「计划」数据源（不做 apply / check 等会写库的副作用）
  const { data: recurring = [] } = useQuery({
    queryKey: ['calendar', 'recurring'],
    queryFn: listRecurring,
  });
  const { data: goals = [] } = useQuery({
    queryKey: ['calendar', 'savings'],
    queryFn: listGoals,
  });
  const { data: loans = [] } = useQuery({
    queryKey: ['calendar', 'loans'],
    queryFn: listLoans,
  });

  const month = anchor.format('YYYY-MM');

  // 实际流水（只读）：网格显示每日收支小字，选中某天时在底部展示当天明细
  const monthEnd = anchor.endOf('month').format('YYYY-MM-DD');
  const { data: monthTxs = [] } = useQuery({
    queryKey: ['calendar', 'txs', month],
    queryFn: () => listTransactionsDetailed({ from: `${month}-01`, to: monthEnd, limit: 1000 }),
  });

  // 组装 + 过滤/排序，dayMap 供网格徽标使用
  const monthEvents = useMemo(
    () => normalizeEvents(buildEvents(month, recurring, goals, loansToDue(loans)), month),
    [month, recurring, goals, loans]
  );
  const dayMap = useMemo(() => groupByDay(monthEvents), [monthEvents]);
  const todayStr = dayjs().format('YYYY-MM-DD');

  // 每日实际收支聚合（day → { expense, income }），用于网格小字与 tooltip
  const dayFlows = useMemo(() => {
    const m: Record<number, { expense: number; income: number }> = {};
    for (const t of monthTxs) {
      if (!t.date.startsWith(month)) continue;
      const d = Number(t.date.slice(8, 10));
      if (!Number.isInteger(d)) continue;
      const e = (m[d] ??= { expense: 0, income: 0 });
      if (t.type === 'expense') e.expense += t.amount;
      else if (t.type === 'income') e.income += t.amount;
    }
    return m;
  }, [monthTxs, month]);

  // 网格：周一为首列，计算首行空白格数，补齐到整周
  const firstOffset = (anchor.date(1).day() + 6) % 7;
  const daysInMonth = anchor.daysInMonth();
  const totalCells = Math.ceil((firstOffset + daysInMonth) / 7) * 7;

  const cells = useMemo(() => {
    const arr: (string | null)[] = [];
    for (let i = 0; i < totalCells; i++) {
      const rel = i - firstOffset + 1;
      arr.push(rel >= 1 && rel <= daysInMonth ? `${month}-${`${rel}`.padStart(2, '0')}` : null);
    }
    return arr;
  }, [month, firstOffset, daysInMonth, totalCells]);

  // 底部「计划」清单：选中某天则只看那天，否则全月
  const listEvents = useMemo(() => {
    if (selectedDay == null) return monthEvents;
    return dayMap[selectedDay] ?? [];
  }, [selectedDay, monthEvents, dayMap]);

  // 底部「流水」清单：仅选中某天时展示
  const selectedTxList = useMemo(() => {
    if (selectedDay == null) return [];
    return monthTxs
      .filter((t) => t.date.startsWith(month) && Number(t.date.slice(8, 10)) === selectedDay)
      .sort((a, b) => b.id - a.id);
  }, [selectedDay, monthTxs, month]);

  // 本月事件按类型的小计（顶部统计条）
  const kindSummary = useMemo(() => {
    const s: Record<CalendarEventKind, number> = { recurring: 0, savings: 0, loan: 0 };
    for (const e of monthEvents) s[e.kind] += 1;
    return s;
  }, [monthEvents]);

  // 本月计划合计金额：一眼看出需要预留多少钱
  const planTotal = useMemo(() => monthEvents.reduce((s, e) => s + e.amount, 0), [monthEvents]);

  return (
    <div>
      <PageHeader
        title="日历视图"
        description="一屏查看每日实际收支与即将到来的计划（周期记账/储蓄计提/借贷还款）；点某天看当天明细，每条计划可直达对应功能处理"
      />

      {/* 月份切换栏 */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setAnchor(anchor.subtract(1, 'month')); setSelectedDay(null); }}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            上一月
          </button>
          <button
            onClick={() => { setAnchor(anchor.add(1, 'month')); setSelectedDay(null); }}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            下一月
          </button>
          <button
            onClick={() => { setAnchor(dayjs().startOf('month')); setSelectedDay(null); }}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5"
          >
            回到本月
          </button>
        </div>
        <div className="text-lg font-bold">{anchor.format('YYYY年M月')}</div>
      </div>

      {/* 类型小计统计条 + 本月计划合计 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        {(Object.keys(kindSummary) as CalendarEventKind[]).map((kind) => (
          <span
            key={kind}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1"
            style={{ background: `${KIND_META[kind].color}1a`, color: KIND_META[kind].color }}
          >
            {KIND_META[kind].icon} {KIND_META[kind].label} ×{kindSummary[kind]}
          </span>
        ))}
        <span className="ml-auto text-muted">
          本月计划合计 <b className="text-sm" style={{ color: 'var(--fg)' }}>{formatMoney(planTotal)}</b>
        </span>
      </div>

      {/* 月历网格：日号 + 计划类型小点 + 当日实际收支小字 */}
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
        <div className="grid grid-cols-7 gap-1">
          {WEEK_HEADER.map((w) => (
            <div key={w} className="pb-1 text-center text-xs font-medium text-muted">
              周{w}
            </div>
          ))}
          {cells.map((dateStr, i) => {
            if (!dateStr) return <div key={`blank-${i}`} className="aspect-square rounded-lg" />;
            const day = Number(dateStr.slice(8, 10));
            const isToday = dateStr === todayStr;
            const isSelected = selectedDay === day && dateStr.startsWith(month);
            const dayEvents = dayMap[day] ?? [];
            const flow = dayFlows[day];
            const planTip = dayEvents.map((e) => `${e.title} ${formatMoney(e.amount)}`).join('；');
            const flowTip = flow ? `实际：支出 ${formatMoney(flow.expense)} · 收入 ${formatMoney(flow.income)}` : '';
            return (
              <button
                key={dateStr}
                onClick={() => setSelectedDay(isSelected ? null : day)}
                className={`relative flex aspect-square flex-col items-center justify-center rounded-lg border text-sm transition-colors
                  ${isToday ? 'border-[var(--color-primary)] font-bold' : 'border-transparent hover:bg-black/5 dark:hover:bg-white/5'}`}
                style={isToday ? { color: 'var(--color-primary-fg)' } : isSelected ? { background: 'var(--color-primary)', color: '#fff' } : {}}
                title={[planTip, flowTip].filter(Boolean).join('；')}
              >
                <span>{day}</span>
                {/* 事件数角标 */}
                {dayEvents.length > 0 && (
                  <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] text-white"
                    style={{ background: 'var(--color-danger)' }}>
                    {dayEvents.length}
                  </span>
                )}
                {/* 计划类型小点 */}
                {dayEvents.length > 0 && (
                  <span className="mt-0.5 flex gap-0.5">
                    {dayEvents.slice(0, 4).map((e) => (
                      <span key={e.id} className="h-1.5 w-1.5 rounded-full" style={{ background: KIND_META[e.kind].color }} />
                    ))}
                  </span>
                )}
                {/* 当日实际收支小字（支出红/收入绿） */}
                {flow && (flow.expense > 0 || flow.income > 0) && (
                  <span className="mt-0.5 flex flex-col items-center text-[9px] leading-tight">
                    {flow.expense > 0 && <span style={{ color: 'var(--color-danger)' }}>-{compactAmt(flow.expense)}</span>}
                    {flow.income > 0 && <span style={{ color: 'var(--color-success)' }}>+{compactAmt(flow.income)}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 底部面板：全月 → 计划清单；选中某天 → 当日流水 + 当日计划 */}
      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        {selectedDay == null ? (
          <>
            <h3 className="mb-3 font-semibold">
              本月待办计划
              <span className="ml-1 text-xs font-normal text-muted">共 {monthEvents.length} 项 · 合计 {formatMoney(planTotal)}</span>
            </h3>
            {monthEvents.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">本月暂无计划中的事件</div>
            ) : (
              <div className="space-y-2">
                {monthEvents.map((e) => <EventRow key={e.id} e={e} />)}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">
                {month}月{selectedDay}日
              </h3>
              <button onClick={() => setSelectedDay(null)} className="text-xs text-[var(--color-primary-fg)] hover:underline">
                返回全月
              </button>
            </div>

            {/* 当日实际流水 */}
            <h4 className="mb-2 text-xs font-medium text-muted">
              当日流水（{selectedTxList.length} 笔）
            </h4>
            {selectedTxList.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted">当天没有记账记录</p>
            ) : (
              <div className="space-y-2">
                {selectedTxList.map((t) => <FlowRow key={t.id} t={t} />)}
              </div>
            )}

            {/* 当日计划 */}
            <h4 className="mb-2 mt-4 text-xs font-medium text-muted">
              当日计划（{listEvents.length} 项）
            </h4>
            {listEvents.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted">当天没有计划中的事件</p>
            ) : (
              <div className="space-y-2">
                {listEvents.map((e) => <EventRow key={e.id} e={e} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}