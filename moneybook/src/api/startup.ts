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
  // 检测 Tauri 桌面运行时：不存在 __TAURI_INTERNALS__ 说明未在 Tauri WebView 内
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inTauri = typeof (window as any)?.__TAURI_INTERNALS__ !== 'undefined';
  if (!inTauri) {
    console.info('[startup] 非 Tauri 环境，跳过自动任务');
    return;
  }
  schedule(applyDueRecurring);       // 周期性记账到期生成
  schedule(applyDueAutoSavings);     // 储蓄目标自动计提
  schedule(checkOverdueLoans);       // 逾期判定 + 逾期利息累计
  schedule(ensureBudgetCurrentPeriod); // 预算滚动收口（未来起点异常行归一到当前期）
  schedule(checkBackupSafety);       // 备份/容量安全提醒
}

/** 等待已排队的启动任务完成（供需要时等待，非必须） */
export async function startupTasksDone(): Promise<void> {
  await Promise.allSettled(pending);
}