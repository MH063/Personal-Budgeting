import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listAccounts, createAccount, updateAccount, setAccountActive, deleteAccount, mergeAccounts,
} from '@/api/accounts';

export function useAccounts(activeOnly = true) {
  return useQuery({ queryKey: ['accounts', activeOnly], queryFn: () => listAccounts(activeOnly) });
}

export function useAccountMutations() {
  const qc = useQueryClient();
  // 账户变更会影响净资产分类与总余额，除 accounts 外还需失效 stats
  const invalidateRelated = () => {
    qc.invalidateQueries({ queryKey: ['accounts'] }); // 前缀匹配，覆盖 accounts 列表与 totals
    qc.invalidateQueries({ queryKey: ['stats'] });     // 覆盖净资产、趋势等统计
  };
  const create = useMutation({
    mutationFn: createAccount,
    onSuccess: invalidateRelated,
  });
  const update = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof updateAccount>[1] }) => updateAccount(id, p),
    onSuccess: invalidateRelated,
  });
  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => setAccountActive(id, active),
    onSuccess: invalidateRelated,
  });
  const remove = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
  const merge = useMutation({
    mutationFn: ({ fromId, toId }: { fromId: number; toId: number }) => mergeAccounts(fromId, toId),
    onSuccess: invalidateRelated,
  });
  return { create, update, setActive, remove, merge };
}