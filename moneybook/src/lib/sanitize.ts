/**
 * 数据脱敏（PII Masking）
 * ---------------------------------------------------------------
 * 目标：即使开启「允许发送明细」，在内容被组装进发送给 AI 的 prompt 之前，
 * 也必须先经过本模块处理，强制屏蔽个人隐私与敏感信息，避免用户名、联系方式、
 * 证件号、银行卡、邮箱、地址等被上传到任何外部接口，造成泄露。
 *
 * 本模块不做任何网络请求，纯本地字符串处理。任何需要上送明细的调用方
 * 都必须先调用 sanitizeNote / sanitizeRow 之后再拼接进 prompt。
 */

/** 脱敏后的手机号：保留前 3 位 + 后 4 位。限定为独立 11 位，避免截取身份证号等更长数字的内部子串 */
const mobileRe = /(?<![\d.])1[3-9]\d{9}(?![\d])/g;
function maskMobile(m: string) {
  return `${m.slice(0, 3)}****${m.slice(7)}`;
}

/** 座机：010-12345678 / 0757-1234567。必须带连字符/空格分隔，避免把普通数字误伤为座机 */
const landlineRe = /0\d{2,3}\s?[-—]\s?\d{7,8}\b/g;

/** 身份证：18 位（末位可为 X），保留前 4 后 4 */
const idcardRe = /(?<![\d])(?:\d{17})(?:[\dXx])(?![\d])/g;
function maskIdcard(m: string) {
  return `${m.slice(0, 4)}**********${m.slice(-4)}`;
}

/** 银行卡：13~19 位连续数字，保留首尾 4。以词边界限定，避免把订单号/时间戳等普通数字误伤 */
const accountRe = /(?<![\w.])\d{13,19}(?![\d])/g;
function maskNumber(m: string) {
  return `${m.slice(0, 4)}${'*'.repeat(Math.max(4, m.length - 8))}${m.slice(-4)}`;
}

/** 邮箱：隐藏 @ 前的部分，仅留首字符 */
const emailRe = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
function maskEmail(m: string) {
  const at = m.indexOf('@');
  return `${m[0]}***${m.slice(at)}`;
}

/** 网址：保留协议与域名，遮蔽路径/参数 */
const urlRe = /https?:\/\/[^\s，。；、）)]+/g;
function maskUrl(m: string) {
  const m2 = m.replace(/\/+$/, '');
  const schemeEnd = m2.indexOf('://') + 3;
  let i = schemeEnd;
  while (i < m2.length && /[A-Za-z0-9.:\-]/.test(m2[i])) i++; // 域名(含端口)
  return `${m2.slice(0, i)}/***`;
}

/**
 * 私网/本机 IPv4：10.x / 172.16~31.x / 192.168.x / 127.x。
 * 只遮罩明确属于私网的地址，避免把「3.9.1.2」这种版本号误当 IP。
 */
const ipv4Re = /(?<![\d.])127\.\d{1,3}(?:\.\d{1,3}){2}(?![\d.])|(?<![\d.])10\.\d{1,3}(?:\.\d{1,3}){2}(?![\d.])|(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d.])|(?<![\d.])172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}(?![\d.])/g;
function maskIpv4(m: string) {
  const parts = m.split('.');
  return `${parts[0]}.${parts[1]}.***.***`;
}

/** 车牌：省份 + 城市字母 + 5~6 位 */
const plateRe = /[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新][\u4e00-\u9fa5A-Z][A-Z0-9]{4,6}/g;
function maskPlate(m: string) {
  return `${m.slice(0, 2)}·***`;
}

/** 微信 id */
const wxidRe = /wxid_[A-Za-z0-9_-]{4,}/g;

/**
 * 将一段文本中的个人敏感信息脱敏。
 * 适用于交易备注、名称等任意可能包含 PII 的字符串。
 * 注意：会先"保护"订单号/交易单号语境下的长编号——订单号不是个人敏感信息，
 * 且需保留用于 AI 回填与检索；若不加保护，13~19 位纯数字订单号会被下方银行卡规则
 * 误掩码，导致「AI 解析（走脱敏文本）」与「本地启发式（走原文）」两种入口结果不一致。
 */
export function maskSensitive(text: string): string {
  if (!text) return text;
  let out = String(text);

  // 先保护订单号语境的编号：把「订单号/商家订单号/交易单号/流水号/单号」等后紧邻的
  // 6 位以上字母数字串替换为哨兵占位，脱敏完成后原样还原，避免被银行卡规则误伤。
  const orderSentinels = new Map<string, string>();
  let orderSeq = 0;
  out = out.replace(
    /(商家订单号|商户订单号|订单号|交易单号|交易号|流水号|订单流水|单号|order_no|merchant_order_no|OrderNo)[\s：:]*([A-Za-z0-9_-]{6,})/gi,
    (m, _label, value) => {
      const sentinel = `\u0001K${orderSeq++}\u0002`;
      orderSentinels.set(sentinel, value);
      return m.replace(value, sentinel);
    }
  );

  // 注意顺序：先处理更精确的高价值模式
  out = out.replace(mobileRe, maskMobile); // 手机
  out = out.replace(idcardRe, maskIdcard); // 身份证
  out = out.replace(emailRe, maskEmail); // 邮箱
  out = out.replace(urlRe, maskUrl); // 网址
  out = out.replace(ipv4Re, maskIpv4); // IP
  out = out.replace(plateRe, maskPlate); // 车牌
  out = out.replace(wxidRe, () => 'wxid_****'); // 微信号
  out = out.replace(landlineRe, (m) => {
    // 010-12345678 → 010-****5678；0757 1234567 → 0757****567
    const firstSep = m.search(/[-—\s]/);
    const prefix = m.slice(0, firstSep === -1 ? 4 : firstSep + 1);
    const tail = m.slice(firstSep === -1 ? 4 : firstSep + 1, m.length - 3);
    return `${prefix}***${tail ? '*' : ''}${m.slice(-3)}`;
  });
  out = out.replace(accountRe, maskNumber); // 银行卡（13~19 位）

  // 还原被保护的订单号编号
  for (const [sentinel, raw] of orderSentinels) {
    out = out.split(sentinel).join(raw);
  }
  return out;
}

/** 一条交易记录的脱敏：只保留分类、金额与脱敏后的备注，不暴露具体账户名与完整日期。 */
export function sanitizeRow(row: {
  date: string;
  amount: number;
  note?: string;
  categoryName?: string | null;
}): string {
  const d = /^\d{4}-(\d{2})-(\d{2})/.test(row.date ?? '')
    ? String(row.date).slice(5) // 仅保留 MM-DD，不暴露完整日期有助于降低可识别性
    : (row.date ?? '');
  const note = maskSensitive(row.note ?? '');
  return `- ${d}  ${row.categoryName ?? '未分类'}  ¥${(+row.amount).toFixed(2)}  备注：${note || '（无备注）'}`;
}

/**
 * 供"确实需要收款方才能上送的场景"（如 AI 智能分类）在把文本发给外部前统一调用：
 * 对备注/收款方/账户名等信息中的 PII 先做脱敏（手机/证件/卡号/邮箱/微信号/座机等），
 * 保障即使开启允许发送明细，也绝不把个人隐私原文上送。不做任何网络请求。
 */
export function sanitizeForClassification(text?: string): string {
  return maskSensitive(String(text ?? ''));
}