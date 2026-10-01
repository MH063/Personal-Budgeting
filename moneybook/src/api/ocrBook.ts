/**
 * 票据/截图 OCR → AI 记账户解析串联模块
 * -----------------------------------------------------------------------------
 * 流程：本地 OCR 得到文本 → maskSensitive 脱敏 → 交给 AI（BOOK_SYSTEM）解析成账。
 * 隐私边界：
 *  1. 原始 OCR 文本绝不直接发送给 AI，必须先经 maskSensitive 脱敏；
 *  2. prompt 中的账户/分类只使用「名称白名单」，不发送金额库存等明细；
 *  3. 图片始终只在本机 OCR 处理，绝不外传（见 lib/ocr.ts）。
 *
 * 可用性：即使未配置 AI（chat 抛 NO_AUTH 错），也返回 {text: 已脱敏文本, items}
 * 不阻断——识别出的金额/日期/支付时间/付款方式/收款方/订单号等会经
 * 【本地启发式解析】填入 items，让用户无需配置 AI 也能一键填表。
 */
import { maskSensitive } from '@/lib/sanitize';
import { normalizeOcrText } from '@/lib/ocr';
import dayjs from 'dayjs';
import { BOOK_SYSTEM, parseBookOutput, type AiBookItem } from '@/api/aiBook';
import { chat, type ChatMessageInput } from '@/api/llm';
import type { Account } from '@/api/accounts';
import type { Category } from '@/api/categories';

export interface OcrBookResult {
  /** 已脱敏、可安全展示给用户 / 提供给 AI 的文本 */
  text: string;
  /** 解析出的记账项；AI 未配置或解析失败时由本地启发式解析兜底，可能仍为空 */
  items: AiBookItem[];
  /** 是否成功调用 AI（false 表示未配置 AI，或解析中间出错） */
  aiParsed: boolean;
}

/** 组装发送给 AI 的 user 消息：仅含名称白名单 + 已脱敏票据文本 */
export function buildOcrPrompt(maskedText: string, accounts: Account[], cats: Category[]): string {
  const accNames = accounts.map((a) => a.name).filter(Boolean);
  const expNames = cats.filter((c) => c.type !== 'income').map((c) => c.name).filter(Boolean);
  const incNames = cats.filter((c) => c.type === 'income').map((c) => c.name).filter(Boolean);
  return (
    '【可用的账户名称】' + (accNames.length ? accNames.join('、') : '（为空）') + '\n' +
    '【可用的支出分类名称】' + (expNames.length ? expNames.join('、') : '（为空）') + '\n' +
    '【可用的收入分类名称】' + (incNames.length ? incNames.join('、') : '（为空）') + '\n' +
    '\n【请解析的票据识别文本（已脱敏，其中包含的金额、分类、账户等信息请照实提取）】\n' +
    maskedText +
    '\n\n注意：票据中的「合计」「应付金额」「总计」等汇总字段，以及商品件数（如"共 N 件"）、日期、支付时间、付款方式、收款方全称、订单号、商家订单号，均为本条交易的元信息，要填入对应条目的 payTime/payMethod/payee/orderNo/merchantOrderNo 字段，不要把任何元信息作为独立记账条目重复记账；只把每件商品/每一笔实际消费解析为一条。请严格按系统规则输出 JSON 数组；无法确认的字段留空，不要编造。'
  );
}

// ========================= 本地启发式解析（无 AI 兜底） =========================
// 以下全部为纯函数、只在本机运行，不涉及任何网络请求与上传。
// 目的：未配置 AI 时，也能从识别文本中抽出「金额/日期/支付时间/付款方式/
// 收款方全称/订单号/商家订单号/商品说明」并回填记账表单，解决"本地识别无法填表"。

