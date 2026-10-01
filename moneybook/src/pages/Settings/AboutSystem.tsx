import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { formatAppVersion } from '@/lib/appVersion';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { openExternal, UPDATE_RELEASES_PAGE } from '@/lib/update';

/**
 * 关于系统：版本信息、更新检查（内置 GitHub Releases）、版权与技术架构说明。
 * 更新仓库内置为常量（见 lib/update.ts 的 UPDATE_REPO_SLUG），用户无需填写；
 * 版本号统一来自 src/lib/appVersion.ts（由 scripts/sync-version.mjs 从 package.json 同步）；
 * 检查结果由全局 UpdateDialog 弹窗统一呈现（与启动自动扫描共用同一逻辑）。
 * 「前往下载页」为手动兜底入口：GitHub 不可达时仍可通过下载安装包覆盖安装（不影响数据）。
 */
export default function AboutSystem() {
  const checking = useUpdateStore((s) => s.checking);
  const checkManually = useUpdateStore((s) => s.checkManually);

  return (
    <div className="space-y-3">
      {/* —— 版本与更新 —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-primary)] text-xl text-white">¥</div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">个人记账</h3>
            <p className="text-sm text-muted">版本 {formatAppVersion()}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={() => void checkManually()} disabled={checking}>
              {checking ? '检查中…' : '检查更新'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void openExternal(UPDATE_RELEASES_PAGE)}>
              前往下载页
            </Button>
          </div>
        </div>
      </div>

      {/* —— 版权与技术架构 —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-center">
        <p className="text-xs text-muted">Copyright © 2026 个人记账. All Rights Reserved.</p>
        <p className="mt-1 text-xs text-muted">
          基于 Tauri 2 · React 19 · SQLite 技术架构构建
          <span className="mx-1.5">·</span>
          <Link to="/settings?tab=help" className="text-[var(--color-primary)] hover:underline">使用说明</Link>
        </p>
        <p className="mt-1 text-xs text-muted">数据全部保存在本机，不上传云端。</p>
      </div>
    </div>
  );
}