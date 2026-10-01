import { useState } from 'react';
import { toast } from 'sonner';
import { useLedgers, useSwitchLedger, useLedgerMutations } from '@/hooks/useLedgers';
import { useLedgerStore } from '@/stores/useLedgerStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CopyLedgerWizard } from './CopyLedgerWizard';
import { useEscapeClose, UnsavedCloseDialog } from '@/components/ui/unsaved-guard';

export function LedgerSwitcher() {
  const { data: ledgers = [] } = useLedgers();
  const currentId = useLedgerStore((s) => s.currentId);
  const switchLedger = useSwitchLedger();
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const current = ledgers.find((l) => l.id === currentId);

  async function doSwitch(id: number) {
    await switchLedger(id);
    setOpen(false);
    setManage(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
      >
        <span>{current?.icon || '📒'}</span>
        <span className="font-medium">{current?.name || '账本'}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setOpen(false)}>
          <div className="w-72 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">选择账本</h3>
            <div className="space-y-1">
              {ledgers.map((l) => (
                <button
                  key={l.id}
                  onClick={() => doSwitch(l.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${l.id === currentId ? '' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
                  style={l.id === currentId ? { background: 'var(--color-primary)', color: '#fff' } : {}}
                >
                  <span>{l.icon}</span>
                  <span>{l.name}</span>
                  {l.id === currentId && <span className="ml-auto text-xs">✓</span>}
                </button>
              ))}
            </div>
            <button
              onClick={() => setManage(true)}
              className="mt-3 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-muted hover:bg-black/5 dark:hover:bg-white/5"
            >
              管理账本…
            </button>
          </div>
        </div>
      )}

      {manage && <LedgerManager currentId={currentId} onSwitch={doSwitch} onClose={() => setManage(false)} />}
    </>
  );
}

function LedgerManager({ currentId, onSwitch, onClose }: { currentId: number; onSwitch: (id: number) => void; onClose: () => void }) {
  const { data: ledgers = [] } = useLedgers();
  const { create, update, remove } = useLedgerMutations();
  const [name, setName] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [delId, setDelId] = useState<number | null>(null);
  const [showCopy, setShowCopy] = useState(false);
  // 关闭时若输入框还有内容（新建/重命名未保存），走拦截确认
  const [closeConfirm, setCloseConfirm] = useState(false);

  // 有未保存输入：输入框内容非空即视为「正在编辑」
  const dirty = name.trim() !== '';

  /** 保存账本；返回是否成功，供「保存并关闭」判断能否关闭 */
  async function save(): Promise<boolean> {
    if (!name.trim()) {
      toast.error('请输入账本名称');
      return false;
    }
    try {
      if (editId) {
        await update.mutateAsync({ id: editId, name });
        toast.success('已更新');
      } else {
        const id = await create.mutateAsync({ name });
        await onSwitch(id);
        toast.success('已创建并切换');
      }
      setName('');
      setEditId(null);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }

  /** 统一关闭入口：✕ 与 Esc 都经此，未保存时先确认 */
  function requestClose() {
    if (dirty) {
      setCloseConfirm(true);
      return;
    }
    onClose();
  }

  async function saveAndClose() {
    const ok = await save();
    if (ok) {
      setCloseConfirm(false);
      onClose();
    }
  }

  // Esc 键：确认弹窗打开时先收起确认；删除确认/复制向导打开时不抢键盘（由上层自身处理）
  useEscapeClose(closeConfirm, () => setCloseConfirm(false));
  useEscapeClose(!closeConfirm && delId == null && !showCopy, requestClose);

  async function doDelete() {
    if (delId == null) return;
    try {
      const next = ledgers.find((l) => l.id !== delId);
      await remove.mutateAsync(delId);
      if (delId === currentId && next) await onSwitch(next.id);
      setDelId(null);
      toast.success('已删除');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    // 该弹窗含未保存输入（新账本名称 / 重命名）：不提供「点遮罩关闭」，
    // 关闭入口仅保留标题栏 ✕ 按钮，避免误点外部导致正在输入的名称丢失。
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30">
      <div className="w-[400px] rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">账本管理</h3>
          <button onClick={requestClose} className="text-sm text-muted hover:text-[var(--color-danger)]">✕</button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <Input placeholder="新账本名称" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
          <Button size="sm" onClick={save}>{editId ? '更新' : '创建'}</Button>
          {editId && <Button size="sm" variant="ghost" onClick={() => { setEditId(null); setName(''); }}>取消</Button>}
        </div>

        <ul className="space-y-1">
          {ledgers.map((l) => (
            <li key={l.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <span>{l.icon}</span>{l.name}
                {l.id === currentId && <span className="text-xs text-[var(--color-primary-fg)]">（当前）</span>}
              </span>
              {editId !== l.id && (
                <span className="flex gap-2">
                  <button className="text-xs text-[var(--color-primary-fg)] hover:underline" onClick={() => { setEditId(l.id); setName(l.name); }}>重命名</button>
                  <button className="text-xs text-[var(--color-danger)] hover:underline" onClick={() => setDelId(l.id)}>删除</button>
                </span>
              )}
            </li>
          ))}
        </ul>

        <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => setShowCopy(true)}>
          复制账本（迁移向导）…
        </Button>
      </div>

      {showCopy && <CopyLedgerWizard onClose={() => setShowCopy(false)} />}

      {/* 未保存拦截：关闭（含 Esc）时若输入框仍有内容，先让用户选择处理方式 */}
      <UnsavedCloseDialog
        open={closeConfirm}
        canSave
        onContinue={() => setCloseConfirm(false)}
        onDiscard={() => { setCloseConfirm(false); onClose(); }}
        onSave={() => void saveAndClose()}
      />

      {delId != null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onClick={() => setDelId(null)}>
          <div className="w-80 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" onClick={(e) => e.stopPropagation()}>
            <p className="mb-4 text-sm">删除该账本将同时删除其账户、交易、借贷与储蓄数据，确定删除？</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDelId(null)}>取消</Button>
              <Button size="sm" variant="danger" onClick={doDelete}>删除</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}