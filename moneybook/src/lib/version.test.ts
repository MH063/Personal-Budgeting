/**
 * 版本比较与 GitHub 仓库地址解析单测（「关于」页更新检查的核心逻辑）。
 */
import { describe, it, expect } from 'vitest';
import { compareVersion, parseRepoSlug } from '@/lib/version';

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

describe('parseRepoSlug：GitHub 仓库地址解析', () => {
  it('完整 URL / 带 .git / SSH / 裸 slug 均可解析', () => {
    expect(parseRepoSlug('https://github.com/foo/bar')).toBe('foo/bar');
    expect(parseRepoSlug('https://github.com/foo/bar.git')).toBe('foo/bar');
    expect(parseRepoSlug('git@github.com:foo/bar.git')).toBe('foo/bar');
    expect(parseRepoSlug('foo/bar')).toBe('foo/bar');
  });
  it('首尾空白与末尾斜杠容错', () => {
    expect(parseRepoSlug('  https://github.com/foo/bar/  ')).toBe('foo/bar');
  });
  it('非法输入返回 null（空串 / 仅域名 / 仅 owner）', () => {
    expect(parseRepoSlug('')).toBeNull();
    expect(parseRepoSlug('github.com')).toBeNull();
    expect(parseRepoSlug('https://github.com/foo')).toBeNull();
  });
});