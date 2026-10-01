import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listLoans, createLoan, updateLoan, repayLoan, repayOverdueInterest, deleteLoan, settleLoan, unSettleLoan, listOverdueLoans, checkOverdueLoans } from '@/api/loans';

export function useLoans() {
  return useQuery({
    queryKey: ['loans'],
    queryFn: async () => {
      await checkOverdueLoans();
      return listLoans();
    },
  });
}

/** 逾期借贷列表（用于顶部提醒/首页横幅） */
export function useOverdueLoans() {
  return useQuery({ queryKey: ['loans', 'overdue'], queryFn: listOverdueLoans });
}

export function useLoanMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['loans'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['todos'] });
  };
  const create = useMutation({ mutationFn: createLoan, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof updateLoan>[1] }) => updateLoan(id, p),
    onSuccess: invalidate,
  });
  const repay = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof repayLoan>[1] }) => repayLoan(id, p),
    onSuccess: invalidate,
  });
  const repayOverdue = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Parameters<typeof repayOverdueInterest>[1] }) => repayOverdueInterest(id, p),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: deleteLoan, onSuccess: invalidate });
  const settle = useMutation({ mutationFn: settleLoan, onSuccess: invalidate });
  const unSettle = useMutation({
    mutationFn: (loanId: number) => unSettleLoan(loanId),
    onSuccess: invalidate,
  });
  return { create, update, repay, repayOverdue, remove, settle, unSettle };
}