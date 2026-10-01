import { create } from 'zustand';
import { setCurrentLedger } from '@/lib/ledger';

interface LedgerState {
  currentId: number;
  setCurrentId: (id: number) => void;
}

export const useLedgerStore = create<LedgerState>((set) => ({
  currentId: 1,
  setCurrentId: (id) => {
    setCurrentLedger(id);
    set({ currentId: id });
  },
}));