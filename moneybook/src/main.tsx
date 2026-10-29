import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { useUIStore } from './stores/useUIStore';
import { hydrateKV, getKV } from './api/kv';
import { THEME_KEY } from './lib/constants';
import { isTauriRuntime } from './lib/runtime';
import ImportPreviewPage from './pages/Settings/import/ImportPreviewPage';
import './index.css';

/**
 * 是否为「导入解析结果」独立窗口。
 * 以窗口标签判定：Rust 侧以 "import-preview" 创建该窗口，两个窗口加载同一个 index.html。
 * 历史缺陷：此前靠 WebviewUrl::App("index.html#/import-preview") 依赖 hash 路由，
 * 多窗口首屏时 hash 路由匹配不稳定，导致新窗口整页白屏；改为标签判定后与 URL 无关。
 */
const isImportPreviewWindow =
  isTauriRuntime() && getCurrentWindow().label === 'import-preview';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 数据新鲜度设为 0：本地 SQLite 查询毫秒级，代价可忽略；
      // 此前 30s 的 staleTime 会让「记账/导入后切回页面」仍看到旧数据（月度体检等处被反馈为"数据不更新"）。
      // 现在每次挂载/切回页面都会用最新缓存静默校验并刷新，配合写操作的 invalidate 保证页面数据始终最新。
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * 全局提示（sonner）统一为「四色 popup」卡片设计：
 * 成功/警示/错误/信息四种类型各自使用参考设计中的背景色、边框色、文字色与图标色，
 * 关闭按钮为卡片右侧灰色 ×；深色主题下自动切换为深色版本保证可读性。
 * 样式实现见 index.css 的 .app-toast-* 系列（main.tsx 只负责把类名挂到对应节点）。
 */
function ThemedToaster() {
  const theme = useUIStore((s) => s.theme);
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      closeButton
      toastOptions={{
        duration: 4000,
        classNames: {
          toast: 'app-toast',
          title: 'app-toast-title',
          description: 'app-toast-desc',
          icon: 'app-toast-icon',
          closeButton: 'app-toast-close',
          default: 'app-toast-default',
          success: 'app-toast-success',
          error: 'app-toast-error',
          warning: 'app-toast-warning',
          info: 'app-toast-info',
        },
      }}
    />
  );
}

/**
 * 独立预览窗口的主题引导：只从数据库偏好读取主题并应用，保证与主窗口视觉一致；
 * 不执行主窗口的启动任务（自动记账 / 储蓄计提 / 更新检查），避免多窗口重复触发副作用。
 */
function PreviewThemeGate({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void (async () => {
      try {
        await hydrateKV();
        const saved = (getKV(THEME_KEY, 'light') as 'light' | 'dark') || 'light';
        useUIStore.getState().setTheme(saved);
      } catch {
        // 主题读取失败时保持默认浅色，不影响预览与导入功能
      }
    })();
  }, []);
  return <>{children}</>;
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    {isImportPreviewWindow ? (
      // 独立窗口：只渲染预览页（不挂载 App，避免启动任务、引导弹窗、更新检查在该窗口重复执行）
      <PreviewThemeGate>
        <ImportPreviewPage />
        <ThemedToaster />
      </PreviewThemeGate>
    ) : (
      <QueryClientProvider client={queryClient}>
        <App />
        <ThemedToaster />
      </QueryClientProvider>
    )}
  </React.StrictMode>
);
