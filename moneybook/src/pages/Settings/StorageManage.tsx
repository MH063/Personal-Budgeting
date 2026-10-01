import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getKV, setKV } from '@/api/kv';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { STORAGE_SAVE_DIR_KEY } from '@/lib/constants';

/** 存储概览（与 Rust get_storage_overview 返回结构一一对应） */
interface StorageOverview {
  appDir: string;
  /** 数据目录模式：portable（程序目录\data）/ standard（系统标准目录） */
  mode: 'portable' | 'standard';
  /** 便携目标目录（程序目录\data） */
  portableDir: string;
  /** 是否可迁移到程序目录（标准模式 + 程序目录可写 + 便携目录尚无库） */
  canMigrate: boolean;
  dbSize: number;
  walSize: number;
  bakSize: number;
  cacheSize: number;
  appTotal: number;
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
}

/** 字节数 → 人类可读（B/KB/MB/GB/TB） */
function fmtSize(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 是否 Tauri 桌面运行时（浏览器预览下原生命令不可用） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 占比条：占用率着色（<70% 主色、70~90% 黄、>90% 红） */
function UsageBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped > 90 ? 'var(--color-danger, #ef4444)' : clamped > 70 ? '#f59e0b' : 'var(--color-primary)';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
      <div className="h-full rounded-full transition-all" style={{ width: `${clamped}%`, background: color }} />
    </div>
  );
}

/** 数据目录模式徽标（便携 / 系统目录） */
function ModeBadge({ mode }: { mode: 'portable' | 'standard' }) {
  const portable = mode === 'portable';
  return (
    <span
      className={
        portable
          ? 'rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]'
          : 'rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium text-muted dark:bg-white/10'
      }
    >
      {portable ? '便携模式' : '系统目录'}
    </span>
  );
}

/** 数据位置设计说明（收进 Hint，避免页面铺大段文字） */
const DATA_DIR_HINT =
  '全新安装：优先使用程序目录下的 data 文件夹（绿色便携版，数据随程序整体搬移）；' +
  '若程序安装在 Program Files 等无写权限位置，会自动回退到系统数据目录 %APPDATA%\\com.yourname.moneybook，无需手动设置。' +
  '已有数据的位置不会因升级或覆盖安装而改变。';

/** 导出默认目录说明（收进 Hint） */
const EXPORT_DIR_HINT =
  '设置应用内「另存为」对话框的默认定位目录（当前应用于数据库备份导出）；JSON / CSV 导出由浏览器下载，不受此设置影响。';

/**
 * 存储管理（设置 → 系统与存储）：
 *  - 数据保存位置：直接展示数据库真实所在完整路径（而非「系统默认」），
 *    含模式徽标；标准模式下且程序目录可写时提供「迁移到程序目录」入口；
 *  - 存储空间：电脑磁盘总/已用/可用占比 + 应用数据占用明细；
 *  - 缓存清理：仅删除可安全删除的残留（损坏库隔离文件 .corrupt.*、中断遗留 *.tmp），
 *    主库 / -wal / .bak 快照绝不触碰。
 */