/** 金额解析：优先「合计/总计/实付/应付」关联值，否则取识别到的最大 ¥ 金额 */
function pickAmount(text: string): number | null {
  const t = String(text ?? '');
  const sum = t.match(/(?:合计|总价|实付|应付金额|总计|实收|金额)[：:\s]*[¥￥]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (sum) {
    const v = Number(sum[1].replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) return v;
  }
  // 兜底一：所有带货币符号的金额取最大者（离群金额不丢失，也避免把订单号当金额）
  const withSign: number[] = [];
  for (const m of t.matchAll(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) withSign.push(v);
  }
  if (withSign.length) return Math.max(...withSign);
  // 兜底二：罕见情况无货币符号时，取最大普通小数
  const plain: number[] = [];
  for (const m of t.matchAll(/(?:^|[^\d])(\d+(?:\.\d{1,2}))\b/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) plain.push(v);
  }
  return plain.length ? Math.max(...plain) : null;
}

/** 取出某标签后的文本片段：从标签结束处起，截取至首个中英句读/换行（不含顿号，商品说明常用顿号分隔） */
function textAfter(t: string, labels: string[]): string {
  for (const lab of labels) {
    const i = t.indexOf(lab);
    if (i === -1) continue;
    const seg = t.slice(i + lab.length).replace(/^[：:\s]+/, '');
    const m = seg.match(/^([^，。；\n|]{2,40})/);
    if (m) return m[1].trim();
  }
  return '';
}

/** 订单号/交易单号类：优先取标签紧邻的编号 token，避免跨过无关内容误取后文更长串 */
function alnumAfter(t: string, labels: string[]): string {
  for (const lab of labels) {
    const i = t.indexOf(lab);
    if (i === -1) continue;
    const seg = t.slice(i + lab.length).replace(/^[：:\s]*/, '');
    // ① 紧邻值：字母开头至少 3 位 / 纯数字或连字符至少 5 位，视为订单号。
    //    限定紧邻位，避免把标签后夹带的金额/时间等当成订单号。
    const near = seg.match(/^([A-Za-z][A-Za-z0-9_-]{2,}|[0-9][0-9_-]{4,})/);
    if (near) return near[1].trim();
    // ② 兜底：标签与值被换行/符号隔开时，向后找第一个较长编号
    const deep = seg.match(/[A-Za-z][A-Za-z0-9_-]{5,}|[0-9][0-9_-]{5,}/);
    if (deep) return deep[0].trim();
  }
  return '';
}

/**
 * 从文本中剔除指定标签（含其后的整段，到首个中英文句读/换行为止），
 * 用于避免「订单号」误匹配到「商家订单号/商户订单号」这类子串。
 * 返回剔除后的文本副本；仅本地启发式解析使用，不修改原始文本。
 */
function stripLabels(t: string, labels: string[]): string {
  let out = t;
  for (const lab of labels) {
    const i = out.indexOf(lab);
    if (i === -1) continue;
    const seg = out.slice(i + lab.length).replace(/^[：:\s]+/, '');
    const end = seg.search(/[，。；、\n|]/);
    const len = end === -1 ? seg.length : end;
    out = out.slice(0, i) + out.slice(i + lab.length + len);
  }
  return out;
}

/** 日期解析：支持 2026-09-27 / 2026/9/27 / 2026年9月27日 → YYYY-MM-DD */
function extractDate(t: string): string {
  const m = t.match(/(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})/);
  if (!m) return '';
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return dayjs(d).isValid() ? d : '';
}

/** 支付时间解析：日期 + 首次出现的 HH:mm[:ss] 组合；无时间则返回到日期 */
function extractPayTime(t: string): string {
  const d = extractDate(t);
  if (!d) return '';
  const tm = t.match(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/);
  if (!tm) return d;
  const h = tm[1].padStart(2, '0');
  const min = tm[2];
  const sec = tm[3] ? tm[3].padStart(2, '0') : '';
  return `${d} ${h}:${min}${sec ? `:${sec}` : ''}`;
}

