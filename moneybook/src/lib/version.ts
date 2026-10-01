// 版本工具（纯函数，供「关于」更新检查、发布校验与单元测试使用，无任何外部依赖）

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
 * 解析 GitHub Release tag 为「正式三段版本号」；非正式版返回 null。
 * 规则（与发布流程一致）：只接受 x.y.z（可带 v 前缀）；
 *   - 四段测试版 1.0.0.1   → null（测试版永不进 stable 渠道）
 *   - 带后缀预发布 1.0.0-rc.1 / 1.0.0-beta.2 → null
 * 这是更新检查的客户端防线：即使误把测试版发成 Release，也不会提示用户更新。
 */
export function parseStableTag(tag: string): string | null {
  const t = String(tag ?? '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+$/.test(t) ? t : null;
}