// 预算滚动收口（幂等，安全，无破坏）
// -----------------------------------------------------------------------------
// 说明：本系统预算采用「单行多期」动态滚动模型 —— 每个预算行按 start_date 覆盖
// 其所在的所有周期，上期结余由 getBudgetVsActualAdvanced 动态逐期结转滚入下期，
// 因此"期间结束自动滚动下期"的语义已天然具备，无需也不应把每个期间固化成单独
// 数据库行（否则会引入重复计数并需改动表结构与读取逻辑）。
//
// 本模块仅做数据健壮性收口：把"未来日期"的月度预算 start_date 归一到当前月首日，
// 确保异常/误写入的未来预算能立即在当前期生效；正常数据一律跳过（零副作用）。
// 挂载于应用启动自动任务，幂等可重复调用。
// -----------------------------------------------------------------------------
import dayjs from 'dayjs';
import { select, execute } from '@/api/db';
import { currentLedgerId } from '@/lib/ledger';

/** 幂等推进月度预算的"未来异常起点"到当前月（正常数据不触及） */
export async function ensureBudgetCurrentPeriod(ledgerId?: number): Promise<void> {
  const lid = ledgerId ?? currentLedgerId();
  const thisMonth = dayjs().format('YYYY-MM');
  // 仅选取 period='monthly'、未停用、且 start_date 落在未来年份月的行（异常/误写）
  const rows = await select<{ id: number; start_date: string }>(
    `SELECT id, start_date FROM budgets
     WHERE ledger_id = $1 AND period = 'monthly' AND end_date IS NULL AND start_date > $2`,
    [lid, thisMonth]
  );
  if (rows.length === 0) return; // 无异常行，不产生任何写操作
  const firstDay = dayjs(`${thisMonth}-01`).format('YYYY-MM-DD');
  for (const r of rows) {
    if (dayjs(r.start_date).format('YYYY-MM') !== thisMonth) {
      await execute(`UPDATE budgets SET start_date = $1 WHERE id = $2`, [firstDay, r.id]);
    }
  }
  // 收口日志便于本地调试
  console.log(`[budget] 已将 ${rows.length} 条未来起点的月度预算收口到当前期 ${thisMonth}`);
}