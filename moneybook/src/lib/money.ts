/**
 * 金额计算工具：统一处理浮点尾差。
 *
 * 背景：金额以元（number）在系统内流通，但二进制浮点对「0.1 + 0.2」这类小数会产生尾差
 * （0.30000000000000004）。单笔展示被 toFixed(2) 掩盖，但**累加 / 相减后比较**（如对账
 * 推算余额与银行余额的差异、多次累加的净额）会把尾差放大或误判「有差异」。因此所有
 * 「计算后落库或比较」的金额都应经 roundMoney 归一到分。
 *
 * 注意：这里只做「分单位取整」，不改数据库存储（库中金额仍为 REAL 元），
 * 不做分/元双向换算，避免引入新的转换边界。
 */

/**
 * 金额四舍五入到分（保留 2 位小数），消除浮点尾差。
 * 例：roundMoney(0.1 + 0.2) → 0.3；roundMoney(19.95) → 19.95。
 * 与 toFixed(2) 的舍入行为一致，但返回 number 可继续参与运算。
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

/**
 * 两个金额是否「分级相等」：允许半分之内的浮点尾差。
 * 用于对账等「比较后判定是否一致」的场景，避免 0.30000000000000004 === 0.3 这类误判。
 */
export function moneyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}
