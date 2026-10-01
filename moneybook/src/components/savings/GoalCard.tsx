import { formatMoney, formatPercent } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGoalMutations } from '@/hooks/useSavings';
import type { SavingsGoal } from '@/api/savings';
import { useState } from 'react';

const STATUS_META: Record<string, { label: string; color: string }> = {
  active: { label: '进行中', color: '#3B82F6' },
  completed: { label: '已完成', color: '#10B981' },
  cancelled: { label: '已取消', color: '#EF4444' },
};

export function GoalCard({ goal, onDeposit, onWithdraw, onEdit, onDelete }: {
  goal: SavingsGoal; onDeposit: (goal: SavingsGoal) => void; onWithdraw?: (goal: SavingsGoal) => void;
  onEdit?: (goal: SavingsGoal) => void;
  onDelete?: (goal: SavingsGoal) => void;
}) {
  const { cancel } = useGoalMutations();
  const [confirming, setConfirming] = useState(false);
  const pct = goal.target_amount ? (goal.current_amount / goal.target_amount) * 100 : 0;
  const meta = STATUS_META[goal.status];

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{goal.icon}</span>
          <div>
            <div className="font-medium">{goal.name}</div>
            <div className="text-xs text-muted">目标日期：{goal.target_date || '-'}</div>
          </div>
        </div>
        <Badge color={meta.color}>{meta.label}</Badge>
      </div>
      <div className="mt-3">
        <Progress value={pct} color={goal.color} />
        <div className="mt-1 flex justify-between text-xs text-muted">
          <span>{formatMoney(goal.current_amount)}</span>
          <span>{formatPercent(pct / 100)}</span>
        </div>
      </div>
      <div className="mt-1 text-xs text-muted">目标 {formatMoney(goal.target_amount)}</div>
      {goal.auto_monthly > 0 && (
        <div className="mt-2 flex items-center gap-1 rounded-md bg-black/5 px-2 py-1 text-xs text-muted dark:bg-white/5">
          <span>🔄 每月 {goal.auto_day} 日自动计提 {formatMoney(goal.auto_monthly)}</span>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        {goal.status !== 'completed' && goal.status !== 'cancelled' && (
          <Button size="sm" onClick={() => onDeposit(goal)}>存入</Button>
        )}
        {onWithdraw && goal.current_amount > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onWithdraw(goal)}>支取</Button>
        )}
        {onEdit && (
          <Button size="sm" variant="ghost" onClick={() => onEdit(goal)}>编辑</Button>
        )}
        {confirming ? (
          <Button size="sm" variant="danger" onClick={() => cancel.mutate(goal.id)}>确认取消</Button>
        ) : (
          goal.status === 'active' && (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>取消</Button>
          )
        )}
        {onDelete && (
          <Button size="sm" variant="ghost" className="text-[var(--color-danger)]" onClick={() => onDelete(goal)}>删除</Button>
        )}
      </div>
    </Card>
  );
}