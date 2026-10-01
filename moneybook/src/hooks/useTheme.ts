import { useEffect } from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { hydrateKV, getKV, setKV } from '@/api/kv';
import { THEME_KEY } from '@/lib/constants';

export function useTheme() {
  const { theme, setTheme } = useUIStore();
  useEffect(() => {
    (async () => {
      // 主题偏好存数据库 settings 表（kv.theme），不再使用 localStorage
      await hydrateKV();
      const saved = (getKV(THEME_KEY, 'light') as 'light' | 'dark') || 'light';
      setTheme(saved);
    })();
  }, [setTheme]);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setKV(THEME_KEY, next);
    setTheme(next);
  };
  return { theme, toggleTheme };
}