import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { listImportSkips, type ImportLog, type ImportSkip } from '@/api/importLog';

interface ImportHistoryPanelProps {
  /** 导入历史（审计记录，由父组件在导入成功后刷新） */
  logs: ImportLog[];
  /**
   * 把某次导入的跳过明细还原为待导入行（追加到父组件预览列表）。
   * @returns 是否成功还原（false 时保持弹窗打开，便于用户重新核对）
   */
  onRestoreSkips: (skips: ImportSkip[]) => boolean;
}

/**
 * 导入历史区块：展示历次导入的审计统计（成功/跳过/重复/建账户/建分类）。
 * 点击「跳过」数字可查看该次被跳过数据的明细（行号 + 原因 + 原始字段），并可一键补导入。
 * 「跳过明细弹窗」与「补导入二次确认」的状态在本组件内聚。
 * （自 ImportManage 页拆出，展示与交互保持不变。）
 */
export default function ImportHistoryPanel({ logs, onRestoreSkips }: ImportHistoryPanelProps) {
  const [skipView, setSkipView] = useState<{ log: ImportLog; skips: ImportSkip[]; loading: boolean } | null>(null);
  // 「补导入」二次确认：批量还原跳过数据为待导入行前先确认，避免误触加入大量行
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  // 「一键补导入全部跳过行」：汇总所有历史记录的跳过明细前先确认；busy 防重复点击
  const [restoreAllConfirm, setRestoreAllConfirm] = useState(false);
  const [restoreAllBusy, setRestoreAllBusy] = useState(false);

  if (logs.length === 0) return null;

  /** 打开某次导入的「跳过明细」弹窗：从 import_skips 表读取持久化的明细（行号 + 原因 + 原始字段） */
  async function openSkipView(log: ImportLog) {
    setSkipView({ log, skips: [], loading: true });
    try {
      const skips = await listImportSkips(log.id);
      setSkipView({ log, skips, loading: false });
    } catch {
      setSkipView({ log, skips: [], loading: false });
      toast.error('读取跳过明细失败');
    }
  }

  /** 一键补导入：汇总所有历史记录中持久化的跳过明细，一次还原为待导入行（仍需在预览中核对后导入） */
  async function restoreAllSkips() {
    setRestoreAllBusy(true);
    try {
      const all: ImportSkip[] = [];
      for (const log of logs) {
        if (!(log.skipped > 0)) continue;
        try {
          const skips = await listImportSkips(log.id);
          all.push(...skips);
        } catch { /* 单条历史读取失败忽略，其余照常汇总 */ }
      }
      if (!all.length) {
        toast.error('没有可补导入的跳过明细');
        setRestoreAllConfirm(false);
        return;
      }
      const ok = onRestoreSkips(all);
      if (ok) setRestoreAllConfirm(false);
    } finally {
      setRestoreAllBusy(false);
    }
  }

  const totalSkipped = logs.reduce((s, h) => s + (h.skipped || 0), 0);

  return (
    <>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">导入历史</h3>
          {totalSkipped > 0 && (
            <Button size="sm" variant="outline" disabled={restoreAllBusy} onClick={() => setRestoreAllConfirm(true)}>
              {restoreAllBusy ? '汇总中…' : `一键补导入全部跳过行（${totalSkipped}）`}
            </Button>
          )}
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-black/5 text-left text-muted dark:bg-white/5">
              <tr>
                <th className="px-2 py-1.5">时间</th>
                <th className="px-2 py-1.5">文件</th>
                <th className="px-2 py-1.5">文件数</th>
                <th className="px-2 py-1.5">成功</th>
                <th className="px-2 py-1.5">跳过</th>
                <th className="px-2 py-1.5">重复</th>
                <th className="px-2 py-1.5">建账户</th>
                <th className="px-2 py-1.5">建分类</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((h) => (
                <tr key={h.id} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 text-muted">{h.imported_at}</td>
                  <td className="px-2 py-1">{h.file_name}</td>
                  <td className="px-2 py-1">{h.file_count}</td>
                  <td className="px-2 py-1">{h.imported}</td>
                  <td className="px-2 py-1">
                    {h.skipped > 0 ? (
                      <button
                        className="font-medium underline decoration-dotted underline-offset-2 text-[var(--color-primary-fg)] hover:opacity-80"
                        title="查看被跳过的数据明细（可追溯、可补导入）"
                        onClick={() => void openSkipView(h)}
                      >
                        {h.skipped}
                      </button>
                    ) : (
                      h.skipped
                    )}
                  </td>
                  <td className="px-2 py-1 text-[var(--color-warning,#F59E0B)]">{h.duplicates}</td>
                  <td className="px-2 py-1">{h.created_accounts}</td>
                  <td className="px-2 py-1">{h.created_categories}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 导入历史「跳过」明细弹窗：持久化的跳过数据（行号 + 原因 + 原始字段）可追溯、可补导入 */}
      <Modal
        open={!!skipView}
        onClose={() => setSkipView(null)}
        title={skipView ? `跳过数据明细（${skipView.skips.length} 条 · ${skipView.log.imported_at}）` : '跳过数据明细'}
      >
        {skipView && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              以下数据在导入时被跳过、未进入账本；原因与原始字段已持久化保存，核对后可一键补导入。
            </p>
            {skipView.loading ? (
              <p className="py-6 text-center text-xs text-muted">读取中…</p>
            ) : skipView.skips.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">该次导入没有持久化的跳过明细。</p>
            ) : (
              <>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-black/5 text-left text-muted dark:bg-white/5">
                      <tr>
                        <th className="px-2 py-1.5">行号</th>
                        <th className="px-2 py-1.5">原因</th>
                        <th className="px-2 py-1.5">金额</th>
                        <th className="px-2 py-1.5">账户</th>
                        <th className="px-2 py-1.5">日期</th>
                        <th className="px-2 py-1.5">备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {skipView.skips.map((sk) => {
                        let row: Record<string, unknown> = {};
                        try { row = JSON.parse(sk.row_data) as Record<string, unknown>; } catch { /* 解析失败按空处理 */ }
                        return (
                          <tr key={sk.id} className="border-t border-[var(--border)]">
                            <td className="px-2 py-1 text-muted">第{sk.line}行</td>
                            <td className="px-2 py-1" title={sk.reason}>{sk.reason}</td>
                            <td className="px-2 py-1">{row.amount != null ? Number(row.amount) : '—'}</td>
                            <td className="px-2 py-1">{String(row.account ?? '—')}</td>
                            <td className="px-2 py-1 text-muted">{String(row.date ?? '—')}</td>
                            <td className="max-w-[180px] truncate px-2 py-1 text-muted" title={String(row.note ?? '')}>
                              {String(row.note ?? '—')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSkipView(null)}>关闭</Button>
                  {/* 先弹二次确认，避免误触将大量跳过行批量加入待导入列表 */}
                  <Button size="sm" onClick={() => setRestoreConfirmOpen(true)}>补导入（加入待导入列表）</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* 补导入二次确认：还原为待导入行（不直接进账本），确认后才加入预览列表供核对后导入 */}
      <ConfirmDialog
        open={restoreConfirmOpen}
        title="补导入跳过的数据"
        description={`将把本次 ${skipView?.skips.length ?? 0} 条被跳过的数据还原为待导入行（清除跳过标记、按原始字段恢复日期/金额/账户等），加入导入预览列表。它们不会直接进入账本，请在预览中核对修正后点击「开始导入」完成入库。确定补导入吗？`}
        confirmText="确认补导入"
        onConfirm={() => {
          const ok = skipView ? onRestoreSkips(skipView.skips) : false;
          setRestoreConfirmOpen(false);
          // 还原成功时关闭明细弹窗（与拆分前「setSkipView(null)」行为一致）
          if (ok) setSkipView(null);
        }}
        onClose={() => setRestoreConfirmOpen(false)}
      />

      {/* 一键补导入全部跳过行：汇总所有历史记录中持久化的跳过明细，二次确认后一次性还原为待导入行 */}
      <ConfirmDialog
        open={restoreAllConfirm}
        title="一键补导入全部跳过行"
        description={`将汇总所有导入历史中持久化的 ${totalSkipped} 条跳过数据，还原为待导入行并加入导入预览列表（清除跳过标记，按原始字段恢复日期/金额/账户等）。它们不会直接进入账本，请在预览中核对修正后点击「开始导入」完成入库。确定补导入吗？`}
        confirmText="确认补导入"
        onConfirm={() => void restoreAllSkips()}
        onClose={() => setRestoreAllConfirm(false)}
      />
    </>
  );
}
