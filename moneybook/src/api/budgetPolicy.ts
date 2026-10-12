// 滚动预算策略的持久化读写（薄封装）
// -----------------------------------------------------------------------------
// 策略存放在 settings 表的 kv 前缀键下（kv.budget.rollover），复用已有的
// getRawKV/setKV（内存缓存 + 写穿数据库），无需新建表。
// 供两处使用：
//   - api/stats.getBudgetVsActualAdvanced：读取策略参与逐期结转计算；
//   - 规划页「滚动预算策略」区块：读取并保存用户设置。
// 单独成模块是为了避免 stats ↔ planning 之间产生循环依赖。
// -----------------------------------------------------------------------------
import { getRawKV, setKV } from './kv';
import {
  parseRolloverPolicy, describeRolloverPolicy,
  type RolloverPolicy,
} from '@/lib/budgetRolloverPolicy';

/** 偏好项键名（必须带 kv. 前缀，否则不会被 hydrateKV 载入内存缓存） */
export const ROLLOVER_POLICY_KEY = 'kv.budget.rollover';

/** 读取滚动预算策略；未配置或内容非法时回退默认（开启且不设上限 = 历史行为） */
export function getRolloverPolicy(): RolloverPolicy {
  return parseRolloverPolicy(getRawKV(ROLLOVER_POLICY_KEY));
}

/** 保存滚动预算策略；返回是否落库成功（失败时界面应提示，避免"假保存"） */
export async function setRolloverPolicy(policy: RolloverPolicy): Promise<boolean> {
  const ok = await setKV(ROLLOVER_POLICY_KEY, JSON.stringify(policy));
  console.log(`[budget] 保存滚动策略${ok ? '成功' : '失败'}：${describeRolloverPolicy(policy)}`);
  return ok;
}
