/**
 * 交易字段抽取与清洗（本地规则，无网络）
 * ---------------------------------------------------------------
 * 从交易的备注/收款方等"脏文本"中抽取并修正字段：
 *   - 支付方式识别（微信/支付宝/银行卡/现金/信用/花呗/白条）
 *   - 优惠/折扣：识别「原价 / 优惠 / 满减 / 立减 / 券」→ 原价与优惠额
 *   - 手续费/税费/小费/押金/预授权：单独提取，避免混入净消费金额
 *   - 退款/退货：识别冲抵候选
 * 全部纯函数，便于单测；不做任何网络请求。
 */

export interface PayMethodHit {
  name: string;
  icon: string;
}

const PAY_METHODS: Array<{ name: string; icon: string; keys: string[] }> = [
  { name: '微信', icon: '💬', keys: ['微信'] },
  { name: '支付宝', icon: '🐜', keys: ['支付宝'] },
  { name: '花呗', icon: '🌸', keys: ['花呗'] },
  { name: '白条', icon: '🛒', keys: ['白条'] },
  { name: '信用卡', icon: '💳', keys: ['信用卡', '信用'] },
  { name: '银行卡', icon: '🏦', keys: ['银行卡', '储蓄卡', '借记卡'] },
  { name: '现金', icon: '💵', keys: ['现金'] },
];

/** 从文本识别支付方式（首个命中） */
export function extractPayMethod(text: string): PayMethodHit | null {
  const t = String(text ?? '');
  for (const m of PAY_METHODS) {
    if (m.keys.some((k) => t.includes(k))) return { name: m.name, icon: m.icon };
  }
  return null;
}

/** 是否退款/退货语义 */
export function isRefund(text: string): boolean {
  return /退款|退货|撤回|冲正|refund/i.test(String(text ?? ''));
}

export interface CleanTransaction {
  /** 识别到的实付金额（文本中裸金额/实付） */
  paid?: number;
  /** 原价（若注明） */
  original?: number;
  /** 优惠额（优惠/减免/满减/立减/券） */
  discount?: number;
  /** 手续费/税费/服务费/运费/小费/押金/预授权等附加金额 */
  fee?: number;
  /** 净消费 = paid - fee（供参考） */
  cleanAmount?: number;
  payMethod: PayMethodHit | null;
  isRefund: boolean;
  /** 命中的原始子串，便于展示依据 */
  hits: string[];
}

const SEP = '(?:[\\s:：为是]*)';
const FEE_RE = new RegExp(`(?:手续费|服务费|配送费|运费|税费|小费|押金|预授权)${SEP}([\\d.]+)`);
const DISCOUNT_RE = new RegExp(`(?:优惠|减免|满减|立减|抵扣|券)${SEP}([\\d.]+)`);
const ORIGINAL_RE = new RegExp(`原价${SEP}([\\d.]+)`);
const PAID_RE = new RegExp(`(?:实付|实际支付|支付金额)${SEP}([\\d.]+)`);

/** 清洗：从脏文本抽取支付方式、优惠、手续费、退款意图并给净消费参考值。 */
export function cleanTransaction(dirty: string): CleanTransaction {
  const text = String(dirty ?? '');
  const hits: string[] = [];
  const out: CleanTransaction = { payMethod: extractPayMethod(text), isRefund: isRefund(text), hits };

  const feeM = text.match(FEE_RE);
  if (feeM) { out.fee = Number(feeM[1]); hits.push(feeM[0]); }

  const paidM = text.match(PAID_RE);
  if (paidM) { out.paid = Number(paidM[1]); hits.push(paidM[0]); }

  const orgM = text.match(ORIGINAL_RE);
  if (orgM) { out.original = Number(orgM[1]); hits.push(orgM[0]); }

  const disM = text.match(DISCOUNT_RE);
  if (disM) { out.discount = Number(disM[1]); hits.push(disM[0]); }

  // 无"实付"，则取首个最像金额的数字作为 paid（简单启发式，非订单号）
  if (out.paid == null) {
    const bare = text.match(/(?<![\d.])([\d]+(?:\.[\d]{1,2})?)(?![\d])/);
    if (bare) { out.paid = Number(bare[1]); }
  }

  if (out.paid != null && out.fee != null) {
    out.cleanAmount = Math.max(0, out.paid - out.fee);
  } else if (out.paid != null) {
    out.cleanAmount = out.paid;
  }
  return out;
}

export interface RefundMatch {
  refundPayee: string;
  amount: number;
  originalPayee?: string;
  /** 冲抵建议：若找到原交易（同收款方、同金额反向），标记可冲抵 */
  offsetCandidate: boolean;
}

/**
 * 退款/冲抵候选：给出一组流水，找出"退款行"，并尝试关联同收款方、金额相匹配的原交易。
 * 仅作建议展示，不改数据。
 */
export function suggestRefundOffset(rows: Array<{ payee: string; amount: number }>): RefundMatch[] {
  // 正向（消费）按 payee+金额索引
  const positives = new Map<string, number>();
  const out: RefundMatch[] = [];
  for (const r of rows) {
    const key = `${String(r.payee ?? '').trim()}||${Math.abs(r.amount)}`;
    if (r.amount > 0) {
      if (!positives.has(key)) positives.set(key, 0);
      positives.set(key, (positives.get(key) ?? 0) + r.amount);
    } else {
      out.push({ refundPayee: r.payee, amount: r.amount, offsetCandidate: (positives.get(key) ?? 0) >= Math.abs(r.amount) });
    }
  }
  return out;
}