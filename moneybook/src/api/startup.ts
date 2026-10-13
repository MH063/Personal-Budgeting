// 应用启动/每日首访的"自动任务"统一触发点。
// 与具体页面解耦：周期性记账、储蓄自动计提、逾期利息累计不再依赖用户进入某个页面才运行。
// 各任务内部均自带"当天只跑一次"幂等语义，因此重复调用无副作用。
import { applyDueRecurring } from './recurring';
import { applyDueAutoSavings } from './savings';
import { checkOverdueLoans } from './loans';
import { ensureBudgetCurrentPeriod } from './budgetRollover';
import { estimateStorageUsage } from './db';
import { getKV, setKV, hydrateKV } from './kv';
import { toast } from 'sonner';
import { BACKUP_REMINDED_KEY, CAPACITY_WARN_PCT, LAST_BACKUP_KEY } from '@/lib/constants';
import { isTauriRuntime } from '@/lib/runtime';

let started = false;

const pending: Promise<unknown>[] = [];

function schedule(fn: () => Promise<unknown>) {
  const p = fn().catch((e) => {
    // 任务失败不应阻塞应用启动，仅记录
    console.error('[startup] 自动任务执行失败：', e);
  });
  pending.push(p);
}

/**
 * 启动时的系统临时文件与更新缓存清理操作。
 * 确保在清理过程中不影响客户端的正常启动。
 * 清理前需对所有临时文件进行分类识别，排除系统运行必需文件。
 */
async function cleanUpdateGarbage(): Promise<void> {
  try {
    const { tempDir } = await import('@tauri-apps/api/path');
    const { readDir, remove, stat } = await import('@tauri-apps/plugin-fs');
    const tmpPath = await tempDir();
    
    // 读取系统临时目录，寻找属于 Tauri updater 遗留的安装包文件
    // Updater 下载的包通常包含 "moneybook" 或 "tauri-updater" 前缀，且为 .zip 或 .exe
    const entries = await readDir(tmpPath);
    for (const entry of entries) {
      if (!entry.name) continue;
      const lowerName = entry.name.toLowerCase();
      // 识别：以 moneybook 开头且为安装包，或是 tauri-updater 产生的遗留缓存
      if (
        (lowerName.startsWith('moneybook') && (lowerName.endsWith('.zip') || lowerName.endsWith('.exe'))) ||
        lowerName.includes('tauri-updater')
      ) {
        try {
          const filePath = `${tmpPath}${entry.name}`;
          const fileStat = await stat(filePath);
          // 安全策略：仅清理 2 小时前的文件，防止误删正在后台下载的更新包
          if (fileStat.mtime) {
            const ageMs = Date.now() - fileStat.mtime.getTime();
            if (ageMs > 2 * 60 * 60 * 1000) {
              await remove(filePath, { recursive: false });
              console.log(`[cleanup] 已清理遗留的更新临时文件: ${entry.name}`);
            }
          }
        } catch (err) {
          // 忽略单个文件的删除错误（如权限不足或正在被占用）
        }
      }
    }
  } catch (e) {
    // 权限不足或不支持的平台，静默失败即可
  }
}

/**
 * 备份/容量安全提醒：每天最多提示一次；备份过旧或存储占用过高时提醒导出。
 * 偏好项（上次备份时间 / 上次提醒日期）均存数据库 settings 表，不再使用 localStorage。
 */
async function checkBackupSafety(): Promise<void> {
  try {
    await hydrateKV();
    const today = new Date().toDateString();
    if (getKV(BACKUP_REMINDED_KEY) === today) return;

    let remind = false;
    let reason = '';
    const lastBackup = getKV(LAST_BACKUP_KEY);
    if (!lastBackup) {
      remind = true;
      reason = '尚未进行过数据库备份';
    } else if (Date.now() - Number(lastBackup) > 30 * 24 * 3600 * 1000) {
      remind = true;
      reason = '超过 30 天未备份';
    }
    const usage = await estimateStorageUsage();
    if (usage && usage.percent != null && usage.percent >= CAPACITY_WARN_PCT) {
      remind = true;
      reason = reason ? `${reason}，且存储占用已达 ${usage.percent}%` : `存储占用已达 ${usage.percent}%`;
    }

    setKV(BACKUP_REMINDED_KEY, today);
    if (remind) {
      toast.warning(`数据安全提醒：${reason}。建议到「设置 → 备份与恢复」导出数据库备份，以防数据丢失。`, { duration: 8000 });
    }
  } catch {
    /* 提醒失败应静默，不影响启动 */
  }
}

/** 幂等触发全部启动自动任务（在该实例进程内只执行一次）。
 *  非 Tauri 环境（如纯浏览器预览，无 Tauri IPC）下数据库不可用，
 *  直接跳过全部任务，避免连库抛错刷屏 error 日志，也不影响桌面端正常运行。 */
export function runStartupTasks(): void {
  if (started) return;
  started = true;
  // 非 Tauri 环境（如纯浏览器预览，无 Tauri IPC）下数据库不可用，
  // 直接跳过全部任务，避免连库抛错刷屏 error 日志，也不影响桌面端正常运行。
  if (!isTauriRuntime()) {
    console.info('[startup] 非 Tauri 环境，跳过自动任务');
    return;
  }
  schedule(applyDueRecurring);       // 周期性记账到期生成
  schedule(applyDueAutoSavings);     // 储蓄目标自动计提
  schedule(checkOverdueLoans);       // 逾期判定 + 逾期利息累计
  schedule(ensureBudgetCurrentPeriod); // 预算滚动收口（未来起点异常行归一到当前期）
  schedule(checkBackupSafety);       // 备份/容量安全提醒
  schedule(cleanUpdateGarbage);      // 启动时清理上个版本的更新遗留安装包
}

/** 等待已排队的启动任务完成（供需要时等待，非必须） */
export async function startupTasksDone(): Promise<void> {
  await Promise.allSettled(pending);
}