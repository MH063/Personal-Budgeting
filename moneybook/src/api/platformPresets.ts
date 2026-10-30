import type { ColumnMap, ImportFieldKey } from './import';
import { billColIndex } from './import';

/**
 * 内置「平台导入预设」（纯数据 + 纯函数，无 IO / 无 AI / 无 DB）。
 * ---------------------------------------------------------------
 * 目标（路线图第 3 项「导入生态扩展」——更多银行/平台模板）：
 * 用户导入各银行/平台导出的账单时，先按平台自动套用「列名 → 业务字段」映射，
 * 免去逐列手工指认（既有「列映射预览」的手动调整仍是兜底，本预设只作默认建议）。
 *
 * 设计要点（与自动识别同一口径，避免出现两套判定）：
 *  - 每个预设给出该平台**常见列名写法**（columns），由 presetToColumnMap 落到实际列索引；
 *  - 表头匹配复用导入模块的 billColIndex（去空白/全角/斜杠归一化 + "表头包含别名"单向匹配）；
 *  - matchPlatformPreset 以**文件名特征词**为主、表头特征词为辅，仅作推荐，用户可改；
 *  - 同一列只被一个字段认领（按 PRESET_FIELD_ORDER 顺序），避免多字段抢占同一列。
 *
 * 注意：账单里的「收/付款方式、支付方式」在本应用语义下即"资金渠道（账户）"，
 * 故预设一律把它映射到 account 字段（而非仅展示用的 payMethod），确保导入能归入正确账户。
 */

/** 平台预设：一个平台的常见列名约定 */
export interface PlatformPreset {
  /** 唯一 id（英文小写，供日志/调试定位） */
  id: string;
  /** 展示名（中文，界面下拉使用） */
  name: string;
  /** 平台特征词：出现在文件名或表头即视为该平台（用于自动推荐） */
  aliases: string[];
  /** 业务字段 → 该平台常见列名（大小写/全角差异由归一化匹配容忍） */
  columns: Partial<Record<ImportFieldKey, string[]>>;
}

/** 字段认领顺序：越靠前越先占用列，避免同一列被多字段抢占（与 import.buildColumnMap 同思路） */
const PRESET_FIELD_ORDER: ImportFieldKey[] = [
  'date', 'payTime', 'type', 'amount', 'account', 'toAccount', 'payee',
  'orderNo', 'merchantOrderNo', 'payMethod', 'category', 'note',
];

// 常用列名片段（多条预设复用，集中定义便于统一调整）
const C: Record<string, string[]> = {
  time: ['交易时间', '交易日期', '记账时间', '记账日期', '时间', '日期'],
  io: ['收/支', '收支', '收支类型', '借贷标志', '借贷方向', '收付标志', '收入/支出'],
  amount: ['交易金额', '发生额', '金额(元)', '金额（元）', '收入金额', '支出金额', '金额'],
  peer: ['交易对方', '对方户名', '对方账户名称', '对方账号', '商户名称', '商家名称', '收款方', '对方'],
  goods: ['商品说明', '商品名称', '商品', '交易摘要', '摘要', '用途'],
  channel: ['收/付款方式', '收付款方式', '支付方式', '付款方式', '付款账户', '扣款账户', '出账账户', '资金来源', '资金渠道', '账户名称'],
  orderNo: ['交易订单号', '交易单号', '商户单号', '订单号', '流水号', '交易号', '流水'],
  merchantNo: ['商家订单号', '商户订单号', '专柜单号'],
  note: ['备注', '附言', '描述'],
};

/**
 * 常见平台预设（覆盖主流支付平台与银行导出格式）。
 * 说明：银行账单多为「借贷标志 + 交易金额 + 对方户名 + 摘要」的通用形态，
 * 差异主要在列名写法，故按各行列名习惯分别给出。
 */
