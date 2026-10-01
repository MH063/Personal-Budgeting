import { useMemo, useState, useEffect } from 'react';
import { Modal } from '@/components/ui/modal';
import { formatMoney, formatDate } from '@/lib/format';
import { calcScheduleProgress, calcSchedule, listRepayments } from '@/api/loans';
import { todayStr, type Loan } from '@/api/loans';
import { useLoans } from '@/hooks/useLoans';

const STATUS_META: Record<string, { label: string; color: string; bar: string }> = {
  paid: { label: '已还', color: '#10B981', bar: '#10B981' },
  current: { label: '本期', color: '#F59E0B', bar: '#F59E0B' },
  upcoming: { label: '待还', color: '#1E6FA9', bar: '#1E6FA9' },
  overdue: { label: '逾期', color: '#EF4444', bar: '#EF4444' },
};

/** 对比模式下为每笔借贷分配一个固定颜色，便于在一张图上区分 */
const SERIES_COLORS = ['#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#6366F1'];

const DAY = 86400000;
const pad = (n: number) => `${n}`.padStart(2, '0');
const toTs = (s?: string | null) => (s ? new Date(`${s}T00:00:00`).getTime() : 0);
function monthKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function monthLabel(key: string) {
  const [y, m] = key.split('-');
  return `${y}-${m}`;
}

interface GanttModel {
  loan: Loan;
  rows: ({ period: number; dueDate: string; payment: number; status: string; startTs: number })[];
  axisStartTs: number;
  axisEndTs: number;
  color: string;
}
interface DrillTarget {
  loan: Loan;
  row: { period: number; dueDate: string; payment: number; principal: number; interest: number; status: string };
}
interface RepaymentRow { amount: number; interest: number; period: number | null; date: string; note: string }
type DrillState = DrillTarget & { repayments?: RepaymentRow[] };

