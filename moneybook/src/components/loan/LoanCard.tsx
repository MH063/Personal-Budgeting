import { useState } from 'react';
import { formatMoney, formatDate } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { calcLoanInterest, calcSchedule, METHOD_LABELS } from '@/api/loans';
import type { Loan } from '@/api/loans';

const DIR_META = {
  lend: { label: '借出', color: '#F59E0B', icon: '📤' },
  borrow: { label: '借入', color: '#3B82F6', icon: '📥' },
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  active: { label: '进行中', color: '#3B82F6' },
  settled: { label: '已结清', color: '#10B981' },
  overdue: { label: '已逾期', color: '#EF4444' },
};

export function LoanCard({ loan, onRepay, onRepayOverdue, onSettle, onUnsettle, onEdit, onDelete, onGantt }: {
  loan: Loan; onRepay: (loan: Loan) => void; onSettle?: (loan: Loan) => void;
  onRepayOverdue?: (loan: Loan) => void;
  onUnsettle?: (loan: Loan) => void;
  onEdit?: (loan: Loan) => void; onDelete?: (loan: Loan) => void; onGantt?: (loan: Loan) => void;
}) {
  const [show, setShow] = useState(false);
  const dir = DIR_META[loan.direction];
  const st = STATUS_META[loan.status];
  const interest = calcLoanInterest(loan);
  const hasRate = Number(loan.rate) > 0;
  const method = loan.method ?? 'balloon';
  const methodLabel = METHOD_LABELS[method] ?? '到期一次还本付息';
  const isCompound = Number(loan.compound) === 1;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{dir.icon}</span>
          <div>
            <div className="font-medium">{loan.counterparty}</div>
            <div className="text-xs text-muted">{formatDate(loan.date)}{loan.due_date ? ` · 到期 ${formatDate(loan.due_date)}` : ''}</div>
          </div>
        </div>
        <div className="text-right">
          <Badge color={st.color}>{st.label}</Badge>
          <div className="mt-1 text-xs text-muted">{dir.label}</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-xs text-muted">本金</div>
          <div>{formatMoney(loan.principal)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">剩余</div>
          <div className="font-semibold" style={{ color: '#1E6FA9' }}>{formatMoney(loan.remaining)}</div>
        </div>
      </div>
      {hasRate && (
        <div className="mt-2 flex flex-wrap justify-between gap-1 text-xs">
          <span className="text-muted">{methodLabel} · 年利率 {Number(loan.rate)}% · {isCompound ? '复利' : '单利'}{loan.periods ? ` · ${loan.periods} 期` : ''}</span>
          <span className="text-muted">预计利息 <strong style={{ color: dir.color }}>{formatMoney(interest)}</strong></span>
        </div>
      )}
      {Number(loan.accrued_interest) > 0.0001 && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-[var(--color-danger)]/10 px-2 py-1 text-xs">
          <span style={{ color: 'var(--color-danger)' }}>已累计逾期利息 <strong>+{formatMoney(Number(loan.accrued_interest))}</strong></span>
          {onRepayOverdue && loan.status !== 'settled' && (
            <button
              type="button"
              onClick={() => onRepayOverdue(loan)}
              className="shrink-0 rounded border border-[var(--color-danger)] px-1.5 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
            >
              还利息
            </button>
          )}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        {loan.status !== 'settled' && loan.remaining > 0.0001 && (
          <Button size="sm" onClick={() => onRepay(loan)}>还款</Button>
        )}
        {onSettle && loan.status !== 'settled' && (
          <Button size="sm" variant="ghost" onClick={() => onSettle(loan)}>结清</Button>
        )}
        {onUnsettle && loan.status === 'settled' && (
          <Button size="sm" variant="ghost" onClick={() => onUnsettle(loan)}>恢复</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShow((v) => !v)}>明细</Button>
        {onGantt && loan.status !== 'settled' && (
          <Button size="sm" variant="ghost" onClick={() => onGantt(loan)}>甘特图</Button>
        )}
        {onEdit && (
          <Button size="sm" variant="ghost" onClick={() => onEdit(loan)}>编辑</Button>
        )}
        {onDelete && (
          <Button size="sm" variant="ghost" className="text-[var(--color-danger)]" onClick={() => onDelete(loan)}>删除</Button>
        )}
      </div>
      {show && (
        <div className="mt-3 space-y-2 rounded-lg bg-black/5 p-3 text-xs text-muted dark:bg-white/5">
          {loan.note ? <div>备注：{loan.note}</div> : null}
          {loan.account_id ? <div>关联账户 #{loan.account_id}</div> : null}
          {loan.first_repay_date ? <div>开始还款日：{formatDate(loan.first_repay_date)}{loan.repay_day ? ` · 每月 ${loan.repay_day} 号` : ''}</div> : null}
          <div>
            {methodLabel} · {isCompound ? '复利' : '单利'}
            {loan.rate > 0 ? ` · 年利率 ${loan.rate}%${loan.periods ? ` · ${loan.periods} 期` : ''}` : ' · 无利率'}
            {' · 已还 '}{formatMoney(loan.principal - loan.remaining)}
          </div>
          {hasRate && (
            <LoanScheduleTable loan={loan} />
          )}
        </div>
      )}
    </Card>
  );
}

/** 还款计划明细表：逐期展示应还本金（绿）与应还利息（橙红） */
function LoanScheduleTable({ loan }: { loan: Loan }) {
  const sched = calcSchedule(loan);
  const MAX = 24; // 期数过多时折叠展示，避免卡片过长
  const many = sched.rows.length > MAX;
  const showRows = many ? sched.rows.slice(0, MAX) : sched.rows;

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border)]">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="bg-black/5 text-[10px] text-muted dark:bg-white/5">
            <th className="px-1.5 py-1">期次</th>
            <th className="px-1.5 py-1">还款日</th>
            <th className="px-1.5 py-1 text-right">应还本金</th>
            <th className="px-1.5 py-1 text-right">应还利息</th>
            <th className="px-1.5 py-1 text-right">应还总额</th>
          </tr>
        </thead>
        <tbody>
          {showRows.map((r) => (
            <tr key={r.period} className="border-t border-[var(--border)]">
              <td className="px-1.5 py-1 text-muted">{r.period === 0 ? '到期' : `第${r.period}期`}</td>
              <td className="px-1.5 py-1">{formatDate(r.dueDate)}</td>
              <td className="px-1.5 py-1 text-right" style={{ color: '#10B981' }}>{formatMoney(r.principal)}</td>
              <td className="px-1.5 py-1 text-right" style={{ color: '#F59E0B' }}>{formatMoney(r.interest)}</td>
              <td className="px-1.5 py-1 text-right">{formatMoney(r.payment)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-between border-t border-[var(--border)] px-1.5 py-1 text-xs">
        <span className="text-muted">合计利息</span>
        <span style={{ color: '#F59E0B' }}>{formatMoney(sched.totalInterest)}</span>
        <span className="text-muted">本息合计</span>
        <span>{formatMoney(sched.totalPayment)}</span>
      </div>
      {many && <div className="px-1.5 pb-1 text-[10px] text-muted">仅展示前 {MAX} 期，共 {sched.rows.length} 期</div>}
    </div>
  );
}