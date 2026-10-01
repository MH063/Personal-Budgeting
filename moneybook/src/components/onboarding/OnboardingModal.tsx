import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { execute } from '@/api/db';
import { isSeeded, seedSampleData } from '@/api/onboarding';

// 首次运行引导弹窗：未初始化（seed_done 缺失）时自动弹出一次。
// 关闭后本会话内不再自动弹出（组件只渲染一次，state 被置为已处理）。
export function OnboardingModal() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    let cancelled = false;
    (async () => {
      const seeded = await isSeeded();
      if (!cancelled && !seeded) setOpen(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const markSeeded = () =>
    execute(
      `INSERT INTO settings (key, value) VALUES ('seed_done', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
      ['seed_done']
    );

  const handleLoadSamples = async () => {
    setBusy(true);
    try {
      const n = await seedSampleData();
      toast.success(n > 0 ? `已载入 ${n} 条示例记录` : '示例记录已载入');
      await markSeeded();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '载入示例数据失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = async () => {
    try {
      await markSeeded();
    } finally {
      setOpen(false);
    }
  };

  return (
    <Modal open={open} onClose={handleSkip} title="👋 欢迎使用个人记账工具">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          这是一个个人记账工具，支持收入 / 支出 / 转账 / 借贷 / 储蓄 / 预算等场景。
          {import.meta.env.DEV ? '你可以先用示例数据熟悉功能，或直接开始。' : '所有数据仅保存在本机，直接开始使用吧。'}
        </p>
        <div className="flex flex-col gap-2.5 pt-1">
          {/* 载入示例数据仅开发期可见：正式打包后不提供任何预置/示例数据（用户要求） */}
          {import.meta.env.DEV && (
            <Button onClick={handleLoadSamples} disabled={busy} className="w-full">
              {busy ? '载入中…' : '🚀 载入示例数据'}
            </Button>
          )}
          <Button variant="outline" onClick={handleSkip} disabled={busy} className="w-full">
            跳过，开始使用
          </Button>
        </div>
      </div>
    </Modal>
  );
}