export const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    id: 'alipay',
    name: '支付宝',
    aliases: ['支付宝', 'alipay'],
    columns: {
      date: C.time,
      type: C.io,
      amount: C.amount,
      account: C.channel,
      payee: C.peer,
      note: [...C.goods, ...C.note],
      orderNo: ['交易订单号', '交易号', '订单号'],
      merchantOrderNo: C.merchantNo,
      payTime: ['交易创建时间', '交易时间'],
      category: ['交易分类', '商品分类'],
    },
  },
  {
    id: 'wechat',
    name: '微信支付',
    aliases: ['微信', 'wechat', 'weixin'],
    columns: {
      date: C.time,
      payTime: C.time,
      type: C.io,
      amount: C.amount,
      account: C.channel,
      payee: C.peer,
      note: [...C.goods, ...C.note],
      orderNo: ['交易单号', '订单号'],
      merchantOrderNo: ['商户单号', '商家订单号'],
      // 微信账单**没有消费分类列**：其「交易类型」只是 商户消费/转账/扫二维码付款 等交易形态，
      // 映射成分类会产生「商户消费」「扫二维码付款」等无意义分类（且会阻断正文商户名的词典兜底），
      // 故此处不映射分类列，分类交由解析层的商户名/商品说明关键词兜底。
    },
  },
  {
    id: 'cmb',
    name: '招商银行',
    aliases: ['招商银行', '招行', 'cmb'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账户', '账号', '卡号'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号', '交易流水号'],
    },
  },
  {
    id: 'icbc',
    name: '中国工商银行',
    aliases: ['工商银行', '工行', 'icbc'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账号', '卡号', '账户'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号'],
    },
  },
  {
    id: 'ccb',
    name: '中国建设银行',
    aliases: ['建设银行', '建行', 'ccb'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账号', '卡号', '账户'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号'],
    },
  },
  {
    id: 'abc',
    name: '中国农业银行',
    aliases: ['农业银行', '农行', 'abc'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账号', '卡号', '账户'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号'],
    },
  },
  {
    id: 'boc',
    name: '中国银行',
    aliases: ['中国银行', '中行', 'boc'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账号', '卡号', '账户'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号'],
    },
  },
  {
    id: 'bocom',
    name: '交通银行',
    aliases: ['交通银行', '交行', 'bocom'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账号', '卡号', '账户'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号'],
    },
  },
  {
    id: 'psbc',
    name: '中国邮政储蓄银行',
    aliases: ['邮政储蓄', '邮储', 'psbc'],
    columns: {
      date: C.time, payTime: C.time, type: C.io, amount: C.amount,
      account: ['账号', '卡号', '账户'], payee: C.peer, note: C.goods,
      orderNo: ['流水号', '凭证号'],
    },
  },
  {
    id: 'unionpay',
    name: '云闪付',
    aliases: ['云闪付', 'unionpay'],
    columns: {
      date: C.time, type: C.io, amount: C.amount, account: C.channel,
      payee: C.peer, note: [...C.goods, ...C.note], orderNo: ['订单号', '流水号'],
    },
  },
  {
    id: 'jd',
    name: '京东金融',
    aliases: ['京东金融', '京东', 'jd'],
    columns: {
      date: C.time, payTime: ['下单时间', '交易时间'], type: C.io, amount: C.amount,
      account: C.channel, payee: ['商户名称', '商家名称', '交易对方'],
      note: [...C.goods, ...C.note], orderNo: ['订单号'],
    },
  },
  {
    id: 'meituan',
    name: '美团',
    aliases: ['美团', 'meituan'],
    columns: {
      date: C.time, payTime: ['下单时间', '交易时间'], type: C.io, amount: C.amount,
      account: C.channel, payee: ['商家名称', '商户名称', '交易对方'],
      note: [...C.goods, ...C.note], orderNo: ['订单号'],
    },
  },
  {
    id: 'douyin',
    name: '抖音支付',
    aliases: ['抖音', 'douyin'],
    columns: {
      date: C.time, type: C.io, amount: C.amount, account: C.channel,
      payee: ['交易对方', '商户名称', '商家名称'],
      note: [...C.goods, ...C.note], orderNo: ['订单号', '交易号'],
    },
  },
  {
    id: 'mybank',
    name: '网商银行',
    aliases: ['网商银行', 'mybank'],
    columns: {
      date: C.time, type: C.io, amount: C.amount, account: ['账户', '账号'],
      payee: C.peer, note: C.goods, orderNo: ['流水号', '订单号'],
    },
  },
];

/** 平台匹配用文本归一化：去空白/全角空格、转小写（仅用于特征词包含判断）。 */
function normalizeForMatch(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[\s\u3000]/g, '');
}

/**
 * 推荐平台预设（纯函数）：
 *  - 优先按**文件名**特征词匹配（最可靠：导出文件名通常含平台名）；
 *  - 其次按**表头单元格**特征词匹配（部分账单首行含平台说明）；
 *  - 均未命中返回 null（由调用方回退到自动列推断 buildColumnMap）。
 */
export function matchPlatformPreset(header: string[] = [], fileName = ''): PlatformPreset | null {
  const fn = normalizeForMatch(fileName);
  if (fn) {
    for (const p of PLATFORM_PRESETS) {
      if (p.aliases.some((a) => fn.includes(normalizeForMatch(a)))) return p;
    }
  }
  const cells = (header ?? []).map(normalizeForMatch).filter(Boolean);
  if (cells.length) {
    for (const p of PLATFORM_PRESETS) {
      if (p.aliases.some((a) => {
        const na = normalizeForMatch(a);
        return na.length >= 2 && cells.some((c) => c.includes(na));
      })) return p;
    }
  }
  return null;
}

/**
 * 把平台预设落到**具体列索引**，产出可直接喂给 parseAoaWithMap 的映射。
 *  - 按 PRESET_FIELD_ORDER 顺序认领：每个字段取"首个命中且未被占用"的列；
 *  - 预设未给出的字段不映射（该列被忽略，与「不导入」一致）；
 *  - 无命中时返回空映射 {}，调用方可回退到 buildColumnMap 的自动推断。
 */
export function presetToColumnMap(preset: PlatformPreset, header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<number>();
  for (const field of PRESET_FIELD_ORDER) {
    const aliases = preset.columns[field];
    if (!aliases || !aliases.length) continue;
    // 传入已占用列作为排除集：同一列只被一个字段认领（如「交易日期/交易时间」分给 日期/支付时间）
    const idx = billColIndex(header, aliases as string[], used);
    if (idx >= 0) {
      map[field] = idx;
      used.add(idx);
    }
  }
  return map;
}
