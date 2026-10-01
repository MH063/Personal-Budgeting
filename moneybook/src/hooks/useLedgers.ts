import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listLedgers, createLedger, updateLedger, deleteLedger, getActiveLedger, setActiveLedger, copyLedgerData } from '@/api/ledgers';
import type { CopyReport } from '@/api/ledgers';

export function useLedgers() {
  return useQuery({ queryKey: ['ledgers'], queryFn: listLedgers });
}

export function useActiveLedger() {
  return useQuery({ queryKey: ['activeLedger'], queryFn: getActiveLedger });
}

export function useLedgerMutations() {
  const qc = useQueryClient();
  const inval = () => qc.invalidateQueries({ queryKey: ['ledgers'] });
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