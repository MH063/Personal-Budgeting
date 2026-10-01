import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { getKV, setKV } from '@/api/kv';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UPDATE_REPO_KEY } from '@/lib/constants';
import { compareVersion, parseRepoSlug } from '@/lib/version';

/** 是否 Tauri 桌面运行时 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 关于系统：版本信息、更新检查（GitHub Releases）、版权与技术架构说明。
 * 更新检查经 tauri-plugin-http（Rust 侧发请求）访问 GitHub API，避免 WebView CSP 拦截；
 * 未配置仓库地址时仅提示，不发起任何网络请求。
 */
export default function AboutSystem() {
  const tauri = isTauri();
  const [version, setVersion] = useState('');
  const [repo, setRepo] = useState(() => getKV(UPDATE_REPO_KEY));
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<{ tag: string; url: string; notes: string } | null>(null);

  useEffect(() => {
    (async () => {
      if (!tauri) return;
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setVersion(await getVersion());
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[about] 获取应用版本失败：', e);
      }
    })();
  }, [tauri]);

  /** 保存 GitHub 仓库地址（归一化为 owner/repo 存 settings 表） */
  async function saveRepo() {
    const slug = parseRepoSlug(repo);
    if (!slug) {
      toast.warning('请填写 owner/repo 或完整 GitHub 仓库地址');
      return;
    }
    await setKV(UPDATE_REPO_KEY, slug);
    setRepo(slug);
    toast.success('已保存仓库地址');
  }

  /** 检查更新：读取 GitHub Releases 最新发布，与当前版本比较（仅 https，经 Rust 侧发起） */
  async function checkUpdate() {
    const slug = parseRepoSlug(getKV(UPDATE_REPO_KEY));
    if (!slug) {
      toast.warning('请先填写并保存 GitHub 仓库地址');
      return;
    }
    setChecking(true);
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      const res = await tauriFetch(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
      const tag = String(j.tag_name ?? '').replace(/^v/i, '');
      if (!tag) throw new Error('发布信息缺少版本号');
      // eslint-disable-next-line no-console
      console.log('[about] 检查更新：远端版本', tag, '本地版本', version);
      if (compareVersion(tag, version || '0.0.0') > 0) {
        setUpdate({ tag, url: String(j.html_url ?? ''), notes: String(j.body ?? '').slice(0, 800) });
        toast.success(`发现新版本 v${tag}`);
      } else {
        setUpdate(null);
        toast.success('当前已是最新版本');
      }
    } catch (e) {
      toast.error(`检查更新失败：${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  }

  /** 在默认浏览器中打开链接（Rust 命令，仅允许 https，避免命令注入） */
  async function openUrl(url: string) {
    if (!url) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url });
    } catch (e) {
      toast.error(`打开链接失败：${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-3">
      {/* —— 版本与更新 —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-primary)] text-xl text-white">¥</div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">个人记账</h3>
            <p className="text-sm text-muted">版本 {version ? `v${version}` : '（桌面版可读取）'}</p>
          </div>
          <Button size="sm" onClick={() => void checkUpdate()} disabled={!tauri || checking}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted">更新仓库（GitHub，owner/repo）</label>
          <div className="flex gap-2">
            <Input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="例如：yourname/moneybook"
              className="max-w-sm"
            />
            <Button size="sm" variant="outline" onClick={() => void saveRepo()}>保存</Button>
          </div>
          <p className="mt-1 text-xs text-muted">
            版本信息来自 GitHub Releases 的最新发布；点击「检查更新」将比较版本并给出下载入口。
          </p>
        </div>

        {update && (
          <div className="mt-3 rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">发现新版本 v{update.tag}</span>
              <span className="h-px flex-1 bg-[var(--border)]" />
              <Button size="sm" onClick={() => void openUrl(update.url)}>前往下载</Button>
            </div>
            {update.notes && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted">{update.notes}</pre>
            )}
          </div>
        )}
        {!tauri && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">浏览器预览下无法读取版本与发起更新检查，请在桌面版使用。</p>
        )}
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