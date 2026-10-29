import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { rowKeyOf, type ImportRow } from '@/api/import';
import { isTauriRuntime } from '@/lib/runtime';
import { IMPORT_PREVIEW_KEY } from './helpers';
import ImportPreviewBody from './ImportPreviewBody';

/**
 * 「导入解析结果」独立窗口页面（由主窗口 invoke open_import_preview 打开；
 * 该窗口标签为 import-preview，前端在 main.tsx 按标签直接渲染本页，不依赖 hash 路由）。
 * 数据通道：主窗口解析成功后把预览数据写入 localStorage 快照（IMPORT_PREVIEW_KEY），
 * 本页从快照重建可编辑预览，编辑实时写回快照；点「开始导入」时 emit import:preview-submit
 * 把编辑后的行与「将创建账户」改名结果交回主窗口执行真实导入，随后自动关闭本窗口。
 * 主窗口重新解析 → storage 事件跨窗口触发本页刷新，保证始终展示最新解析结果。
 */
interface PreviewSnapshot {
  rows: ImportRow[];
  dupLines: number[];
  parseWarn: string[];
  pendingAccounts: string[];
}

/** 读取主窗口写入的预览快照；缺失或格式损坏时返回 null（显示空态引导回主窗口解析） */
function loadSnapshot(): PreviewSnapshot | null {
  try {
    const raw = localStorage.getItem(IMPORT_PREVIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreviewSnapshot;
    if (!Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 把当前编辑后的预览数据写回快照：窗口刷新/重开时数据不丢，主窗口也能在提交后读到最新行 */
function saveSnapshot(snap: PreviewSnapshot) {
  localStorage.setItem(IMPORT_PREVIEW_KEY, JSON.stringify(snap));
}

export default function ImportPreviewPage() {
  const [snap, setSnap] = useState<PreviewSnapshot | null>(() => loadSnapshot());
  const [busy, setBusy] = useState(false);

  // 主窗口重新解析后写新快照 → storage 事件跨窗口触发本页刷新
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== IMPORT_PREVIEW_KEY) return;
      setSnap(loadSnapshot());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /** 更新快照并同步写回 localStorage */
  function updateSnap(next: PreviewSnapshot) {
    setSnap(next);
    saveSnapshot(next);
  }

  /** 逐行纠错：按「行唯一标识」更新（与主窗口 patchRow 同一口径） */
  function patchRow(key: string, patch: Partial<ImportRow>) {
    if (!snap) return;
    updateSnap({ ...snap, rows: snap.rows.map((r) => (rowKeyOf(r) === key ? { ...r, ...patch } : r)) });
  }

  /** 确认某「待确认」行（退款/提现去向已核对无误，清除提醒标记） */
  function confirmRow(key: string) {
    patchRow(key, { _pending: undefined });
  }

  /** 删除某待导入行（误判严重可直接移出本次导入） */
  function removeRow(key: string) {
    if (!snap) return;
    updateSnap({ ...snap, rows: snap.rows.filter((r) => rowKeyOf(r) !== key) });
  }

  /** 改名「将创建账户」：同步改写快照内所有使用该账户名的待导入行 */
  function renamePending(oldName: string, newName: string) {
    if (!snap) return;
    updateSnap({
      ...snap,
      pendingAccounts: snap.pendingAccounts.map((n) => (n === oldName ? newName : n)),
      rows: snap.rows.map((r) => (r.account === oldName ? { ...r, account: newName } : r)),
    });
  }

  /** 将全部「待确认」行标记为无需复核 */
  function clearPending() {
    if (!snap) return;
    updateSnap({ ...snap, rows: snap.rows.map((r) => (r._pending ? { ...r, _pending: undefined } : r)) });
  }

  /** 关闭本窗口（仅桌面端存在真实窗口；浏览器预览无窗口能力时忽略） */
  function closeWindow() {
    if (isTauriRuntime()) void getCurrentWindow().close();
  }

  /** 提交导入：把编辑后的行与账户改名结果交回主窗口执行，成功后自关窗口 */
  async function submitImport() {
    if (!snap) return;
    const validCount = snap.rows.filter((r) => !r._skippedReason).length;
    if (!validCount) return;
    if (!isTauriRuntime()) {
      toast.warning('请回到主窗口执行导入（独立预览窗口仅桌面端支持）');
      return;
    }
    setBusy(true);
    try {
      // Tauri 事件传参为结构化克隆，ImportRow 纯对象可直接传递；主窗口监听后执行真实导入
      await emit('import:preview-submit', {
        rows: snap.rows,
        pendingAccounts: snap.pendingAccounts,
      });
      await getCurrentWindow().close();
    } catch (e) {
      toast.error(`提交失败：${(e as Error).message}（请回到主窗口重试）`);
      setBusy(false);
    }
  }

  const validCount = snap?.rows.filter((r) => !r._skippedReason).length ?? 0;
  const total = snap?.rows.reduce((s, r) => (r.type === 'expense' && !r._skippedReason ? s + r.amount : s), 0) ?? 0;
  const pendingRows = snap?.rows.filter((r) => !r._skippedReason && r._pending) ?? [];
  const dupSet = new Set(snap?.dupLines ?? []);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
        <h1 className="text-base font-semibold">导入解析结果</h1>
        <button type="button"
          onClick={closeWindow}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-muted hover:bg-[var(--color-primary)]/10 hover:text-[var(--fg)]">
          关闭窗口
        </button>
      </header>
      <main className="flex-1 overflow-auto p-5">
        {snap ? (
          <ImportPreviewBody
            rows={snap.rows}
            validCount={validCount}
            total={total}
            pendingRows={pendingRows}
            dupLines={dupSet}
            parseWarn={snap.parseWarn}
            pendingAccounts={snap.pendingAccounts}
            onRenamePending={renamePending}
            onPatchRow={patchRow}
            onConfirmRow={confirmRow}
            onRemoveRow={removeRow}
            onClearPending={clearPending}
            onClose={closeWindow}
            onImport={() => void submitImport()}
            busy={busy}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-sm text-muted">
            <p>暂无导入解析结果</p>
            <p className="text-xs">请回到主窗口选择并解析账单文件，解析结果将在此窗口展示。</p>
          </div>
        )}
      </main>
    </div>
  );
}
