import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listRecurring, createRecurring, updateRecurring, deleteRecurring,
  applyDueRecurring, type RecurringInput,
} from '@/api/recurring';

export function useRecurring() {
  return useQuery({
    queryKey: ['recurring'],
    queryFn: async () => {
      // 进入周期性记账页时先触发"到期自动生成"（next_run <= 今天才推进，同日内只跑一次）
      await applyDueRecurring();
      return listRecurring();
    },
  });
}

export function useRecurringMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['recurring'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
  };
  const create = useMutation({ mutationFn: createRecurring, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, p }: { id: number; p: RecurringInput }) => updateRecurring(id, p),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: deleteRecurring, onSuccess: invalidate });
  return { create, update, remove };
}