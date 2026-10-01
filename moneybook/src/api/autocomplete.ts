/**
 * 智能补全（历史驱动的标签 / 商户推荐）
 * ---------------------------------------------------------------
 * 蓝图：根据历史自动推荐 分类 / 账户 / 标签 / 商户。
 *  - 分类 / 账户：由 suggestForText（规则→AI→本地兜底）承担。
 *  - 标签 / 商户：本模块基于「已记账历史」做本地高频共现推荐，纯函数、零网络、可解释。
 * 原则：规则/统计能解决的不上 AI；只做建议，一切可回退、可编辑。
 */

/** 历史交易的最小输入形态（在调用侧聚合标签后传入） */
export interface HistoryTx {
  note: string;
  payee: string;
  tagIds: number[];
}

/** 把文本切为词元（中英文均按空白切分，过滤过短词元），用于与历史备注/收款方做包含匹配。 */
export function tokenize(text: string): string[] {
  return String(text ?? '')
    .split(/[\s,，。；;、/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** 归一商户名（去除括号/空格/星号等噪声），便于频次归并。 */
export function normMerchant(name: string): string {
  return String(name ?? '').replace(/[\s（）()*]/g, '');
}

/**
 * 标签推荐（纯函数）：取与输入文本词元共现过的历史交易，统计其中各标签的出现频次，
 * 返回 Top N 标签（高→低）；无命中或无标签时返回空数组。仅本地统计，不上云。
 */
export function recommendTags(text: string, history: HistoryTx[], limit = 3): number[] {
  const tokens = tokenize(text);
  if (!tokens.length || !history.length) return [];
  const freq = new Map<number, number>();
  for (const h of history) {
    const hay = `${h.payee || ''} ${h.note || ''}`;
    if (!tokens.some((t) => hay.includes(t))) continue;
    for (const id of h.tagIds) freq.set(id, (freq.get(id) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * 商户推荐（纯函数）：找与输入词元共现过的历史交易，按其收款方（归一后）出现频次，
 * 返回 Top N 商户名（排除空）；无命中返回空数组。
 */
export function recommendMerchant(text: string, history: HistoryTx[], limit = 2): string[] {
  const tokens = tokenize(text);
  if (!tokens.length || !history.length) return [];
  const freq = new Map<string, { count: number; display: string }>();
  for (const h of history) {
    const payee = String(h.payee ?? '').trim();
    if (!payee) continue;
    const hay = `${payee} ${h.note || ''}`;
    if (!tokens.some((t) => hay.includes(t))) continue;
    const key = normMerchant(payee);
    const cur = freq.get(key);
    if (cur) cur.count += 1;
    else freq.set(key, { count: 1, display: payee });
  }
  return [...freq.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([, v]) => v.display);
}