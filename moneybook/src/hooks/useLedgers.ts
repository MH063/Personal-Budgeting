import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listLedgers, ledgerOverview, createLedger, updateLedger, deleteLedger, getActiveLedger, setActiveLedger, copyLedgerData } from '@/api/ledgers';
import type { CopyReport } from '@/api/ledgers';

export function useLedgers() {
  return useQuery({ queryKey: ['ledgers'], queryFn: listLedgers });
}

/** 账本总览（带账户/流水/储蓄/借贷计数），供账本管理页使用 */
export function useLedgerOverview() {
  return useQuery({ queryKey: ['ledgerOverview'], queryFn: ledgerOverview });
}

export function useActiveLedger() {
  return useQuery({ queryKey: ['activeLedger'], queryFn: getActiveLedger });
}

export function useLedgerMutations() {
  const qc = useQueryClient();
  const inval = () => {
    qc.invalidateQueries({ queryKey: ['ledgers'] });
    // 账本管理页的统计会随增删改名变化，必须一起刷新
    qc.invalidateQueries({ queryKey: ['ledgerOverview'] });
  };
  const create = useMutation({ mutationFn: ({ name, icon, color }: { name: string; icon?: string; color?: string }) => createLedger(name, icon, color), onSuccess: inval });
  const update = useMutation({ mutationFn: ({ id, name, icon, color }: { id: number; name: string; icon?: string; color?: string }) => updateLedger(id, name, icon, color), onSuccess: inval });
  const remove = useMutation({ mutationFn: deleteLedger, onSuccess: inval });
  const copy = useMutation({ mutationFn: ({ sourceId, targetId }: { sourceId: number; targetId: number }) => copyLedgerData(sourceId, targetId), onSuccess: inval });
  return { create, update, remove, copy };
}

/** 切换账本：持久化 active_ledger_id 并清空所有业务缓存 */
export function useSwitchLedger() {
  const qc = useQueryClient();
  return async (id: number) => {
    await setActiveLedger(id);
    await qc.invalidateQueries();
    await qc.clear();
  };
}