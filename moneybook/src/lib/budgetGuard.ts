// 预算余量计算（纯函数，无副作用，便于单元测试）
// -----------------------------------------------------------------------------
// 职责：把「当月各类预算 vs 实际」的查询行（BudgetVsActualAdvancedRow）转换为
// 分类 → 余量/超支状态 的映射，供记账页（超支红点强提醒）与预算页（红/黄点）
// 复用。绝不在此处做"禁止记账"等阻断逻辑——超支是现实消费的客观结果，
// 真实消费必须能正常记录，只做提醒不拦截。
// -----------------------------------------------------------------------------
import type { BudgetVsActualAdvancedRow } from '@/api/stats';

/** 接近上限的告警阈值：实际占用达到该百分比时标记黄点提醒 */
export const BUDGET_WARN_PERCENT = 80;

export type BudgetUsageStatus = 'ok' | 'warn' | 'over';

export interface BudgetUsage {
  /** 是否有可用预算（used==='over' 但无预算时不置为已满，仍视为超支提醒） */
  hasBudget: boolean;
  /** 本期可用预算 = 原始额度 + 滚入 */
  usable: number;
  /** 本期实际支出 */
  actual: number;
  /** 剩余可支配 = 可用 − 实际（可为负） */
  remaining: number;
  /** 占用百分比（0~100+；无预算时按是否发生支出给 0 或 100） */
  percent: number;
  status: BudgetUsageStatus;
}

/**
 * 将当月预算实况行转换为 分类→余量 映射。
 * key：分类 id；null 键代表「总预算」。
 * 状态判定：实际≥可用 → over（红）；占用≥BUDGET_WARN_PERCENT → warn（黄）；否则 ok。
 */
export function computeBudgetUsage(
  rows: BudgetVsActualAdvancedRow[]
): Map<number | null, BudgetUsage> {
  const map = new Map<number | null, BudgetUsage>();
  for (const r of rows) {
    const usable = Math.max(Number(r.usable) || 0, 0);
    const actual = Math.max(Number(r.actual) || 0, 0);
    const hasBudget = usable > 0;
    const percent = usable > 0 ? (actual / usable) * 100 : (actual > 0 ? 100 : 0);
    let status: BudgetUsageStatus = 'ok';
    if (hasBudget) {
      if (actual >= usable) status = 'over';
      else if (percent >= BUDGET_WARN_PERCENT) status = 'warn';
    } else if (actual > 0) {
      status = 'over';
    }
    map.set(r.category_id, {
      hasBudget,
      usable,
      actual,
      remaining: Number((usable - actual).toFixed(2)),
      percent: Math.round(percent * 10) / 10,
      status,
    });
  }
  return map;
}

/**
 * 取某分类的预算余量；该分类未设预算时，回退到「总预算」（null 键）。
 * 均无命中返回 null（无任何预算约束）。
 */
export function getUsageForCategory(
  map: Map<number | null, BudgetUsage>,
  categoryId: number | null | undefined
): BudgetUsage | null {
  if (categoryId == null) return map.get(null) ?? null;
  if (map.has(categoryId)) return map.get(categoryId) ?? null;
  return map.get(null) ?? null;
}

/** 预算状态 → 中文标签（供展示与文案） */
export function usageStatusLabel(s: BudgetUsageStatus): string {
  return s === 'over' ? '超支' : s === 'warn' ? '接近上限' : '正常';
}

/**
 * 生成记账页"超支/接近上限"的强提醒文案（纯函数，可单测）。
 * 只用于提醒、绝不表达"禁止记账"。status 为 ok / 无预算时返回空串。
 */
export function budgetWarnMessage(usage: BudgetUsage): string {
  if (usage.status === 'over') {
    return `该分类预算已超支 ¥${Math.abs(usage.remaining).toFixed(2)}（可用 ¥${usage.usable.toFixed(2)}，已支出 ¥${usage.actual.toFixed(2)}）`;
  }
  if (usage.status === 'warn') {
    return `该分类预算已使用 ${usage.percent}%，即将用尽，请留意开销`;
  }
  return '';
}