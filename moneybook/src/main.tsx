import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import App from './App';
import { useUIStore } from './stores/useUIStore';
import './index.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <ThemedToaster />
    </QueryClientProvider>
  </React.StrictMode>
);