export default function StorageManage() {
  const tauri = isTauri();
  const [saveDir, setSaveDir] = useState(() => getKV(STORAGE_SAVE_DIR_KEY));
  const [ov, setOv] = useState<StorageOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [pendingClean, setPendingClean] = useState(false);
  const [pendingMigrate, setPendingMigrate] = useState(false);

  /** 拉取存储概览（仅 Tauri 桌面版可用） */
  const refresh = useCallback(async () => {
    if (!tauri) return;
    setLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<StorageOverview>('get_storage_overview');
      setOv(data);
      // eslint-disable-next-line no-console
      console.log('[storage] 存储概览：', data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[storage] 获取存储概览失败：', e);
      toast.error(`获取存储信息失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [tauri]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 选择默认保存目录（系统目录选择框），写入 settings 表 */
  async function pickDir() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false, title: '选择默认保存位置' });
      if (typeof dir !== 'string') return;
      await setKV(STORAGE_SAVE_DIR_KEY, dir);
      setSaveDir(dir);
      toast.success('已设置默认保存位置');
    } catch (e) {
      toast.error(`选择目录失败：${(e as Error).message}`);
    }
  }

  /** 恢复系统默认保存位置（清空偏好项） */
  async function clearDir() {
    await setKV(STORAGE_SAVE_DIR_KEY, '');
    setSaveDir('');
    toast.success('已恢复系统默认保存位置');
  }

  /** 用资源管理器打开目录 */
  async function openDir(path: string) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_folder', { path });
    } catch (e) {
      toast.error(`打开目录失败：${(e as Error).message}`);
    }
  }

  /**
   * 迁移数据到程序目录（便携模式）：
   * Rust 侧用 VACUUM INTO 导出一致性快照 → 校验 → 原子落位；
   * 原数据保持原样（天然回滚兜底），重启应用后便携目录优先命中即完成切换。
   */
  async function doMigrate() {
    setMigrating(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const target = await invoke<string>('migrate_to_portable');
      // eslint-disable-next-line no-console
      console.log('[storage] 便携迁移完成：', target);
      toast.success('已迁移到程序目录，重启应用后生效（原数据保留作兜底）');
      await refresh();
    } catch (e) {
      toast.error(`迁移失败：${(e as Error).message}`);
    } finally {
      setMigrating(false);
    }
  }

  /** 清理缓存（用户确认后）：删除 .corrupt.* 与 *.tmp，返回释放字节数并刷新概览 */
  async function doClean() {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const freed = await invoke<number>('clean_storage_cache');
      // eslint-disable-next-line no-console
      console.log('[storage] 缓存清理释放字节数：', freed);
      toast.success(freed > 0 ? `已清理缓存，释放 ${fmtSize(freed)}` : '没有可清理的缓存文件');
      await refresh();
    } catch (e) {
      toast.error(`清理失败：${(e as Error).message}`);
    }
  }

  const diskPct = ov && ov.diskTotal > 0 ? (ov.diskUsed / ov.diskTotal) * 100 : 0;
  const appPct = ov && ov.diskTotal > 0 ? (ov.appTotal / ov.diskTotal) * 100 : 0;

  return (
    <div className="space-y-3">
      {!tauri && (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          浏览器预览下无法读取本机磁盘信息，请在 Tauri 桌面版查看存储状态与清理缓存。
        </div>
      )}

      {/* —— 数据保存位置（完整真实路径，而非「系统默认」） —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="flex items-center gap-1.5 font-semibold">
            数据保存位置
            <Hint text={DATA_DIR_HINT} />
          </h3>
          {ov && <ModeBadge mode={ov.mode} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="max-w-full truncate rounded-lg bg-black/5 px-2.5 py-1.5 text-xs dark:bg-white/10">
            {ov ? ov.appDir : tauri ? '读取中…' : '桌面版中显示真实路径'}
          </code>
          {ov && (
            <Button size="sm" variant="outline" onClick={() => void openDir(ov.appDir)} disabled={!tauri}>
              打开
            </Button>
          )}
          {ov?.canMigrate && (
            <Button size="sm" onClick={() => setPendingMigrate(true)} disabled={!tauri || migrating}>
              {migrating ? '迁移中…' : '迁移到程序目录'}
            </Button>
          )}
        </div>
        {ov && (
          <p className="mt-2 text-xs text-muted break-all">
            数据库文件：{ov.appDir}\moneybook.db（{fmtSize(ov.dbSize)}）
          </p>
        )}

        {/* 导出默认目录（次级设置，说明收进 Hint） */}
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm text-muted">
            导出文件默认目录
            <Hint text={EXPORT_DIR_HINT} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded-lg bg-black/5 px-2.5 py-1.5 text-xs dark:bg-white/10">
              {saveDir || '系统默认（未设置）'}
            </code>
            <Button size="sm" variant="outline" onClick={pickDir} disabled={!tauri}>选择目录</Button>
            {saveDir && <Button size="sm" variant="outline" onClick={() => void openDir(saveDir)} disabled={!tauri}>打开</Button>}
            {saveDir && <Button size="sm" variant="ghost" onClick={clearDir}>恢复默认</Button>}
          </div>
        </div>
      </div>

      {/* —— 磁盘空间 —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">存储空间</h3>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={!tauri || loading}>
            {loading ? '读取中…' : '刷新'}
          </Button>
        </div>
        {ov && ov.diskTotal > 0 ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">电脑已用</div>
                <div className="text-sm font-semibold">{fmtSize(ov.diskUsed)}</div>
              </div>
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">电脑可用</div>
                <div className="text-sm font-semibold">{fmtSize(ov.diskFree)}</div>
              </div>
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">电脑总容量</div>
                <div className="text-sm font-semibold">{fmtSize(ov.diskTotal)}</div>
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted">
                <span>已用占比 {diskPct.toFixed(1)}%</span>
                <span>本应用占磁盘 {appPct.toFixed(2)}%</span>
              </div>
              <UsageBar pct={diskPct} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">{tauri ? '暂无法读取磁盘信息（非 Windows 平台或读取失败）。' : '桌面版中显示磁盘占用。'}</p>
        )}
      </div>

      {/* —— 应用占用明细与缓存清理 —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 flex items-center gap-1.5 font-semibold">
          应用数据占用
          <Hint text="应用全部数据存放在本机数据库文件中，体积通常为百 KB 级；缓存仅包含损坏隔离文件与中断遗留的临时文件，可放心清理。" />
        </h3>
        {ov ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">主数据库</div>
                <div className="font-medium">{fmtSize(ov.dbSize)}</div>
              </div>
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">预写日志</div>
                <div className="font-medium">{fmtSize(ov.walSize)}</div>
              </div>
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">安全快照</div>
                <div className="font-medium">{fmtSize(ov.bakSize)}</div>
              </div>
              <div className="rounded-lg bg-black/5 p-2 dark:bg-white/10">
                <div className="text-xs text-muted">可清理缓存</div>
                <div className="font-medium">{fmtSize(ov.cacheSize)}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">合计占用：{fmtSize(ov.appTotal)}</span>
              <span className="h-px flex-1 bg-[var(--border)]" />
              <Button size="sm" variant="outline" onClick={() => void openDir(ov.appDir)}>打开数据目录</Button>
              <Button size="sm" variant="danger" onClick={() => setPendingClean(true)} disabled={ov.cacheSize <= 0}>
                清理缓存{ov.cacheSize > 0 ? `（${fmtSize(ov.cacheSize)}）` : '（无）'}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">{tauri ? '读取中…' : '桌面版中显示应用数据占用。'}</p>
        )}
      </div>

      <ConfirmDialog
        open={pendingClean}
        title="清理缓存文件"
        description="将删除损坏库隔离文件（.corrupt.*）与中断遗留的临时文件（*.tmp）。主数据库、预写日志与安全快照不会被删除。确定继续吗？"
        confirmText="确认清理"
        danger
        onConfirm={() => void doClean()}
        onClose={() => setPendingClean(false)}
      />

      <ConfirmDialog
        open={pendingMigrate}
        title="迁移数据到程序目录"
        description={`将把数据库迁移到程序目录下的 data 文件夹（${ov?.portableDir || ''}），实现绿色便携、随程序整体搬移。迁移过程使用一致性快照并校验，原数据保留在原位置作为回滚兜底；重启应用后生效。确定迁移吗？`}
        confirmText="确认迁移"
        onConfirm={() => void doMigrate()}
        onClose={() => setPendingMigrate(false)}
      />
    </div>
  );
}