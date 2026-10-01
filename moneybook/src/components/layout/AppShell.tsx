import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import CommandPalette from './CommandPalette';
import AiAssistantDialog from '@/components/ai/AiAssistantDialog';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';

export default function AppShell() {
  // 全局快捷键（命令面板 / AI 助手 / 快速记账），键位可在设置→快捷键中修改
  useGlobalShortcuts();
  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-auto px-6 py-5">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      {/* 全局唯一 AI 助手弹窗：仪表盘/智能洞察/月度体检的 AI 能力统一在此发起 */}
      <AiAssistantDialog />
    </div>
  );
}