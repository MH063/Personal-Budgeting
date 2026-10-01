import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listHoldings, getHoldingSummary, listHoldingSummaries, createHolding, updateHolding, deleteHolding, type HoldingInput } from '@/api/holdings';

export function useHoldings(accountId: number) {
  return useQuery({ queryKey: ['holdings', accountId], queryFn: () => listHoldings(accountId) });
}

export function useHoldingSummary(accountId: number) {
  return useQuery({ queryKey: ['holdings', 'summary', accountId], queryFn: () => getHoldingSummary(accountId) });
}

/** 账户页：全部账户的持仓汇总（只在有持仓时返回对应账户） */
export function useHoldingSummaries() {
  return useQuery({ queryKey: ['holdings', 'summaries'], queryFn: listHoldingSummaries });
}

export function useHoldingMutations() {
  const qc = useQueryClient();
  // 持仓变动会同时影响账户现金与净资产/类型汇总
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['holdings'] }); // 覆盖持仓列表/汇总/全部汇总
    qc.invalidateQueries({ queryKey: ['accounts'] }); // 覆盖账户列表与类型汇总
    qc.invalidateQueries({ queryKey: ['stats'] });    // 覆盖净资产等统计
  };
  const create = useMutation({
    mutationFn: ({ accountId, p }: { accountId: number; p: HoldingInput }) => createHolding(accountId, p),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, p }: { id: number; p: HoldingInput }) => updateHolding(id, p),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: deleteHolding,
    onSuccess: invalidate,
  });
  return { create, update, remove };
}