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

/** 订阅主题，让 sonner toast 跟随深色主题（浅色 toast 在白底深色页面会很突兀） */
function ThemedToaster() {
  const theme = useUIStore((s) => s.theme);
  return <Toaster position="top-center" richColors theme={theme} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <ThemedToaster />
    </QueryClientProvider>
  </React.StrictMode>
);