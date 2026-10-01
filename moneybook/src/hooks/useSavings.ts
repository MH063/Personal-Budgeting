import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listGoals, createGoal, updateGoal, depositToGoal, withdrawFromGoal, cancelGoal, deleteGoal, applyDueAutoSavings } from '@/api/savings';

export function useGoals() {
  return useQuery({
    queryKey: ['savings'],
    queryFn: async () => {
      // 进入储蓄首页时先触发"到期自动计提"（幂等：本月已计提则跳过）
      await applyDueAutoSavings();
      return listGoals();
    },
  });
}

export function useGoalMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['savings'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['todos'] });
  };
  const create = useMutation({ mutationFn: createGoal, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof updateGoal>[1] }) => updateGoal(id, p),
    onSuccess: invalidate,
  });
  const deposit = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof depositToGoal>[1] }) => depositToGoal(id, p),
    onSuccess: invalidate,
  });
  const withdraw = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof withdrawFromGoal>[1] }) => withdrawFromGoal(id, p),
    onSuccess: invalidate,
  });
  const cancel = useMutation({ mutationFn: cancelGoal, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: deleteGoal, onSuccess: invalidate });
  return { create, update, deposit, withdraw, cancel, remove };
}