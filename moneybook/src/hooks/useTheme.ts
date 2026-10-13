import { useUIStore } from '@/stores/useUIStore';
import { setKV } from '@/api/kv';
import { THEME_KEY } from '@/lib/constants';
import { toast } from 'sonner';

/**
 * 主题读取/切换 hook（纯 UI 侧）。
 *
 * 约定（消除重复，单一职责）：
 *  - 主题的「从数据库载入并应用」只在应用启动时由 App.tsx 统一完成（见 App startup effect），
 *    本 hook 不再自行 hydrate 读库——此前 App.tsx 与这里各读一次库，属功能重复，
 *    且两处时序差异会造成 store 与 html 类名短暂不一致。
 *  - 本 hook 只负责：读取当前主题 + 切换主题并持久化。
 *
 * 切换语义：先即时更新界面（保证交互流畅），再等待写库；
 * 若写库失败（setKV 已回滚内存缓存），则把界面一并回滚到原主题并提示，避免
 * 「界面已变暗、库里仍是旧值」的假保存——这正是重启后主题回到默认的成因之一。
 */
export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const toggleTheme = () => {
    const prev = theme;
    const next: 'light' | 'dark' = prev === 'dark' ? 'light' : 'dark';
    setTheme(next); // 即时反馈
    void setKV(THEME_KEY, next).then((ok) => {
      if (!ok) {
        // 写库失败：与数据库保持一致，回滚界面并如实提示
        setTheme(prev);
        toast.error('主题偏好保存失败，已恢复为原来的主题');
      }
    });
  };

  return { theme, toggleTheme };
}
