export const ACCOUNT_TYPES = [
  { key: 'cash', label: '现金', icon: '💵', color: '#10B981' },
  { key: 'bank', label: '银行卡', icon: '🏦', color: '#1E6FA9' },
  { key: 'ewallet', label: '电子钱包', icon: '💬', color: '#10B981' },
  { key: 'credit', label: '信用卡', icon: '💳', color: '#EF4444' },
  { key: 'investment', label: '投资', icon: '📈', color: '#8B5CF6' },
  { key: 'savings', label: '储蓄', icon: '🐷', color: '#F59E0B' },
  { key: 'receivable', label: '应收款', icon: '📥', color: '#8B5CF6' },
  { key: 'payable', label: '应付款', icon: '📤', color: '#EC4899' },
] as const;

export const TX_TYPES: Record<
  string,
  { label: string; color: string; sign: '+' | '-' }
> = {
  income: { label: '收入', color: '#10B981', sign: '+' },
  expense: { label: '支出', color: '#EF4444', sign: '-' },
  transfer: { label: '转账', color: '#1E6FA9', sign: '+' },
  lend: { label: '借出', color: '#F59E0B', sign: '-' },
  borrow: { label: '借入', color: '#3B82F6', sign: '+' },
  repay_in: { label: '收回借款', color: '#10B981', sign: '+' },
  repay_out: { label: '偿还借款', color: '#EF4444', sign: '-' },
};

export const ASSET_TYPES = ['cash', 'bank', 'ewallet', 'investment', 'savings', 'receivable'];
export const LIABILITY_TYPES = ['credit', 'payable'];

// —— 数据安全 / 存储容量 ——
// 偏好项统一存数据库 settings 表（键前缀 kv.），不再使用 localStorage。
/** 记录最近一次"整库备份"成功的时间戳（毫秒） */
export const LAST_BACKUP_KEY = 'kv.backup.last';
/** 记录最近一次"提醒用户备份/容量不足"的日期串，避免每天重复打扰 */
export const BACKUP_REMINDED_KEY = 'kv.backup.reminded';
/** 本地存储占用达到该比例时提示应导出备份（桌面端无硬配额，仅在空间统计可用时参考） */
export const CAPACITY_WARN_PCT = 85;

// —— 界面偏好（settings 表） ——
/** 主题：light | dark */
export const THEME_KEY = 'kv.theme';
/** AI 配置快照 */
export const AI_CONFIG_KEY = 'kv.ai';
/** AI 知识库条目 */
export const KNOWLEDGE_KEY = 'kv.knowledge';
/** 智能洞察上次选中的分析维度 */
export const DIM_KEY = 'kv.stats.dim';
/** 设备指纹持久化 token */
export const DEVICE_TOKEN_KEY = 'kv.enc.device';
/** 存储管理：文件默认保存目录（备份文件导出对话框的默认前缀；空=系统默认） */
export const STORAGE_SAVE_DIR_KEY = 'kv.storage.save_dir';
/** 关于页：GitHub 仓库（owner/repo），用于检查更新（读取 Releases 最新版本） */
export const UPDATE_REPO_KEY = 'kv.update.repo';

// 内置图标库，供用户为分类/账户/储蓄目标等选择图标
export const ICON_PALETTE = [
  '🍜', '🍔', '🍱', '🍵', '☕', '🥤', '🍺', '🍷',
  '🛒', '🛍️', '👗', '👟', '🧥', '💄', '💅', '⌚',
  '🏠', '🏢', '🚗', '⛽', '🚌', '✈️', '🚆', '🚕',
  '📱', '💻', '📷', '🎧', '🖥️', '🎮', '⌨️', '🔌',
  '📚', '✏️', '🎓', '📖', '🏫', '👨‍🎓', '🗂️', '📝',
  '💊', '🏥', '🩺', '💉', '🦷', '🧘', '🏃', '💪',
  '🎬', '🎵', '🎤', '🎪', '⚽', '🏀', '🎾', '⛳',
  '✈️', '🧳', '🏖️', '🏔️', '🗺️', '🎡', '🛫', '🌴',
  '💼', '📈', '📊', '💰', '💵', '💳', '🏦', '🧾',
  '🎁', '🎂', '🎉', '🎊', '💝', '💌', '🕯️', '🃏',
  '🐱', '🐶', '🐟', '🌹', '🌻', '🌵', '🍎', '🍊',
  '👶', '👧', '👦', '👨‍👩‍👧', '💍', '🧸', '🚼', '🎓',
  '🛠️', '🔧', '⚙️', '🧰', '📦', '🔋', '♻️', '🏠',
  '🎯', '🏆', '🥇', '🎖️', '⭐', '🌟', '✨', '🔥',
  '❤️', '💙', '💚', '💛', '💜', '🖤', '🤍', '🌈',
  '😀', '😄', '😂', '🤗', '😎', '🥰', '😊', '👍',
] as const;