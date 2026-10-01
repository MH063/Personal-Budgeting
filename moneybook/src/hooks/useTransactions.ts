import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTransaction, deleteTransaction, updateTransaction,
  listTransactionsDetailed, type TxPayload,
} from '@/api/transactions';

export function useTransactionList(params: Parameters<typeof listTransactionsDetailed>[0] = {}) {
  return useQuery({ queryKey: ['transactions', params], queryFn: () => listTransactionsDetailed(params) });
}

export function useTransactionMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['loans'] });
  };
  const create = useMutation({ mutationFn: createTransaction, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: deleteTransaction, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, p }: { id: number; p: TxPayload }) => updateTransaction(id, p),
    onSuccess: invalidate,
  });
  return { create, remove, update };
}