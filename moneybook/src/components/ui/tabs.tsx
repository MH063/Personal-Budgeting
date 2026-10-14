import { createContext, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TabsCtx = createContext<{ value: string; setValue: (v: string) => void }>({
  value: '',
  setValue: () => {},
});

export function Tabs({ value: controlled, onValueChange, defaultValue, children }: {
  value?: string; onValueChange?: (v: string) => void; defaultValue?: string; children: ReactNode;
}) {
  const [inner, setInner] = useState(defaultValue ?? '');
  const value = controlled ?? inner;
  const setValue = (v: string) => {
    setInner(v);           // 始终更新内部状态以保证 UI 高亮
    onValueChange?.(v);    // 同时通知外部
  };
  return <TabsCtx.Provider value={{ value, setValue }}>{children}</TabsCtx.Provider>;
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/5', className)}>{children}</div>;
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const { value: val, setValue } = useContext(TabsCtx);
  const isActive = val === value;
  return (
    <button
      type="button"
      onClick={() => setValue(value)}
      className={cn(
        'flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
        isActive ? 'font-medium shadow-sm' : 'hover:opacity-80',
        !isActive && 'text-muted'
      )}
      // 选中态统一用主题主色作底 + 前景色（浅色白字 / 暗色近黑字），与侧边栏选中态一致。
      // 历史缺陷：此处曾硬编码 #fff，暗色主色翻转为近白后形成「白底白字」而不可见。
      style={isActive ? { background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' } : {}}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  const { value: val } = useContext(TabsCtx);
  if (val !== value) return null;
  return <>{children}</>;
}