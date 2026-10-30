/**
 * 设置页 tab 定位解析单元测试。
 * 覆盖：合法 tab 参数解析（含「去开启 →」跳转 ai）、空值/非法值回退默认、
 * tab 唯一性与完整性。
 */
import { describe, it, expect } from 'vitest';
import { resolveSettingsTab, SETTINGS_TABS, DEFAULT_SETTINGS_TAB, SETTINGS_GROUPS, searchSettingsTabs, groupTitleOfTab } from '@/lib/settingsTabs';

describe('resolveSettingsTab：URL query 定位设置子页', () => {
  it('合法 tab 参数正确解析', () => {
    expect(resolveSettingsTab('ai')).toBe('ai');
    expect(resolveSettingsTab('budget')).toBe('budget');
    expect(resolveSettingsTab('backup')).toBe('backup');
    expect(resolveSettingsTab('category')).toBe('category');
  });

  it('空值/缺失时回退默认 tab（分类管理）', () => {
    expect(resolveSettingsTab(null)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('')).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab(undefined as unknown as string)).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('非法 tab 参数回退默认（防御攻击/拼写错误）', () => {
    expect(resolveSettingsTab('hack')).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('AI')).toBe(DEFAULT_SETTINGS_TAB); // 大小写敏感，防御乱传
    expect(resolveSettingsTab('ai;DROP TABLE')).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('带空白字符的合法值仍可解析', () => {
    expect(resolveSettingsTab(' ai ')).toBe('ai');
  });

  it('「去开启 →」链接使用的 ?tab=ai 能定位到 AI 助手页', () => {
    // 回归：此前跳转 /settings#ai 无法被解析，停靠在分类管理；现改为 /settings?tab=ai
    expect(resolveSettingsTab('ai')).toBe('ai');
  });
});

describe('SETTINGS_TABS 配置完整性', () => {
  it('tab key 唯一（确保页面渲染不冲突）', () => {
    const keys = SETTINGS_TABS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('包含 AI 助手与分类管理等核心子页', () => {
    const keys = new Set(SETTINGS_TABS.map((t) => t.key));
    expect(keys.has('ai')).toBe(true);
    expect(keys.has('category')).toBe(true);
    expect(keys.has('budget')).toBe(true);
    expect(keys.has('backup')).toBe(true);
  });

  it('每个 tab 均有展示文案', () => {
    for (const t of SETTINGS_TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('SETTINGS_GROUPS 分组完整性', () => {
  it('每个子页恰好属于一个分组（无遗漏、无重复）', () => {
    const all = SETTINGS_GROUPS.flatMap((g) => g.keys);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all).size).toBe(SETTINGS_TABS.length);
  });

  it('groupTitleOfTab 能返回所属分组标题', () => {
    expect(groupTitleOfTab('budget')).toBe('预算与周期');
    expect(groupTitleOfTab('help')).toBe('系统与帮助');
  });
});

describe('searchSettingsTabs 设置搜索', () => {
  it('空查询返回全部子页', () => {
    expect(searchSettingsTabs('')).toHaveLength(SETTINGS_TABS.length);
    expect(searchSettingsTabs('   ')).toHaveLength(SETTINGS_TABS.length);
  });

  it('按中文标签搜索命中对应子页', () => {
    expect(searchSettingsTabs('预算')).toContain('budget');
    expect(searchSettingsTabs('备份')).toContain('backup');
  });

  it('支持别名与英文 key，大小写不敏感', () => {
    expect(searchSettingsTabs('AI')).toContain('ai');
    expect(searchSettingsTabs('ai')).toContain('ai');
    expect(searchSettingsTabs('支付宝')).toContain('import');
    expect(searchSettingsTabs('excel')).toContain('export');
  });

  it('无匹配时返回空数组', () => {
    expect(searchSettingsTabs('不存在的关键词xyz')).toEqual([]);
  });
});