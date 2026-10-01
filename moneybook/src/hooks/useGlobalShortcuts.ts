// 全局快捷键监听：统一挂在 AppShell，任何页面（含弹窗打开时）都可触发。
// 键位来自 settings 表配置（见 lib/shortcuts.ts），替代原先散落各处的手写监听。
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { SHORTCUT_DEFS, getShortcut, matchShortcut, type ShortcutAction } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';

/** 执行某个快捷键动作（导出便于复用与测试） */
export function runShortcut(action: ShortcutAction, navigate: NavigateFunction): void {
  switch (action) {
    case 'commandPalette': {
      const ui = useUIStore.getState();
      ui.setCommandOpen(!ui.commandOpen); // 再按一次关闭（toggle）
      break;
    }
    case 'aiAssistant':
      useAiAssistantStore.getState().openAssistant();
      break;
    case 'quickAdd':
      // 跳转流水页并携带 ?new=1 自动打开「记支出」表单（TransactionsPage 消费后立即清参数，保证可重复触发）
      navigate('/transactions?type=expense&new=1');
      break;
  }
}

/** 全局快捷键：按用户配置逐个匹配，命中即执行动作并阻止默认行为 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const d of SHORTCUT_DEFS) {
        if (matchShortcut(e, getShortcut(d.action))) {
          e.preventDefault();
          runShortcut(d.action, navigate);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}