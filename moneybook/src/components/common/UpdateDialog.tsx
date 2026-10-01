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
  const install = useUpdateStore((s) => s.install);
  const close = useUpdateStore((s) => s.close);
  if (!info) return null;

  /** 下载中/安装中：UI 切换为进度视图，且不渲染任何可关闭/放弃的按钮 */
  const busy = phase === 'downloading' || phase === 'installing';
  /** 总长度未知（服务端未提供）时按 0 处理，进度条走不确定态（仅展示已下载量） */
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;

  return (
    <Modal open={open} onClose={close} title={`发现新版本 V${info.version}`}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          当前版本 <span className="font-medium text-[var(--text)]">{formatAppVersion()}</span>
          <span className="mx-2">→</span>
          新版本 <span className="font-medium text-[var(--color-primary)]">V{info.version}</span>
        </p>

        {info.notes && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-muted">
            {info.notes}
          </pre>
        )}

        {busy ? (
          // —— 下载/安装进度视图：此阶段弹窗不可关闭，提示用户勿关闭应用 ——
          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
            <p className="text-xs text-muted">
              {phase === 'downloading'
                ? `正在下载更新包…${
                    total > 0 ? ` ${toMb(downloaded)} MB / ${toMb(total)} MB` : ` 已下载 ${toMb(downloaded)} MB`
                  }`
                : '下载完成，正在安装…应用即将自动重启'}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-all"
                style={{ width: `${phase === 'installing' ? 100 : percent}%` }}
              />
            </div>
            <p className="text-[11px] text-muted">
              更新包需通过内置公钥签名校验后才会安装；安装完成会自动重启，请勿关闭应用。
            </p>
          </div>
        ) : (
          <>
            {phase === 'error' && (
              <div
                className="rounded-lg border border-[var(--border)] p-3 text-xs"
                style={{ color: 'var(--color-danger)' }}
              >
                更新失败：{error || '未知错误'}
              </div>
            )}

            <p className="text-xs text-muted">
              点「立即更新」将在应用内自动下载并安装（签名校验通过后才会执行），完成后自动重启进入新版本；覆盖安装不会清理本机账本数据。
            </p>

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {phase === 'error' && (
                <Button variant="outline" size="sm" onClick={() => void openExternal(info.url)}>
                  前往下载页
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  skipVersion(info.version);
                  toast.success(`已跳过 V${info.version}，后续更高版本仍会提醒`);
                  close();
                }}
              >
                跳过此版本
              </Button>
              <Button variant="outline" size="sm" onClick={close}>
                稍后提醒
              </Button>
              <Button size="sm" onClick={() => void install()}>
                {phase === 'error' ? '重试更新' : '立即更新'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}