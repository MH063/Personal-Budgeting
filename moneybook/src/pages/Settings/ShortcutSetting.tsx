import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SHORTCUT_DEFS, eventToKeys, getShortcut, setShortcut, type ShortcutAction } from '@/lib/shortcuts';

/** 键位展示：按 "Ctrl+K" 拆成键帽样式 */
function Keycaps({ keys }: { keys: string }) {
  if (!keys) return <span className="text-xs text-muted">未设置</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {keys.split('+').map((k) => (
        <kbd
          key={k}
          className="rounded-md border border-[var(--border)] bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/**
 * 快捷键设置：查看与自定义应用内快捷键。
 * 录制方式：点击「修改」后在键盘上按下新组合键；Esc 取消；
 * 录制监听挂在 capture 阶段并阻断传播，避免录制时误触发已注册的全局快捷键。
 */
export default function ShortcutSetting() {
  const [current, setCurrent] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const d of SHORTCUT_DEFS) m[d.action] = getShortcut(d.action);
    return m;
  });
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const keys = eventToKeys(e);
      if (!keys) return; // 只按下了修饰键：继续等待主键
      // 冲突检查：同一键位不允许绑定到两个动作
      const conflict = SHORTCUT_DEFS.find((d) => d.action !== recording && current[d.action] === keys);
      if (conflict) {
        toast.warning(`该键位已被「${conflict.label}」使用，请换一个组合`);
        return;
      }
      void save(recording, keys);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, current]);

  /** 持久化键位并同步本地展示 */
  async function save(action: ShortcutAction, keys: string) {
    await setShortcut(action, keys);
    setCurrent((prev) => ({ ...prev, [action]: keys }));
    toast.success('快捷键已更新');
  }

  /** 恢复默认：清空全部自定义键位（回退内置默认值） */
  async function resetAll() {
    for (const d of SHORTCUT_DEFS) await setShortcut(d.action, '');
    const m: Record<string, string> = {};
    for (const d of SHORTCUT_DEFS) m[d.action] = getShortcut(d.action);
    setCurrent(m);
    toast.success('已恢复默认快捷键');
  }

  const hasCustom = SHORTCUT_DEFS.some((d) => current[d.action] !== d.def);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">快捷键</h3>
          <p className="mt-0.5 text-sm text-muted">应用内快捷键，窗口聚焦时生效；点「修改」后按下新的组合键即可。</p>
        </div>
        {hasCustom && (
          <Button size="sm" variant="ghost" onClick={() => void resetAll()}>
            恢复默认
          </Button>
        )}
      </div>
      <div className="divide-y divide-[var(--border)]">
        {SHORTCUT_DEFS.map((d) => (
          <div key={d.action} className="flex flex-wrap items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{d.label}</div>
              <div className="text-xs text-muted">{d.desc}</div>
            </div>
            {recording === d.action ? (
              <span className="text-sm text-[var(--color-primary)]">请按新键位…（Esc 取消）</span>
            ) : (
              <Keycaps keys={current[d.action]} />
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRecording(recording === d.action ? null : d.action)}
            >
              {recording === d.action ? '取消' : '修改'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}