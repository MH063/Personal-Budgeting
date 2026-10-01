import { create } from 'zustand';

interface FilterState {
  txType: string;
  accountId?: number;
  dateFrom?: string;
  dateTo?: string;
  search: string;
  statsView: 'overview' | 'income' | 'expense' | 'surplus' | 'netWorth';
  /** 跨页面快速筛选请求（如从命令面板下钻），列表页挂载时消费并清空 */
  quickSearch: string;
  set: (p: Partial<Omit<FilterState, 'set'>>) => void;
  setQuickSearch: (s: string) => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  txType: 'all',
  search: '',
  quickSearch: '',
  statsView: 'overview',
  set: (p) => set(p),
  setQuickSearch: (s) => set({ quickSearch: s }),
}));