// 版本比较与 GitHub 仓库地址解析（纯函数，供「关于」更新检查与单元测试使用）

/**
 * 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 逐段按数字比较，缺失段按 0 处理（如 2.0 与 2.0.0 相等）；非数字后缀忽略。
 */
export function compareVersion(a: string, b: string): number {
  const pa = String(a).split('.').map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split('.').map((s) => parseInt(s, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 解析 GitHub 仓库标识：支持完整地址、SSH 形式与裸 owner/repo。
 * 无法识别时返回 null（例如用户只填了域名或空串）。
 */
export function parseRepoSlug(raw: string): string | null {
  const t = String(raw ?? '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!t) return null;
  const m = t.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i);
  if (m) return `${m[1]}/${m[2]}`;
  if (/^[^/\s]+\/[^/\s]+$/.test(t)) return t;
  return null;
}