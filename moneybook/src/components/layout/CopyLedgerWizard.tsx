import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLedgers, useLedgerMutations, useSwitchLedger } from '@/hooks/useLedgers';
import { useLedgerStore } from '@/stores/useLedgerStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEscapeClose, UnsavedCloseDialog } from '@/components/ui/unsaved-guard';
import type { CopyReport } from '@/api/ledgers';

export function CopyLedgerWizard({ onClose }: { onClose: () => void }) {
  const { data: ledgers = [] } = useLedgers();
  const { copy, create } = useLedgerMutations();
  const currentId = useLedgerStore((s) => s.currentId);
  const switchLedger = useSwitchLedger();

  const others = useMemo(() => ledgers.filter((l) => l.id !== currentId), [ledgers, currentId]);

  const [targetMode, setTargetMode] = useState<'new' | 'existing'>('new');
  const [sourceId, setSourceId] = useState<number>(currentId);
  const [targetId, setTargetId] = useState<number>(others[0]?.id ?? 0);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CopyReport | null>(null);
  // 复制后是否切换过去
  const [autoSwitch, setAutoSwitch] = useState(true);
  // 关闭向导时若目标名称已输入（未执行复制），走未保存拦截确认
  const [closeConfirm, setCloseConfirm] = useState(false);

  const source = ledgers.find((l) => l.id === sourceId);
  const targetName = targetMode === 'new' && newName.trim() ? newName.trim()
    : ledgers.find((l) => l.id === targetId)?.name ?? '';

  // 有未保存输入：目标账本名称非空即视为「配置中」
  const dirty = newName.trim() !== '';

  /**
   * 统一关闭入口：✕ 与「取消」、Esc 都经此。
   * 向导无「保存」语义（复制是显式主操作），故仅提供 继续编辑 / 不保存并关闭。
   */
  function requestClose() {
    if (!report && dirty) {
      setCloseConfirm(true);
      return;
    }
    onClose();
  }

  // Esc 键：确认弹窗打开时先收起确认；否则走 requestClose（结果视图直接关闭）
  useEscapeClose(closeConfirm, () => setCloseConfirm(false));
  useEscapeClose(!closeConfirm, requestClose);

  async function confirm() {
    if (targetMode === 'new' && !newName.trim()) return toast.error('请输入目标账本名称');
    if (targetMode === 'existing' && !targetId) return toast.error('请选择目标账本');
    setBusy(true);
    try {
      let tid = targetId;
      if (targetMode === 'new') {
        tid = await create.mutateAsync({ name: newName.trim() });
      }
      const res = await copy.mutateAsync({ sourceId, targetId: tid });
      setReport(res);
      if (autoSwitch && res.targetId) await switchLedger(res.targetId);
      toast.success(`已从「${res.sourceName}」复制到「${res.targetName}」`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // 视图 1：选择源 / 目标
  // 该步含未保存选择（目标账本名称等）：不提供「点遮罩关闭」，
  // 关闭入口仅保留标题栏 ✕ 与「取消」按钮，避免误点外部导致向导配置丢失。
  if (!report) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30">
        <div className="w-[440px] rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold">复制账本（迁移向导）</h3>
            <button onClick={requestClose} className="text-sm text-muted hover:text-[var(--color-danger)]">✕</button>
          </div>

          {/* 源账本 */}
          <label className="mb-1 block text-xs text-muted">源账本</label>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(Number(e.target.value))}
            className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm"
          >
            {ledgers.map((l) => (
              <option key={l.id} value={l.id}>{l.icon} {l.name}{l.id === currentId ? '（当前）' : ''}</option>
            ))}
          </select>

          {/* 目标方式 */}
          <label className="mb-1 block text-xs text-muted">复制到</label>
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => setTargetMode('new')}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm ${targetMode === 'new' ? 'border-[var(--color-primary)] text-[var(--color-primary-fg)]' : 'border-[var(--border)] text-muted'}`}
            >
              新建账本
            </button>
            <button
              onClick={() => setTargetMode('existing')}
              disabled={others.length === 0}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm ${targetMode === 'existing' ? 'border-[var(--color-primary)] text-[var(--color-primary-fg)]' : 'border-[var(--border)] text-muted'} disabled:opacity-40`}
            >
              复制到现有账本
            </button>
          </div>

          {targetMode === 'new' ? (
            <Input placeholder="目标账本名称（如：家庭账本）" value={newName} onChange={(e) => setNewName(e.target.value)} />
          ) : (
            <select
              value={targetId}
              onChange={(e) => setTargetId(Number(e.target.value))}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm"
            >
              {others.map((l) => (
                <option key={l.id} value={l.id}>{l.icon} {l.name}</option>
              ))}
            </select>
          )}

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />
            完成后切换到目标账本
          </label>

          <p className="mt-3 rounded-lg bg-black/5 p-2 text-xs leading-relaxed text-muted dark:bg-white/5">
            将复制「{source?.name}」的账户、交易、借贷、储蓄目标、预算、周期任务与投资持仓到「{targetName || '目标账本'}」。
            分类与标签为全局共享，将原样沿用。
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={requestClose} disabled={busy}>取消</Button>
            <Button size="sm" onClick={confirm} disabled={busy}>{busy ? '复制中…' : '开始复制'}</Button>
          </div>
        </div>

        {/* 未保存拦截：目标名称已输入但尚未复制时，关闭（含 Esc）先确认 */}
        <UnsavedCloseDialog
          open={closeConfirm}
          canSave={false}
          onContinue={() => setCloseConfirm(false)}
          onDiscard={() => { setCloseConfirm(false); onClose(); }}
        />
      </div>
    );
  }

  // 视图 2：复制结果
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-[440px] rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
        <h3 className="mb-1 font-semibold">复制完成</h3>
        <p className="mb-4 text-sm text-muted">
          已从「{report.sourceName}」复制到「{report.targetName}」
          {autoSwitch && '（已切换到目标账本）'}
        </p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <ReportItem label="账户" value={report.accounts} />
          <ReportItem label="交易" value={report.transactions} />
          <ReportItem label="贷款" value={report.loans} />
          <ReportItem label="还款记录" value={report.loanRepayments} />
          <ReportItem label="储蓄目标" value={report.savingsGoals} />
          <ReportItem label="预算" value={report.budgets} />
          <ReportItem label="周期任务" value={report.recurring} />
          <ReportItem label="投资持仓" value={report.holdings} />
          <ReportItem label="跳过（引用缺失）" value={report.skipped} danger={report.skipped > 0} />
        </div>
        {report.skipped > 0 && (
          <p className="mt-2 rounded-lg bg-[var(--color-danger)]/10 p-2 text-xs text-[var(--color-danger)]">
            有 {report.skipped} 条记录因源账本内引用到的账户不存在而被跳过，未复制到目标账本。
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>完成</Button>
        </div>
      </div>
    </div>
  );
}

function ReportItem({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2">
      <span className="text-muted">{label}</span>
      <span className={`font-medium ${danger ? 'text-[var(--color-danger)]' : ''}`}>{value}</span>
    </div>
  );
}