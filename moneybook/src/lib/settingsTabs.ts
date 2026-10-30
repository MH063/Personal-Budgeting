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

/** 设置页一级分组配置（页面导航与搜索共用，避免分组定义散落在页面里） */
export const SETTINGS_GROUPS: { title: string; icon: string; desc: string; keys: SettingsTabKey[] }[] = [
  { title: '分类与标签', icon: '🏷️', desc: '分类与标签的增删改', keys: ['category', 'tag'] },
  { title: '账户与模板', icon: '👛', desc: '账户管理、常用交易模板', keys: ['account', 'templates'] },
  { title: '预算与周期', icon: '📊', desc: '预算、周期性记账', keys: ['budget', 'recurring'] },
  { title: '智能规则与 AI', icon: '🧠', desc: '全部规则、参考知识与 AI 助手', keys: ['rules', 'ai'] },
  { title: '数据备份与导出', icon: '💾', desc: '账目导入、报表导出与 JSON 导出、数据库备份', keys: ['import', 'export', 'backup'] },
  { title: '系统与帮助', icon: '🖥️', desc: '存储空间、快捷键、关于系统与使用说明', keys: ['storage', 'shortcut', 'about', 'help'] },
];

/** 搜索别名：用户常用说法与英文 key（命中后即可定位到对应子页） */
const TAB_ALIASES: Record<SettingsTabKey, string[]> = {
  category: ['分类', '类别', '科目', 'category'],
  account: ['账户', '银行卡', '余额', 'account'],
  tag: ['标签', 'tag'],
  budget: ['预算', '额度', 'budget'],
  recurring: ['周期', '定期', '自动记账', 'recurring'],
  templates: ['模板', '常用', 'template'],
  rules: ['规则', '自动分类', '关键词', 'rule'],
  export: ['导出', '报表', 'excel', 'export'],
  import: ['导入', '账单', '支付宝', '微信', 'import'],
  backup: ['备份', '恢复', '还原', 'backup'],
  ai: ['AI', 'ai', '助手', '模型', '密钥', 'key'],
  storage: ['存储', '空间', '占用', '清理', 'storage'],
  shortcut: ['快捷键', '热键', 'shortcut'],
  about: ['关于', '版本', '更新', 'about', 'version'],
  help: ['帮助', '说明', '使用', 'help'],
};

/** 查找某个子页所属的分组标题（找不到时返回空串） */
export function groupTitleOfTab(key: SettingsTabKey): string {
  return SETTINGS_GROUPS.find((g) => g.keys.includes(key))?.title ?? '';
}

/**
 * 按关键词搜索设置子页（纯函数，便于单元测试）。
 * 匹配范围：子页标签、分组标题/描述、英文 key 与别名；不区分大小写。
 * 空查询返回全部子页（保持 SETTINGS_TABS 原有顺序）。
 */
export function searchSettingsTabs(query: string): SettingsTabKey[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return SETTINGS_TABS.map((t) => t.key);
  return SETTINGS_TABS.filter((t) => {
    const group = SETTINGS_GROUPS.find((g) => g.keys.includes(t.key));
    const haystack = [
      t.label,
      t.key,
      group?.title ?? '',
      group?.desc ?? '',
      ...(TAB_ALIASES[t.key] ?? []),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }).map((t) => t.key);
}

/** 解析 URL query 中的 tab 参数；非法值回退默认 tab */
export function resolveSettingsTab(raw: string | null): SettingsTabKey {
  if (!raw) return DEFAULT_SETTINGS_TAB;
  const t = String(raw).trim();
  return SETTINGS_TABS.some((x) => x.key === t) ? (t as SettingsTabKey) : DEFAULT_SETTINGS_TAB;
}