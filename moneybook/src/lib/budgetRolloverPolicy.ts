// 滚动预算策略（纯函数，无副作用，便于单元测试）
// -----------------------------------------------------------------------------
// 背景：预算采用「单行多期」动态滚动模型（详见 api/budgetRollover.ts 顶部说明），
// 历史上每期结余会**无限额**地滚入下期：carried = max(额度 + carried − 实际, 0)。
// 本模块把该行为参数化，允许用户：
//   ① 关闭滚动：每期只按原始额度计算，上期结余不滚入；
//   ② 设置滚入上限：滚入额不超过「本期额度 × 上限百分比」。
// 默认策略 { enabled: true, capPercent: null } 与历史行为**完全一致**，保证向后兼容。
// -----------------------------------------------------------------------------

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RolloverPolicy {
  /** 是否把上期结余滚入下期；false 时每期仅按原始额度计算 */
  enabled: boolean;
  /** 滚入上限（相对本期额度的百分比，>=0）；null 表示不设上限（默认，历史行为） */
  capPercent: number | null;
}

/** 默认策略：开启滚动、不设上限（与历史行为一致） */
export const DEFAULT_ROLLOVER_POLICY: RolloverPolicy = { enabled: true, capPercent: null };

/**
 * 解析持久化的策略 JSON；缺失或非法时回退默认策略。
 * 容错：字段缺失按默认补齐；类型不符的字段被忽略，不抛异常。
 */
export function parseRolloverPolicy(raw: string | null | undefined): RolloverPolicy {
  if (!raw) return { ...DEFAULT_ROLLOVER_POLICY };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_ROLLOVER_POLICY };
    const rec = parsed as Record<string, unknown>;

    const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : DEFAULT_ROLLOVER_POLICY.enabled;

    let capPercent: number | null = DEFAULT_ROLLOVER_POLICY.capPercent;
    if (rec.capPercent === null) {
      capPercent = null;
    } else if (typeof rec.capPercent === 'number' && Number.isFinite(rec.capPercent) && rec.capPercent >= 0) {
      capPercent = rec.capPercent;
    }
    return { enabled, capPercent };
  } catch {
    return { ...DEFAULT_ROLLOVER_POLICY };
  }
}

/**
 * 按策略计算「本期应滚入下期」的金额。
 * @param surplus 本期结余（= 可用 − 实际，可为负；负值一律按 0，不滚负）
 * @param baseAmount 本期原始额度（用于按百分比计算上限）
 */
export function applyRolloverPolicy(surplus: number, baseAmount: number, policy: RolloverPolicy): number {
  if (!policy.enabled) return 0;
  let v = Math.max(Number(surplus) || 0, 0);
  if (policy.capPercent != null) {
    const cap = Math.max(Number(baseAmount) || 0, 0) * policy.capPercent / 100;
    v = Math.min(v, cap);
  }
  return round2(v);
}

/** 策略 → 中文摘要（供界面展示与日志） */
export function describeRolloverPolicy(policy: RolloverPolicy): string {
  if (!policy.enabled) return '已关闭：每期只按原始额度计算，上期结余不滚入';
  if (policy.capPercent == null) return '已开启：上期结余全额滚入下期';
  return `已开启：滚入不超过本期额度的 ${policy.capPercent}%`;
}
