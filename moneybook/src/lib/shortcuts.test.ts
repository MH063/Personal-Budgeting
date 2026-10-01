/**
 * 快捷键模块单测（纯函数 + 配置读写）。
 * 覆盖：键位归一化（修饰键顺序/大小写）、事件转换（纯修饰键拒绝、空格归一）、
 * 匹配、默认值回退与自定义持久化（settings 表内存缓存）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SHORTCUT_DEFS,
  SHORTCUT_KEY_PREFIX,
  normalizeKeys,
  eventToKeys,
  matchShortcut,
  getShortcut,
  setShortcut,
  type ShortcutAction,
} from '@/lib/shortcuts';
import { _kvCache } from '@/api/kv';

/** 构造键盘事件假对象（Node 环境无 KeyboardEvent） */
function ev(
  key: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

beforeEach(() => {
  _kvCache.clear();
});

describe('normalizeKeys：修饰键顺序与大小写归一', () => {
  it('乱序修饰键与小写主键被归一为固定格式', () => {
    expect(normalizeKeys('shift+ctrl+k')).toBe('Ctrl+Shift+K');
    expect(normalizeKeys('ctrl + alt + n')).toBe('Ctrl+Alt+N');
  });
  it('已规范的键位串保持幂等', () => {
    expect(normalizeKeys('Ctrl+Shift+A')).toBe('Ctrl+Shift+A');
  });
  it('空格键归一为 Space', () => {
    expect(normalizeKeys('ctrl+space')).toBe('Ctrl+Space');
  });
});

describe('eventToKeys：事件转键位串', () => {
  it('组合键生成规范串', () => {
    expect(eventToKeys(ev('k', { ctrlKey: true }))).toBe('Ctrl+K');
    expect(eventToKeys(ev('K', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+K');
  });
  it('纯修饰键无法构成完整键位，返回 null', () => {
    expect(eventToKeys(ev('Control', { ctrlKey: true }))).toBeNull();
    expect(eventToKeys(ev('Shift', { shiftKey: true }))).toBeNull();
  });
  it('不可打印键保留原名称（方向键等）', () => {
    expect(eventToKeys(ev('ArrowUp', { altKey: true }))).toBe('Alt+ArrowUp');
  });
});

describe('matchShortcut：事件与键位串匹配', () => {
  it('命中与未命中', () => {
    expect(matchShortcut(ev('k', { ctrlKey: true }), 'Ctrl+K')).toBe(true);
    expect(matchShortcut(ev('k', { ctrlKey: true }), 'Ctrl+J')).toBe(false);
    expect(matchShortcut(ev('k', { ctrlKey: true, shiftKey: true }), 'Ctrl+K')).toBe(false);
  });
  it('空键位串不匹配任何事件', () => {
    expect(matchShortcut(ev('k', { ctrlKey: true }), '')).toBe(false);
  });
});

describe('getShortcut / setShortcut：配置读写', () => {
  it('未配置时回退默认键位，且各动作均有默认值', () => {
    for (const d of SHORTCUT_DEFS) {
      expect(d.def).toBeTruthy();
      expect(getShortcut(d.action)).toBe(d.def);
    }
  });

  it('保存后读取归一化键位并写入 kv（settings 表）', async () => {
    await setShortcut('aiAssistant', 'shift + ctrl + a');
    expect(getShortcut('aiAssistant')).toBe('Ctrl+Shift+A');
    expect(_kvCache.get(SHORTCUT_KEY_PREFIX + 'aiAssistant')).toBe('Ctrl+Shift+A');
  });

  it('传空串即恢复默认（清除自定义）', async () => {
    const action: ShortcutAction = 'quickAdd';
    await setShortcut(action, 'Ctrl+Alt+N');
    expect(getShortcut(action)).toBe('Ctrl+Alt+N');
    await setShortcut(action, '');
    expect(getShortcut(action)).toBe('Ctrl+N');
  });
});