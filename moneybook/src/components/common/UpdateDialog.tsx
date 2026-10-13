// 更新提示弹窗（全局单例）
// ---------------------------------------------------------------------------
// 启动自动扫描与「关于系统」页手动检查共用本弹窗。
// 用户出口（用户确认的设计）：
//   - 立即更新：应用内真实更新 —— 下载（带进度）→ Rust 侧签名校验 → 静默安装 →
//     自动重启；失败时提供「前往下载页」兜底；
//   - 稍后提醒：本次忽略，下次启动（超过节流窗口）仍会再检查；
//   - 跳过此版本：该版本永久静默，后续更高版本仍会提醒。
// 下载/安装期间不可关闭（✕ 与 Esc 均被 store.close 拦截），防打断关键流程。
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { formatAppVersion } from '@/lib/appVersion';
import { openExternal, skipVersion } from '@/lib/update';

/** 字节转 MB 文本（保留 1 位小数，仅用于进度展示） */
function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function UpdateDialog() {
  const open = useUpdateStore((s) => s.open);
  const info = useUpdateStore((s) => s.info);
  const phase = useUpdateStore((s) => s.phase);
  const downloaded = useUpdateStore((s) => s.downloaded);
  const total = useUpdateStore((s) => s.total);
  const error = useUpdateStore((s) => s.error);
  const download = useUpdateStore((s) => s.download);
  const apply = useUpdateStore((s) => s.apply);
  const close = useUpdateStore((s) => s.close);
  if (!info) return null;

  const busy = phase === 'downloading' || phase === 'installing';
  const ready = phase === 'ready';
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;

  return (
    <Modal open={open} onClose={close} title={ready ? '新版本已就绪' : `发现新版本 V${info.version}`}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          当前版本 <span className="font-medium text-[var(--fg)]">{formatAppVersion()}</span>
          <span className="mx-2">→</span>
          新版本 <span className="font-medium text-[var(--color-primary)]">V{info.version}</span>
        </p>

        {info.notes && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 text-xs leading-relaxed text-muted shadow-inner">
            {info.notes}
          </pre>
        )}

        {(busy || ready) ? (
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 shadow-sm">
            <p className="text-xs font-medium text-muted">
              {phase === 'downloading' && `正在后台下载更新包…${total > 0 ? ` ${toMb(downloaded)} MB / ${toMb(total)} MB` : ` 已下载 ${toMb(downloaded)} MB`}`}
              {phase === 'ready' && '下载完成，已准备好安装'}
              {phase === 'installing' && '正在安装并准备重启…'}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-300"
                style={{ width: `${(phase === 'ready' || phase === 'installing') ? 100 : percent}%` }}
              />
            </div>
            {phase === 'downloading' && (
              <p className="text-[11px] text-muted">
                你可以关闭此窗口，下载会在后台继续进行。下载完成后会通知你进行安装。
              </p>
            )}
            {phase === 'ready' && (
              <p className="text-[11px] text-muted">
                更新包已通过校验。点击下方按钮将立即安装并重启应用。
              </p>
            )}
            {phase === 'installing' && (
              <p className="text-[11px] text-[var(--color-warning)]">
                安装中，请勿强制关闭应用。
              </p>
            )}
          </div>
        ) : (
          <>
            {phase === 'error' && (
              <div className="space-y-1.5">
                <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 p-3 text-xs text-[var(--color-danger)]">
                  更新失败：{error || '未知错误'}
                </div>
                <p className="text-[11px] text-muted">
                  可稍后重试；也可点「前往下载页」下载安装包手动覆盖安装（不影响本机账本数据）。
                </p>
              </div>
            )}
            <p className="text-xs text-muted">
              点「开始下载」将在后台静默获取更新包。下载完成后，你可以随时选择合适的时机进行重启安装。
            </p>
          </>
        )}

        <div className="flex flex-wrap justify-end gap-3 pt-2">
          {phase === 'error' && (
            <Button variant="outline" size="sm" onClick={() => void openExternal(info.url)}>
              前往下载页
            </Button>
          )}

          {phase !== 'installing' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (phase === 'idle' || phase === 'error') skipVersion(info.version);
                close();
              }}
            >
              {phase === 'downloading' || phase === 'ready' ? '关闭窗口（后台进行）' : '跳过此版本'}
            </Button>
          )}

          {phase === 'idle' || phase === 'error' ? (
            <Button size="sm" onClick={() => void download()}>
              {phase === 'error' ? '重试下载' : '开始下载'}
            </Button>
          ) : phase === 'ready' ? (
            <Button size="sm" onClick={() => void apply()}>
              立即安装并重启
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}