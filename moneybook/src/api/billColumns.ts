/**
 * 账单列解析辅助：借贷/收支**分列**识别 + 收支方向判定 + 金额清洗。
 * ---------------------------------------------------------------
 * 目标（路线图第 3 项「导入生态扩展」——自动识别能力更强）：
 * 1) 识别「收入金额/支出金额」「借方发生额/贷方发生额」等**成对分列**的银行流水；
 *    既有实现把这两列当作同一字段的同义别名，只会认领第一个，另一列为空时金额被判为 0 而整行跳过；
 * 2) 支持「借贷标志」列取值为「借/贷」时的方向判定（原来只认"收入/支出"等词，借/贷会被跳过）。
 *
 * 纯函数、自包含（不 import import.ts，避免与 import.ts 形成循环依赖）。
 */

/** 分列·收入侧列名（必须带"金额/发生额"语义，避免把「收入/支出」这类方向列误当金额列） */
export const SPLIT_INCOME_ALIASES = [
  '收入金额', '贷方发生额', '贷方金额', '存入金额', '转入金额', '收款金额', '入账金额',
];

/** 分列·支出侧列名（同上，须带金额语义） */
export const SPLIT_EXPENSE_ALIASES = [
  '支出金额', '借方发生额', '借方金额', '支取金额', '转出金额', '付款金额', '出账金额',
];

/** 表头归一化：去空白/全角/斜杠、转小写、括号半角化（与 import.ts normalizeHeader 同口径） */
function normHeader(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/[\s\u3000\/／]/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')');
}

/** 在表头行中找首个"包含别名"的列下标（沿用 import.ts 的单向包含原则），找不到返回 -1 */
function indexOfAlias(row: string[], aliases: string[]): number {
  for (let i = 0; i < row.length; i++) {
    const nh = normHeader(row[i]);
    if (!nh) continue;
    if (aliases.some((a) => {
      const na = normHeader(a);
      return nh === na || nh.includes(na);
    })) return i;
  }
  return -1;
}

/**
 * 识别「借贷/收支分列」账单：表头同时存在收入侧与支出侧金额列（且不是同一列）。
 * @returns 两侧列下标；任一缺失返回 { incomeCol: -1, expenseCol: -1 }
 */
export function detectSplitColumns(header: string[]): { incomeCol: number; expenseCol: number } {
  const incomeCol = indexOfAlias(header, SPLIT_INCOME_ALIASES);
  const expenseCol = indexOfAlias(header, SPLIT_EXPENSE_ALIASES);
  if (incomeCol >= 0 && expenseCol >= 0 && incomeCol !== expenseCol) return { incomeCol, expenseCol };
  return { incomeCol: -1, expenseCol: -1 };
}

/**
 * 收支方向判定：兼容「借贷标志」的 借=支出 / 贷=收入，
 * 以及「收入/支出」「收款/付款」等常见写法；「不计收支/中性」与空值返回 null。
 * 注意：单字"借/贷"仅在整格等于该字时命中，避免把"贷款""借款"等复合词误判为支出方向。
 */
export function classifyBillDirection(raw: unknown): 'income' | 'expense' | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (/不计|中性/.test(t) || /^\s*\/\s*$/.test(t)) return null;
  if (/贷方/.test(t) || t === '贷') return 'income';
  if (/借方/.test(t) || t === '借') return 'expense';
  if (/收入|收款|入账|存入|转入|到账/.test(t)) return 'income';
  if (/支出|付款|消费|转出|汇款/.test(t)) return 'expense';
  return null;
}

/** 金额清洗：去千分位、货币符号与空白后取绝对值；无法解析返回 0。 */
export function cleanAmount(raw: unknown): number {
  return Math.abs(parseFloat(String(raw ?? '').replace(/[,，元¥￥\s]/g, '')) || 0);
}
