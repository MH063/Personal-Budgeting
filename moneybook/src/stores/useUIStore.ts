import { create } from 'zustand';

interface UIState {
  collapsed: boolean;
  theme: 'light' | 'dark';
  toggle: () => void;
  setTheme: (t: 'light' | 'dark') => void;
  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  collapsed: false,
  theme: 'light',
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
  setTheme: (theme) => {
    set({ theme });
    document.documentElement.classList.toggle('dark', theme === 'dark');
  },
  commandOpen: false,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
}));