// 投资账户持仓（market value / cost basis）
// 语义：
//   - accounts.balance 仍是投资账户的【现金】（由转账/收入等交易记账维护）
//   - account_holdings 记录每笔持仓：市值 = quantity * price，成本 = quantity * cost
//   - 买入时从该账户现金扣减成本；卖出/减仓时按成本返还现金；改现价不影响现金。
//   - 投资账户总资产 = 现金(balance) + 持仓市值；盈亏 = 市值 - 成本。
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';

export interface Holding {
  id: number;
  account_id: number;
  symbol: string;
  name: string;
  quantity: number;
  cost: number;
  price: number;
  note: string;
}

export interface HoldingInput {
  symbol?: string;
  name: string;
  quantity: number;
  cost: number;
  price: number;
  note?: string;
}

export interface HoldingSummary {
  marketValue: number; // Σ qty*price
  costValue: number;   // Σ qty*cost
  quantity: number;
  profit: number;      // marketValue - costValue
}

export async function listHoldings(accountId: number): Promise<Holding[]> {
  return select<Holding>(
    `SELECT * FROM account_holdings WHERE account_id = $1 ORDER BY name`, [accountId]
  );
}

/** 某账户全部持仓的汇总（市值/成本/数量/盈亏） */
export async function getHoldingSummary(accountId: number): Promise<HoldingSummary> {
  const rows = await select<{ mv: number; cv: number; qty: number }>(
    `SELECT
       COALESCE(SUM(quantity*price),0) AS mv,
       COALESCE(SUM(quantity*cost),0)  AS cv,
       COALESCE(SUM(quantity),0)       AS qty
     FROM account_holdings WHERE account_id = $1`, [accountId]
  );
  const r = rows[0] ?? { mv: 0, cv: 0, qty: 0 };
  const marketValue = Number(r.mv ?? 0);
  const costValue = Number(r.cv ?? 0);
  return { marketValue, costValue, quantity: Number(r.qty ?? 0), profit: marketValue - costValue };
}

/** 全部账户的持仓汇总（按账户，供账户页卡片展示） */
export async function listHoldingSummaries(): Promise<(HoldingSummary & { account_id: number })[]> {
  return select<HoldingSummary & { account_id: number }>(
    `SELECT account_id,
       COALESCE(SUM(quantity*price),0) AS marketValue,
       COALESCE(SUM(quantity*cost),0)  AS costValue,
       COALESCE(SUM(quantity),0)       AS quantity,
       COALESCE(SUM(quantity*price),0) - COALESCE(SUM(quantity*cost),0) AS profit
     FROM account_holdings
     GROUP BY account_id`
  );
}

/** 某账本下全部投资账户的持仓市值合计（含到净资产/类型汇总） */
export async function getLedgerInvestmentMarketValue(): Promise<number> {
  const rows = await select<{ total: number }>(
    `SELECT COALESCE(SUM(h.quantity*h.price),0) AS total
     FROM account_holdings h
     JOIN accounts a ON h.account_id = a.id
     WHERE a.type = 'investment' AND a.ledger_id = $1`, [currentLedgerId()]
  );
  return Number(rows[0]?.total ?? 0);
}

/** 调整投资账户现金（delta 为带符号的增减额）；仅对 investment 账户生效 */
async function adjustCash(accountId: number, delta: number): Promise<void> {
  if (!delta) return;
  await execute(
    `UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND type = 'investment'`,
    [delta, accountId]
  );
}

/** 买入/加仓前，校验投资账户现金是否足够覆盖成本（不足则拒绝，避免余额为负） */
async function assertEnoughCash(accountId: number, need: number): Promise<void> {
  if (need <= 0.0001) return;
  const [acc] = await select<{ name: string; balance: number }>(
    `SELECT name, balance FROM accounts WHERE id = $1`, [accountId]
  );
  if (!acc) throw new Error('账户不存在');
  if (Number(acc.balance) < need - 0.0001) {
    throw new Error(
      `投资账户「${acc.name}」可投现金不足（现有 ${Number(acc.balance || 0).toFixed(2)} ≥ 需要 ${need.toFixed(2)}）。` +
      `请先通过「收入 / 转账」为该账户补充资金后再加仓。`
    );
  }
}

export async function createHolding(accountId: number, p: HoldingInput): Promise<number> {
  return runInTransaction(async () => {
    const qty = p.quantity || 0;
    const cost = p.cost || 0;
    // 买入前校验现金充足，不足则拒绝（防止余额无限为负）
    await assertEnoughCash(accountId, cost * qty);
    const r = await execute(
      `INSERT INTO account_holdings (account_id, symbol, name, quantity, cost, price, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [accountId, p.symbol ?? '', p.name, qty, cost, p.price || 0, p.note ?? '']
    );
    // 买入：从该账户现金扣减成本（市值=quantity*price，现金只受成本影响）
    await adjustCash(accountId, -(cost * qty));
    return r.lastInsertId as number;
  });
}

export async function updateHolding(id: number, p: HoldingInput): Promise<void> {
  return runInTransaction(async () => {
    const [cur] = await select<Holding>(`SELECT * FROM account_holdings WHERE id = $1`, [id]);
    if (!cur) return;
    const oldCashImpact = -(cur.cost * cur.quantity);
    const newQty = p.quantity ?? cur.quantity;
    if (newQty <= 0) {
      // 清仓：返还该笔原成本，删除持仓
      await adjustCash(cur.account_id, -oldCashImpact);
      await execute(`DELETE FROM account_holdings WHERE id = $1`, [id]);
      return;
    }
    const newCost = p.cost ?? cur.cost;
    const newCashImpact = -(newCost * newQty);
    const delta = newCashImpact - oldCashImpact; // >0 需退现金，<0 需补扣
    if (delta < 0) await assertEnoughCash(cur.account_id, -delta); // 加量/提高成本需再补现金
    await adjustCash(cur.account_id, delta);
    await execute(
      `UPDATE account_holdings
         SET symbol=$1, name=$2, quantity=$3, cost=$4, price=$5, note=$6,
             updated_at = datetime('now','localtime')
       WHERE id=$7`,
      [p.symbol ?? cur.symbol, p.name ?? cur.name, newQty, newCost, p.price ?? cur.price, p.note ?? cur.note, id]
    );
  });
}

export async function deleteHolding(id: number): Promise<void> {
  return runInTransaction(async () => {
    const [cur] = await select<Holding>(`SELECT * FROM account_holdings WHERE id = $1`, [id]);
    if (!cur) return;
    // 删除持仓：按成本把现金返还给该账户
    await adjustCash(cur.account_id, cur.cost * cur.quantity);
    await execute(`DELETE FROM account_holdings WHERE id = $1`, [id]);
  });
}