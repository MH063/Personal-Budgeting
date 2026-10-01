// 通知中心数据组装（纯函数，无副作用，便于单元测试）
// -----------------------------------------------------------------------------
// 输入各提醒来源的汇总数据，输出渲染用的通知项列表与总条数。
// 与 UI 解耦：NotificationBell 只负责展示与跳转，数据拼装逻辑全部在此。
// -----------------------------------------------------------------------------

export type NoticeTone = 'danger' | 'warn' | 'info';

export interface NoticeItem {
  key: string;
  icon: string;
  title: string;
  desc: string;
  to: string;
  tone: NoticeTone;
}

export interface NoticeInput {
  /** 逾期借贷数量 */
  overdueCount: number;
  /** 逾期借贷对方名称（取前几条） */
  overduePartyNames: string[];
  /** 本月预算超支列表（status='over'，含分类名与实际/可用额） */
  overBudgets: Array<{ category_name: string | null; actual: number; usable: number }>;
  /** 回收站可恢复记录数 */
  trashCount: number;
  /** 已到期、待一键入账的周期记账项（前端按 next_run 触发判断） */
  dueRecurrings: Array<{ note: string | null; amount: number; type: string }>;
  /** 本地存储占用（百分比 / 已用 / 配额） */
  storageUsage: { percent: number | null; usedBytes: number; quotaBytes: number | null } | null;
}

export interface NoticeResult {
  notices: NoticeItem[];
  total: number;
}

/** 本地存储阈值：超过 75% 提醒备份 */
export const STORAGE_WARN_PERCENT = 75;

/** 组装通知项列表（顺序：逾期借贷 → 预算超支 → 周期记账到期 → 回收站 → 存储告警） */
export function buildNotices(input: NoticeInput): NoticeResult {
  const notices: NoticeItem[] = [];

  if (input.overdueCount > 0) {
    const names = input.overduePartyNames.slice(0, 3).join('、');
    notices.push({
      key: 'overdue',
      icon: '⚠️',
      title: `${input.overdueCount} 笔借贷已逾期`,
      desc: names + (input.overdueCount > 3 ? ` 等 ${input.overdueCount} 笔` : '') + '，请及时处理还款或结清。',
      to: '/loans',
      tone: 'danger',
    });
  }

  if (input.overBudgets.length > 0) {
    const top = input.overBudgets[0];
    notices.push({
      key: 'budget',
      icon: '📊',
      title: `${input.overBudgets.length} 项预算已超支`,
      desc: top.category_name
        ? `${top.category_name}：已支出 ${formatMoney(top.actual)}，超预算 ${formatMoney(top.actual - top.usable)}`
        : '请到预算页查看并进行调整。',
      to: '/settings?tab=budget',
      tone: 'warn',
    });
  }

  if (input.dueRecurrings.length > 0) {
    const sample = input.dueRecurrings[0];
    const first = sample.note || (sample.type === 'income' ? '收入' : sample.type === 'transfer' ? '转账' : '支出');
    const totalMoney = input.dueRecurrings.reduce((s, r) => s + (Math.abs(r.amount) || 0), 0);
    notices.push({
      key: 'recurring',
      icon: '🔁',
      title: `${input.dueRecurrings.length} 项周期记账今日到期`,
      desc: `合计约 ${formatMoney(totalMoney)}，含「${first}」等。点击一键入账到对账期间。`,
      to: '/settings?tab=recurring',
      tone: 'info',
    });
  }

  if (input.trashCount > 0) {
    notices.push({
      key: 'trash',
      icon: '🗑️',
      title: `回收站有 ${input.trashCount} 条可恢复记录`,
      desc: '误删除的数据可在回收站中恢复，或彻底清理。',
      to: '/trash',
      tone: 'info',
    });
  }

  const s = input.storageUsage;
  if (s && s.percent != null && s.percent >= STORAGE_WARN_PERCENT) {
    notices.push({
      key: 'storage',
      icon: '💾',
      title: `本地存储已用 ${s.percent}%`,
      desc: s.quotaBytes != null
        ? `已用 ${formatBytes(s.usedBytes)} / 约 ${formatBytes(s.quotaBytes)}，建议及时备份清理。`
        : '请及时导出备份，避免数据丢失。',
      to: '/settings?tab=backup',
      tone: 'warn',
    });
  }

  return { notices, total: notices.length };
}

/** 金额格式化（千分位 + 两位小数） */
export function formatMoney(v: number): string {
  const n = Math.abs(Number(v) || 0);
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 字节数 → 人类可读字符串 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}