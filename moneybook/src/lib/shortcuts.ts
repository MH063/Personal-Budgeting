// 应用内快捷键：动作定义 / 键位归一化 / 配置读写
// -----------------------------------------------------------------------------
// 设计说明（为什么自建而不是引入全局快捷键插件）：
//  - 需求是「应用内快捷键可查看、可修改」，不需要系统级全局热键（即使窗口失焦也能触发），
//    因此用 window keydown 监听实现，避免新增 Cargo 依赖与额外的权限配置。
//  - 键位以字符串形式存入 settings 表（kv.shortcut.<action>），统一格式 "Ctrl+Shift+K"：
//    修饰键固定顺序 Ctrl → Alt → Shift → Meta，主键大写；比较时两侧都归一化。
//  - 本模块为纯函数（配置读写除外），便于单元测试覆盖录制与匹配逻辑。
import { getKV, setKV } from '@/api/kv';

/** 可配置的快捷键动作 */
export type ShortcutAction = 'commandPalette' | 'aiAssistant' | 'quickAdd';

export interface ShortcutDef {
  action: ShortcutAction;
  label: string;
  desc: string;
  /** 默认键位（用户未自定义时的值） */
  def: string;
}

/** 动作清单（设置页按此顺序展示） */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  { action: 'commandPalette', label: '打开命令面板', desc: '搜索页面、分类或交易备注', def: 'Ctrl+K' },
  { action: 'aiAssistant', label: '打开 AI 助手', desc: '统一 AI 对话（财务问答 / 深度分析 / 报告建议）', def: 'Ctrl+Shift+A' },
  { action: 'quickAdd', label: '快速记账', desc: '跳转流水页并打开「记支出」表单', def: 'Ctrl+N' },
];

/** 存储键前缀（settings 表） */
export const SHORTCUT_KEY_PREFIX = 'kv.shortcut.';

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

/**
 * 键位串归一化：修饰键按 Ctrl→Alt→Shift→Meta 固定排序，主键统一大小写。
 * 录制与匹配两侧都会调用，保证 "ctrl + k" 与 "Ctrl+K" 视为同一键位。
 */
export function normalizeKeys(raw: string): string {
  const parts = String(raw ?? '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  const isMod = (p: string, m: string) => p.toLowerCase() === m.toLowerCase();
  const mods = MODS.filter((m) => parts.some((p) => isMod(p, m)));
  const mains = parts
    .filter((p) => !MODS.some((m) => isMod(p, m)))
    .map((p) => {
      if (p.length === 1) return p.toUpperCase();
      if (p.toLowerCase() === 'space') return 'Space';
      return p;
    });
  return [...mods, ...mains].join('+');
}

/**
 * KeyboardEvent → 归一化键位串（如 "Ctrl+Shift+K"）。
 * 纯修饰键（只按下了 Ctrl/Alt/Shift/Meta）无法构成完整键位，返回 null（录制时继续等待主键）。
 */
export function eventToKeys(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const k = e.key;
  if (!k || ['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null;
  let main = k;
  if (k === ' ') main = 'Space';
  else if (k.length === 1) main = k.toUpperCase();
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return normalizeKeys([...mods, main].join('+'));
}

/** 判断键盘事件是否命中给定键位串 */
export function matchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  keys: string
): boolean {
  if (!keys) return false;
  const cur = eventToKeys(e);
  return cur !== null && cur === normalizeKeys(keys);
}

/** 读取动作当前键位；未自定义时回退默认键位 */
export function getShortcut(action: ShortcutAction): string {
  const def = SHORTCUT_DEFS.find((d) => d.action === action)?.def ?? '';
  const saved = getKV(SHORTCUT_KEY_PREFIX + action, '');
  return saved ? normalizeKeys(saved) : def;
}

/** 保存动作键位（传空串即恢复默认） */
export async function setShortcut(action: ShortcutAction, keys: string): Promise<void> {
  await setKV(SHORTCUT_KEY_PREFIX + action, keys ? normalizeKeys(keys) : '');
}