/**
 * 从 OCR 票据文本中做「无 AI 启发式解析」，返回单条支出记账项（尽力而为）。
 * 账户/分类无法可靠匹配名称→ID，故标记 unmatched 供用户在表单手动补选。
 * @returns 解析出金额时返回 [item]，否则为空数组
 */
export function heuristicExtractOcrItems(
  ocrText: string,
  _accounts: Account[],
  _cats: Category[]
): AiBookItem[] {
  const t = String(ocrText ?? '').trim();
  if (!t) return [];
  const amount = pickAmount(t);
  if (!amount) return [];
  const date = extractDate(t);
  // 备注 note：只从明确的「商品说明/品名/备注」标签提取；不再兜底取第一行——
  // 小票首行常是商户名/收款方（会单独识别为 payee）或「店名+金额」，
  // 兜底写入会与 payee / amount 语义重复。
  const note = textAfter(t, ['商品说明', '商品名称', '备注', '摘要', '品名']);
  // 先抽商家订单号，再从剔除商家标签区的文本中抽「订单号」，避免「订单号」误匹配到
  // 「商家订单号/商户订单号」子串
  const merchantOrderNo = alnumAfter(t, ['商家订单号', '商户订单号', '商户单号']) || '';
  const tNoMerchant = stripLabels(t, ['商家订单号', '商户订单号', '商户单号']);
  const orderNo = alnumAfter(tNoMerchant, ['订单号', '单号']) || '';
  return [{
    type: 'expense',
    amount,
    date: date || dayjs().format('YYYY-MM-DD'),
    note: note || 'OCR 记账',
    payTime: extractPayTime(t) || undefined,
    payMethod: textAfter(t, ['付款方式', '支付方式']) || undefined,
    payee: textAfter(t, ['收款方全称', '收款方', '商户全称', '收款单位', '商家名称']) || undefined,
    orderNo: orderNo || undefined,
    merchantOrderNo: merchantOrderNo || undefined,
    unmatched: ['account', 'category'],
  }];
}

/**
 * 将 OCR 识别文本（原始、含 PII）转换为记账项。
 * @param ocrText 本地 OCR 识别出的原始文本（未脱敏）
 * @param accounts 账户列表（用于名称白名单与匹配）
 * @param cats     分类列表（用于名称白名单与匹配）
 * @param chatFn   可注入的 AI 调用（默认 llm.chat，便于单测 mock）；
 *                 未配置 AI 时 chat 会抛错，此处捕获后以本地启发式解析兜底。
 */
export async function ocrTextToItems(
  ocrText: string,
  accounts: Account[],
  cats: Category[],
  chatFn: (messages: ChatMessageInput[], opts?: { signal?: AbortSignal }) => Promise<string> = chat
): Promise<OcrBookResult> {
  // 关键隐私步骤：先归一化再脱敏，之后才会出现在任何可上送内容中。
  // 启发式解析作用在归一化后的原始文本上（纯本机，用于回填表单，不上送）。
  const normalized = normalizeOcrText(ocrText);
  const masked = maskSensitive(normalized);
  if (!masked) return { text: '', items: [], aiParsed: false };

  const user = buildOcrPrompt(masked, accounts, cats);
  const messages: ChatMessageInput[] = [
    { role: 'system', content: BOOK_SYSTEM },
    { role: 'user', content: user },
  ];
  try {
    const raw = await chatFn(messages);
    const items = parseBookOutput(raw, accounts, cats);
    // AI 解析出条目则优先采纳；若 AI 成功但未解析出条目，退回本地启发式
    return { text: masked, items: items.length ? items : heuristicExtractOcrItems(normalized, accounts, cats), aiParsed: true };
  } catch {
    // AI 未配置 / 网络失败均不阻断：以本地启发式解析兜底，仍可一键回填表单
    return { text: masked, items: heuristicExtractOcrItems(normalized, accounts, cats), aiParsed: false };
  }
}