/** 借贷还款计划甘特图：支持多笔并列对比、月份折叠、点击期次查看账单明细 */
export function LoanGantt({
  loan, open, onOpenChange, allLoans: allLoansProp,
}: {
  loan: Loan | null; open: boolean; onOpenChange: (v: boolean) => void; allLoans?: Loan[];
}) {
  const today = todayStr();
  const fallbackLoans = useLoans();
  const allLoans = allLoansProp ?? fallbackLoans.data ?? [];

  // 默认选中当前单笔；对比模式下可勾选多笔
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [showCompare, setShowCompare] = useState(false);

  // 当前打开的这笔作为基准（进入时若未选中，将其加入）
  useEffect(() => {
    if (open && loan && !selected.has(loan.id)) {
      setSelected((s) => new Set(s).add(loan.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loan?.id]);

  // 为选中的每笔构建模型，并求统一的全局时间轴
  const { models, axisStartTs, axisEndTs } = useMemo(() => {
    const list = allLoans.filter((l) => selected.has(l.id));
    const built: GanttModel[] = list.map((l, i) => {
      const progress = calcScheduleProgress(l, today);
      const rows = progress.map((p, idx) => ({
        period: p.row.period,
        dueDate: p.row.dueDate,
        payment: p.row.payment,
        status: p.status,
        startTs: idx === 0 ? toTs(l.date) : toTs(progress[idx - 1].row.dueDate),
      }));
      // 本期跨度为今天线到到期日之间的最小条宽（当前期在前半段），保证可视性
      return { loan: l, rows, color: SERIES_COLORS[i % SERIES_COLORS.length], axisStartTs: 0, axisEndTs: 0 };
    });
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const m of built) {
      for (const r of m.rows) {
        minTs = Math.min(minTs, r.startTs, toTs(r.dueDate));
        maxTs = Math.max(maxTs, toTs(r.dueDate));
      }
    }
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) {
      minTs = toTs(today); maxTs = toTs(today) + DAY;
    }
    // 取整月边界
    const axisStartTs = new Date(new Date(minTs).getFullYear(), new Date(minTs).getMonth(), 1).getTime();
    const axisEndTs = new Date(new Date(maxTs).getFullYear(), new Date(maxTs).getMonth() + 1, 0).getTime();
    for (const m of built) { m.axisStartTs = axisStartTs; m.axisEndTs = axisEndTs; }
    return { models: built, axisStartTs, axisEndTs };
  }, [allLoans, selected, today]);

  const range = Math.max(axisEndTs - axisStartTs, DAY);
  const clampTs = (ts: number) => Math.min(axisEndTs, Math.max(axisStartTs, ts));
  const pct = (ts: number) => ((clampTs(ts) - axisStartTs) / range) * 100;
  const todayTs = toTs(today);
  const todayInRange = todayTs >= axisStartTs && todayTs <= axisEndTs;

  // 顶部月刻度
  const monthTicks = useMemo(() => {
    const ticks: { label: string; left: number }[] = [];
    const cursor = new Date(axisStartTs);
    while (cursor.getTime() <= axisEndTs + DAY / 2) {
      ticks.push({ label: `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`, left: pct(cursor.getTime()) });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return ticks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axisStartTs, axisEndTs, range]);

  // 按月分组：每月的"期次"，供折叠。仅当选中 >=2 笔时才启用月份分组与折叠。
  const monthGroups = useMemo(() => {
    const map = new Map<string, { ts: number; items: { model: GanttModel; row: GanttModel['rows'][number] }[] }>();
    for (const m of models) {
      for (const r of m.rows) {
        const ts = toTs(r.dueDate);
        const key = monthKey(ts);
        if (!map.has(key)) map.set(key, { ts, items: [] });
        map.get(key)!.items.push({ model: m, row: r });
      }
    }
    return [...map.entries()].sort((a, b) => a[1].ts - b[1].ts).map(([key, v]) => ({ key, ...v }));
  }, [models]);

  // ------------------------------------------------------------------
  if (!open || !loan) return null;
  const isInstallmentAcross = models.some((m) => m.rows.length > 1);

  async function openDrill(target: DrillTarget) {
    let repayments: RepaymentRow[] = [];
    try {
      repayments = await listRepayments(target.loan.id);
    } catch { /* 忽略 */ }
    setDrill({ ...target, repayments });
  }

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title="还款计划甘特图" wide>
      <div className="space-y-4">
        {/* 工具栏：对比开关 + 多选 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            {Object.entries(STATUS_META).map(([k, m]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: m.bar }} />
                {m.label}
              </span>
            ))}
            <span className="text-[10px]">· 今日</span>
          </div>
          <button
            onClick={() => setShowCompare((v) => !v)}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-muted hover:bg-black/5 dark:hover:bg-white/5"
          >
            {showCompare ? '收起对比' : '多笔对比'}
          </button>
        </div>

        {showCompare && (
          <div className="rounded-lg border border-[var(--border)] p-3">
            <p className="mb-2 text-xs text-muted">勾选借贷进行并列对比（可多选）：</p>
            <div className="flex flex-wrap gap-2">
              {allLoans.map((l, i) => {
                const on = selected.has(l.id);
                return (
                  <label
                    key={l.id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${on ? 'border-[var(--color-primary)]' : 'border-[var(--border)]'}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(l.id); else s.delete(l.id);
                        if (s.size === 0) s.add(loan.id);
                        setSelected(s);
                      }}
                    />
                    <span className="h-2 w-2 rounded-sm" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                    📒 {l.counterparty}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* 图例：当前选中的每笔借贷 */}
        <div className="flex flex-wrap gap-3 text-xs">
          {models.map((m) => (
            <span key={m.loan.id} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: m.color }} />
              {m.loan.direction === 'lend' ? '借出' : '借入'}「{m.loan.counterparty}」{formatMoney(m.loan.remaining)}
            </span>
          ))}
        </div>

        {/* 时间轴刻度表头 */}
        <div className="relative h-4">
          {monthTicks.map((t, idx) => (
            <div key={idx} className="absolute -translate-x-1/2 whitespace-nowrap text-[9px] text-muted" style={{ left: `${t.left}%` }}>{t.label}</div>
          ))}
        </div>

        {/* 按月折叠区间 */}
        {monthGroups.length === 0 && <p className="py-6 text-center text-sm text-muted">当前账本暂无选中借贷</p>}

        <div className="space-y-2">
          {monthGroups.map((g) => {
            const isCollapsed = collapsed.has(g.key);
            const sum = g.items.reduce((s, it) => s + it.row.payment, 0);
            return (
              <div key={g.key} className="rounded-lg border border-[var(--border)]">
                <button
                  className="flex w-full items-center justify-between px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() => setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(g.key)) n.delete(g.key); else n.add(g.key);
                    return n;
                  })}
                >
                  <span>{monthLabel(g.key)}</span>
                  <span className="text-muted">{g.items.length} 期 · 应还 {formatMoney(sum)} {isCollapsed ? '▸' : '▾'}</span>
                </button>
                {!isCollapsed && (
                  <div className="space-y-1 px-2 pb-2">
                    {g.items.map((it, idx) => {
                      const m = STATUS_META[it.row.status];
                      const from = pct(it.row.startTs);
                      const to = pct(toTs(it.row.dueDate));
                      const w = Math.max(2, to - from);
                      return (
                        <div key={`${it.model.loan.id}-${idx}`} className="flex items-center gap-2">
                          <div className="w-12 shrink-0 truncate text-right text-xs" style={{ color: it.model.color }}>
                            {it.model.loan.counterparty}
                          </div>
                          <div className="w-16 shrink-0 text-right text-[10px] text-muted">
                            {it.row.period === 0 ? '到期' : `第${it.row.period}期`}
                          </div>
                          <button
                            className="relative h-6 flex-1 overflow-hidden rounded-md bg-black/5 dark:bg-white/5"
                            onClick={() => openDrill({
                              loan: it.model.loan,
                              row: {
                                period: it.row.period,
                                dueDate: it.row.dueDate,
                                payment: it.row.payment,
                                principal: 0,
                                interest: 0,
                                status: it.row.status,
                              },
                            })}
                            title={`${it.row.period === 0 ? '到期' : `第${it.row.period}期`}（${formatDate(it.row.dueDate)}）：${formatMoney(it.row.payment)} · 点击查看明细`}
                          >
                            <div
                              className="absolute inset-y-0 left-0 flex items-center rounded-md pl-1.5"
                              style={{ left: `${from}%`, width: `${w}%`, background: it.model.color, opacity: it.row.status === 'paid' ? 0.7 : 1 }}
                            >
                              <span className="truncate pr-1 text-[10px] font-semibold" style={{ color: '#fff' }}>
                                {formatMoney(it.row.payment)}
                              </span>
                            </div>
                          </button>
                          <div className="w-9 shrink-0 text-[10px]" style={{ color: m.color }}>{m.label}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {todayInRange && (
          <div className="pointer-events-none relative h-0">
            <div className="absolute -top-3 w-[2px] bg-white mix-blend-difference" style={{ left: `calc(${pct(todayTs)}% - 1px)`, height: '200px', zIndex: 5 }} />
          </div>
        )}

        {isInstallmentAcross && (
          <p className="text-[10px] text-muted">逐个点击期次条可查看对应账单明细 · 月标题可折叠</p>
        )}

        {/* 汇总表：选中各笔的还款计划明细 */}
        <div className="overflow-hidden rounded-md border border-[var(--border)]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-black/5 text-[10px] text-muted dark:bg-white/5">
                <th className="px-1.5 py-1">借贷</th>
                <th className="px-1.5 py-1">期次</th>
                <th className="px-1.5 py-1">还款日</th>
                <th className="px-1.5 py-1">状态</th>
                <th className="px-1.5 py-1 text-right">应还总额</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) =>
                m.rows.map((r) => {
                  const fullRow = calcSchedule(m.loan).rows.find((s) => s.period === r.period)
                    ?? { principal: 0, interest: 0, payment: r.payment };
                  return (
                    <tr key={`${m.loan.id}-${r.period}`} className="border-t border-[var(--border)]">
                      <td className="px-1.5 py-1" style={{ color: m.color }}>{m.loan.counterparty}</td>
                      <td className="px-1.5 py-1 text-muted">{r.period === 0 ? '到期' : `第${r.period}期`}</td>
                      <td className="px-1.5 py-1">{formatDate(r.dueDate)}</td>
                      <td className="px-1.5 py-1">
                        <span className="rounded px-1 py-0.5 text-[10px]" style={{ background: `${STATUS_META[r.status].bar}1f`, color: STATUS_META[r.status].color }}>
                          {STATUS_META[r.status].label}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-right">{formatMoney(fullRow.payment)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 账单明细钻取 */}
      <PeriodDetail drill={drill} onClose={() => setDrill(null)} />
    </Modal>
  );
}

/** 期次账单明细：期次应还本息拆分 + 该借贷的历史还款记录 */
function PeriodDetail({ drill, onClose }: {
  drill: (DrillTarget & { repayments?: { amount: number; interest: number; period: number | null; date: string; note: string }[] }) | null;
  onClose: () => void;
}) {
  if (!drill) return null;
  const { loan, row, repayments = [] } = drill;
  const sched = calcSchedule(loan);
  const full = sched.rows.find((s) => s.period === row.period)
    ?? { principal: 0, interest: 0, payment: row.payment, dueDate: row.dueDate };
  const related = repayments.filter((r) =>
    row.period === 0 ? r.period == null : (r.period ?? null) === row.period
  );

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-[420px] rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h4 className="font-semibold">账单明细</h4>
          <button onClick={onClose} className="text-sm text-muted hover:text-[var(--color-danger)]">✕</button>
        </div>
        <div className="mb-3 text-sm">
          <span style={{ color: STATUS_META[row.status].color }}>{STATUS_META[row.status].label}</span>
          <span className="mx-2 text-muted">·</span>
          {loan.direction === 'lend' ? '借出' : '借入'}「{loan.counterparty}」
          <span className="mx-2 text-muted">·</span>
          {row.period === 0 ? '到期结清' : `第${row.period}期`}
          <span className="mx-2 text-muted">·</span>
          {formatDate(full.dueDate)}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg bg-black/5 p-2 dark:bg-white/5">
            <div className="text-[10px] text-muted">应还本金</div>
            <div style={{ color: '#10B981' }}>{formatMoney(full.principal)}</div>
          </div>
          <div className="rounded-lg bg-black/5 p-2 dark:bg-white/5">
            <div className="text-[10px] text-muted">应还利息</div>
            <div style={{ color: '#F59E0B' }}>{formatMoney(full.interest)}</div>
          </div>
          <div className="rounded-lg bg-black/5 p-2 dark:bg-white/5">
            <div className="text-[10px] text-muted">应还合计</div>
            <div>{formatMoney(full.payment)}</div>
          </div>
        </div>

        <p className="mb-1 mt-3 text-xs text-muted">本笔历史还款记录</p>
        {related.length === 0 ? (
          <p className="rounded-md bg-black/5 p-2 text-xs text-muted dark:bg-white/5">本期暂无已录入的还款记录。</p>
        ) : (
          <ul className="max-h-40 space-y-1 overflow-auto">
            {related.map((r, i) => (
              <li key={i} className="flex items-center justify-between rounded-md bg-black/5 px-2 py-1.5 text-xs dark:bg-white/5">
                <span>{formatDate(r.date)}{r.note ? ` · ${r.note}` : ''}</span>
                <span>{formatMoney(r.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: 'var(--color-primary)', color: '#fff' }}>关闭</button>
        </div>
      </div>
    </div>
  );
}