/**
 * 版本工具单测：版本比较（compareVersion）与 Release tag 解析（parseStableTag），
 * 两者是「关于」页 / 启动自动扫描 更新检查的核心判定逻辑。
 */
import { describe, it, expect } from 'vitest';
import { compareVersion, parseStableTag } from '@/lib/version';

describe('compareVersion：语义化版本比较', () => {
  it('常规数值比较', () => {
    expect(compareVersion('2.1.0', '2.0.0')).toBe(1);
    expect(compareVersion('2.0.0', '2.1.0')).toBe(-1);
    expect(compareVersion('2.0.0', '2.0.0')).toBe(0);
  });
  it('段数不齐时缺失段按 0 处理', () => {
    expect(compareVersion('2.0', '2.0.0')).toBe(0);
  });
  it('按数字而非字符串比较（2.10 > 2.9）', () => {
    expect(compareVersion('2.10.0', '2.9.9')).toBe(1);
  });
  it('非数字后缀忽略', () => {
    expect(compareVersion('2.0.1', '2.0.0')).toBe(1);
  });
});

describe('parseStableTag：GitHub Release tag 解析（stable 只收无后缀正式版）', () => {
  it('三段正式版（可带 v 前缀）', () => {
    expect(parseStableTag('v1.0.0')).toBe('1.0.0');
    expect(parseStableTag('1.2.3')).toBe('1.2.3');
  });
  it('四段测试版一律不收（永不进 stable 渠道）', () => {
    expect(parseStableTag('v1.0.0.1')).toBeNull();
    expect(parseStableTag('1.0.0.10')).toBeNull();
  });
  it('带后缀预发布一律不收', () => {
    expect(parseStableTag('1.0.0-rc.1')).toBeNull();
    expect(parseStableTag('1.0.0-beta.2')).toBeNull();
    expect(parseStableTag('v1.0.0-alpha.1')).toBeNull();
  });
  it('非法输入返回 null（空串 / 非版本字样 / 两段）', () => {
    expect(parseStableTag('')).toBeNull();
    expect(parseStableTag('release')).toBeNull();
    expect(parseStableTag('1.0')).toBeNull();
  });
});