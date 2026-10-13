// 规划页 · 债务偿还模拟区块
// -----------------------------------------------------------------------------
// 选择未结清借款，设定"每月额外还款"与策略（雪球=先清最小余额 / 雪崩=先清最高利率），
// 用纯函数 simulateDebtPayoff 推演结清顺序、总利息，并与"仅最低还款"对比节省的利息与月数。
// 数据来自 loans 表（direction='borrow'、未结清）；模拟过程完全在本地进行，不写库。
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/data-table/DataTable';
import { formatMoney } from '@/lib/format';
import { useLoans } from '@/hooks/useLoans';
import { simulateDebtPayoff, comparePayoff, type DebtStrategy } from '@/lib/debtSim';

const STRATEGY_OPTIONS = [
  { value: 'avalanche', label: '雪崩法（先还高利率）' },
  { value: 'snowball', label: '雪球法（先还小额）' },
];

export default function DebtPayoffSection() {
  const { data: allLoans = [], isLoading: loading } = useLoans();
  // 只选未结清的借入（债务）
  const borrowLoans = useMemo(() => allLoans.filter((l) => l.direction === 'borrow' && l.status !== 'settled'), [allLoans]);
  
  // 维护一个自定义的 debts 列表，保存额外的模拟字段 minPayment
  const [debts, setDebts] = useState<{ id: number; name: string; balance: number; apr: number; minPayment: number }[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [extra, setExtra] = useState('200');
  const [strategy, setStrategy] = useState<DebtStrategy>('avalanche');

  useEffect(() => {
    if (borrowLoans.length > 0 && debts.length === 0) {
      const initialDebts = borrowLoans.map((d) => ({
        id: d.id,
        name: d.counterparty,
        balance: d.remaining,
        apr: d.rate,
        minPayment: d.method === 'equal_payment' ? (d.principal * (d.rate / 100 / 12) * Math.pow(1 + d.rate / 100 / 12, d.periods || 12)) / (Math.pow(1 + d.rate / 100 / 12, d.periods || 12) - 1) : 0 // 简单估算，或者直接给0由用户填
      }));
      setDebts(initialDebts);
      setSelected(new Set(initialDebts.map((d) => d.id)));
    }
  }, [borrowLoans]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /** 修改某笔借款的每月最低还款（仅影响模拟，不改库） */
  const setMin = (id: number, value: string) =>
    setDebts((prev) => prev.map((d) => (d.id === id ? { ...d, minPayment: Number(value) || 0 } : d)));

  const chosen = debts.filter((d) => selected.has(d.id));
  const extraNum = Number(extra) || 0;

  // 基准（仅最低还款）与加速（最低 + 额外还款）对比；策略相同
  const { base, boosted, cmp } = useMemo(() => {
    const inputs = chosen.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.minPayment }));
    const b = simulateDebtPayoff(inputs, 0, strategy);
    const p = simulateDebtPayoff(inputs, extraNum, strategy);
    return { base: b, boosted: p, cmp: comparePayoff(b, p) };
  }, [chosen, extraNum, strategy]);

  const nameOf = (id: number) => debts.find((d) => d.id === id)?.name ?? `#${id}`;

  return (
    <div className="space-y-4">
      {loading && <div className="text-xs text-muted">正在加载借款数据…</div>}

      {!loading && debts.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-black/5 p-3 text-xs text-muted dark:bg-white/5">
          暂无未结清的借入记录。可在「借贷」页新增借款后回到此处模拟还款。
        </div>
      )}

      {debts.length > 0 && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="mb-2 text-sm font-medium">选择要模拟的借款</div>
            <div className="space-y-2">
              {debts.map((d) => (
                <div key={d.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={() => toggle(d.id)}
                    className="h-4 w-4"
                  />
                  <span className="truncate text-sm">
                    {d.name}
                    <span className="ml-2 text-xs text-muted">
                      剩余 ¥{formatMoney(d.balance)} · 年利率 {d.apr}%
                    </span>
                  </span>
                  <span className="text-xs text-muted">每月最低还款</span>
                  <Input
                    type="number"
                    step="0.01"
                    value={String(d.minPayment)}
                    onChange={(e) => setMin(d.id, e.target.value)}
                    className="w-28"
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-muted">
              提示：分期借款的每月最低还款已按还款计划自动带出，可手动修改；到期一次还本的借款需自行填写每月预留金额。
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs text-muted">每月额外还款</span>
              <Input type="number" step="0.01" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted">还款策略</span>
              <Select<DebtStrategy> value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} />
            </label>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="text-xs text-muted">参与模拟</div>
              <div className="mt-1 font-semibold">{chosen.length} 笔 / 合计 ¥{formatMoney(chosen.reduce((s, d) => s + d.balance, 0))}</div>
            </div>
          </div>

          {chosen.length > 0 && !boosted.cleared && (
            <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-xs">
              按当前每月还款额无法在 50 年内结清（还款额不足以覆盖利息），请提高「每月最低还款」或「每月额外还款」。
            </div>
          )}

          {chosen.length > 0 && boosted.cleared && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
                  <div className="text-xs text-muted">预计结清用时</div>
                  <div className="mt-1 font-semibold">{boosted.months} 个月</div>
                </div>
                <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
                  <div className="text-xs text-muted">预计支付利息</div>
                  <div className="mt-1 font-semibold">¥{formatMoney(boosted.totalInterest)}</div>
                </div>
                <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
                  <div className="text-xs text-muted">较仅最低还款省息</div>
                  <div className="mt-1 font-semibold" style={{ color: 'var(--color-success)' }}>¥{formatMoney(cmp.interestSaved)}</div>
                </div>
                <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
                  <div className="text-xs text-muted">较仅最低还款提前</div>
                  <div className="mt-1 font-semibold" style={{ color: 'var(--color-success)' }}>{cmp.monthsSaved} 个月</div>
                </div>
              </div>

              <div className="text-xs text-muted">
                结清顺序：{boosted.payoffOrder.map((id, i) => `${i + 1}. ${nameOf(id)}`).join('　')}
              </div>

              <DataTable
                data={boosted.perDebt}
                columns={[
                  { key: 'name', header: '借款', render: (r) => <span>{r.name}</span> },
                  { key: 'months', header: '结清用时（月）', render: (r) => <span>{r.months > 0 ? r.months : '未结清'}</span> },
                  { key: 'interest', header: '支付利息', render: (r) => <span className="font-medium">¥{formatMoney(r.interest)}</span> },
                ]}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
