// 银行对账数据 hook：批次列表 / 建批次 / 匹配 / 锁定 / 解锁 / 删除
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createReconciliation, listReconciliations, deleteReconciliation,
  matchAuto, matchManual, matchManualSplit, importBankRows,
  parseBankStatement, completeReconciliation, unlockReconciliation,
  ignoreBankItem, createTxFromBankItem,
  listMatches, reconDiffSummary, reconcileExportRows, type BankRow, type ReconDiffRow,
} from '@/api/reconciliation';

export function useReconciliation() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['reconciliations'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    // 匹配/忽略/补记后，明细与差异报告都要刷新（否则页面停留在旧数据）
    qc.invalidateQueries({ queryKey: ['reconItems'] });
    qc.invalidateQueries({ queryKey: ['reconDiff'] });
  };
  const list = useQuery({ queryKey: ['reconciliations'], queryFn: listReconciliations });
  const create = useMutation({ mutationFn: createReconciliation, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: deleteReconciliation, onSuccess: invalidate });
  const auto = useMutation({ mutationFn: matchAuto, onSuccess: invalidate });
  const manual = useMutation({
    mutationFn: ({ recId, itemId, txId }: { recId: number; itemId: number; txId: number }) => matchManual(recId, itemId, txId),
    onSuccess: invalidate,
  });
  const split = useMutation({
    mutationFn: ({ recId, itemId, txId, portion }: { recId: number; itemId: number; txId: number; portion: number }) =>
      matchManualSplit(recId, itemId, txId, portion),
    onSuccess: invalidate,
  });
  const lock = useMutation({
    mutationFn: ({ recId, endBalance }: { recId: number; endBalance: number }) => completeReconciliation(recId, endBalance),
    onSuccess: invalidate,
  });
  const unlock = useMutation({ mutationFn: unlockReconciliation, onSuccess: invalidate });
  // 未匹配闭环：忽略该银行流水 / 由银行流水一键补记本地交易
  const ignore = useMutation({
    mutationFn: ({ recId, itemId }: { recId: number; itemId: number }) => ignoreBankItem(recId, itemId),
    onSuccess: invalidate,
  });
  const createTx = useMutation({
    mutationFn: ({ recId, itemId }: { recId: number; itemId: number }) => createTxFromBankItem(recId, itemId),
    onSuccess: invalidate,
  });
  return { list, create, remove, auto, manual, split, lock, unlock, ignore, createTx };
}

export function useReconItems(recId: number | null) {
  return useQuery({
    queryKey: ['reconItems', recId],
    queryFn: () => listMatches(recId as number),
    enabled: recId != null,
  });
}

/** 差异报告（可分页：localUnmatched 按 page/pageSize 拉取，localUnmatchedTotal 为总数） */
export function useReconDiff(recId: number | null, opts?: { page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: ['reconDiff', recId, opts?.page, opts?.pageSize],
    queryFn: () => reconDiffSummary(recId as number, opts),
    enabled: recId != null,
  });
}

/** 导出差异数据（Excel / CSV），返回扁平行数组 */
export async function exportReconDiff(recId: number): Promise<ReconDiffRow[]> {
  return reconcileExportRows(recId);
}

export type { BankRow };
export type { ReconDiffRow };

export { parseBankStatement, importBankRows };