// 设置页 tab 标识与解析（纯函数，供单元测试与页面共用）
// -----------------------------------------------------------------------------
// 支持通过 URL query（?tab=ai 等）定位到指定设置子页。
// 与页面解耦：跳转入口（如「去开启 →」）→ /settings?tab=ai → 本模块解析 tab。
// -----------------------------------------------------------------------------

export const SETTINGS_TABS = [
  { key: 'category', label: '分类管理', icon: '🏷️' },
  { key: 'account', label: '账户管理', icon: '👛' },
  { key: 'tag', label: '标签管理', icon: '#️⃣' },
  { key: 'budget', label: '预算', icon: '📊' },
  { key: 'recurring', label: '周期性记账', icon: '🔁' },
  { key: 'templates', label: '常用模板', icon: '🧩' },
  { key: 'rules', label: '智能规则', icon: '🧠' },
  { key: 'export', label: '报表导出', icon: '📤' },
  { key: 'import', label: '账目导入', icon: '📥' },
  { key: 'backup', label: '备份恢复', icon: '💾' },
  { key: 'ai', label: 'AI 助手', icon: '🤖' },
  { key: 'storage', label: '存储管理', icon: '🗄️' },
  { key: 'shortcut', label: '快捷键', icon: '⌨️' },
  { key: 'about', label: '关于系统', icon: 'ℹ️' },
  { key: 'help', label: '使用说明', icon: '❓' },
] as const;

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]['key'];

/** 默认设置页 tab */
export const DEFAULT_SETTINGS_TAB: SettingsTabKey = 'category';

/** 解析 URL query 中的 tab 参数；非法值回退默认 tab */
export function resolveSettingsTab(raw: string | null): SettingsTabKey {
  if (!raw) return DEFAULT_SETTINGS_TAB;
  const t = String(raw).trim();
  return SETTINGS_TABS.some((x) => x.key === t) ? (t as SettingsTabKey) : DEFAULT_SETTINGS_TAB;
}