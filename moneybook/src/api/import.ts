import dayjs from 'dayjs';
import { execute, runInTransaction, select } from './db';
import { currentLedgerId } from '@/lib/ledger';
import { listAccounts } from '@/api/accounts';
import { listCategories } from '@/api/categories';

/**
 * 导入可产生的交易类型：
 * - `income/expense`：普通收入/支出；
 * - `transfer`：转账（含「信用账户还款」：储蓄卡 → 花呗/白条/信用卡，清偿负债）；
 * - `repay_in`：收回款项（用于「退款退回信用账户」——信用账户余额回升即负债减少；
 *   且系统统计只聚合 income/expense，故它不会被误算成收入）。
 */
export type ImportTxType = 'income' | 'expense' | 'transfer' | 'repay_in';

/** 导入交易类型的展示标签（用于判定依据文案，前端不直接依赖） */
const IMPORT_TYPE_LABEL: Record<ImportTxType, string> = {
  income: '收入',
  expense: '支出',
  transfer: '转账',
  repay_in: '负债减少',
};

export interface ImportRow {
  date: string;
  type: ImportTxType;
  amount: number;
  account: string;      // 账户名称（支出/收入：扣款/入账账户；转账：转出账户）
  toAccount?: string;   // 仅转账：转入账户名称
  category?: string;
  note?: string;
  /** 交易扩展字段（来自 CSV 表头，可空） */
  payTime?: string;
  payMethod?: string;
  payee?: string;
  orderNo?: string;
  merchantOrderNo?: string;
  /** 原文件行号（用于错误定位） */
  line: number;
  /**
   * 若本行因规则校验被跳过（如收支方向为「/」的中性交易、金额无效、状态未成功等），
   * 记录跳过原因；此时 type 为占位值，需用户在预览中手动恢复为真实类型后才能导入。
   */
  _skippedReason?: string;
  /**
   * 待确认提示（如「退款去向待确认」「提现到账账户待确认」）：
   * 真实账单只给出「当初从哪个渠道付款」，不保证退款/提现的真实到账账户，
   * 因此此类行在预览中高亮提示，用户核对或修改账户后标记自动清除——绝不静默假设资金去向。
   */
  _pending?: string;
  /**
   * 判定依据（可解释性）：本行类型/账户/分类为何如此归类的说明（人话）。
   * 来源：命中的用户资金流向规则关键词、或内置账单识别分支（还款/退款/提现/收支方向）。
   * 前端以信息图标展示 tooltip，让用户明白「为什么被归为这一类型」，避免黑箱。
   */
  basis?: string;
  /** 行唯一标识：同一账单行派生多行时（提现「本金 + 服务费」）用于区分，避免预览里互相覆盖 */
  _rowKey?: string;
}

export interface ImportResult {
  imported: number;
  skipped: { line: number; reason: string }[];
  /** 因疑似重复导入而被自动跳过的条数（计入 skipped） */
  duplicates: number;
  createdAccounts: string[];
  createdCategories: string[];
  /** 每成功入库一行的落库引用，供「导入后待核对」按行定位到库中交易并修正 */
  importedRows: ImportedRowRef[];
}

/** 导入成功后每行的落库引用（rowKey → transactions.id 的映射） */
export interface ImportedRowRef {
  /** 对应 ImportRow 的行唯一标识（rowKeyOf） */
  rowKey: string;
  /** 原文件行号 */
  line: number;
  /** 落库后的 transactions.id */
  id: number;
  /** 解析后的账户 id（供事后改账户时复用，避免仅凭名称找不到新建账户） */
  accountId: number;
  /** 解析后的转入账户 id（仅转账） */
  toAccountId: number | null;
  /** 本行是「按推测口径先入库」的可疑行：值为待核对原因（如「退款去向待确认」）；正常行为 undefined */
  pending?: string;
}

/**
 * 用户自定义「资金流向判定规则」：命中关键词（包含匹配）时按规则指定类型/账户/分类，
 * 优先于内置的账单启发式判定。存于本机 settings 表（kv.importRules），无网络。
 * 用于把某商家/某说明文本固定归到某类型或某账户，避免每次导入都要手工纠正。
 */
export interface ImportRule {
  /** 匹配关键词（包含匹配，如「停车费」） */
  match: string;
  /** 命中后判定的交易类型 */
  type: ImportTxType;
  /** 命中后指定的账户名（可空：沿用账单解析结果） */
  account?: string;
  /** type=transfer 时的转入账户名（可空） */
  toAccount?: string;
  /** 命中后指定的分类名（可空：沿用账单解析结果） */
  category?: string;
  enabled: boolean;
}

/** 按用户规则匹配某行文本：返回首个「启用且 match 被包含」的规则；无命中返回 null。 */
export function matchImportRule(text: string, rules: ImportRule[] = []): ImportRule | null {
  const t = String(text ?? '');
  if (!t) return null;
  for (const r of rules) {
    if (r && r.enabled !== false && r.match && t.includes(r.match)) return r;
  }
  return null;
}

type RefAccount = { id: number; name: string };
type RefCategory = { id: number; name: string; type: string };

export interface ImportSmoke {
  accounts: RefAccount[];
  categories: RefCategory[];
  /** 当前账本已存在的交易订单号（用于导入预览的去重提醒） */
  existingOrderNos: string[];
}

/** 备注指纹归一化：去首尾空白、压缩内部空白与大写，降低同名备注的写差异（用于去重指纹） */
function normalizeFingerprintNote(note?: string): string {
  return String(note ?? '').replace(/\s+/g, '').trim();
}

/**
 * 计算交易的"去重指纹"：优先订单号（唯一）；无订单号时退回 `日期|类型|金额|账户|备注` 的精确组合。
 * 用于识别重复导入——同一笔流水再次导入时指纹相同，可被拦截。
 */
export function rowFingerprint(r: { date: string; type: string; amount: number; account: string; note?: string; orderNo?: string }): string {
  const orderNo = String(r.orderNo ?? '').trim();
  if (orderNo) return `order:${orderNo}`;
  return `fp:${r.date}|${r.type}|${r.amount}|${String(r.account).trim()}|${normalizeFingerprintNote(r.note)}`;
}

// 导入参考数据：当前账本下的账户 / 全局限分类（供前端解析时提示与校验）
export async function getImportReferences(): Promise<ImportSmoke> {
  const [accounts, categories, orderRows] = await Promise.all([
    listAccounts(false),
    listCategories(),
    select<{ order_no: string }>(`SELECT order_no FROM transactions WHERE ledger_id = $1 AND order_no IS NOT NULL AND order_no <> ''`, [currentLedgerId()]),
  ]);
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    existingOrderNos: [...new Set(orderRows.map((o) => o.order_no))],
  };
}

/**
 * 批量导入交易（余额中性：仅写入流水与统计，不改变账户当前余额）。
 * 账户/分类优先按名称匹配（账户当前账本内、分类按 名称+类型）；autoCreate 时自动创建缺失项。
 * 单行校验失败则跳过并记录原因，不影响其他行。
 */
export async function bulkImportTransactions(rows: ImportRow[], opts: { autoCreate: boolean }): Promise<ImportResult> {
  const lid = currentLedgerId();
  return runInTransaction(async () => {
    let successful = 0;
    const skipped: ImportResult['skipped'] = [];
    const importedRows: ImportedRowRef[] = [];
    const createdAccountsSet = new Set<string>();
    const createdCategoriesSet = new Set<string>();

    // 缓存：账户名 -> id，分类 key(name|type) -> id，避免重复查询
    const accMap = new Map<string, number>();
    const catMap = new Map<string, number>();
    for (const a of await select<RefAccount>(`SELECT id, name FROM accounts WHERE ledger_id = $1`, [lid])) accMap.set(a.name, a.id);
    for (const c of await select<RefCategory>(`SELECT id, name, type FROM categories`)) catMap.set(`${c.name}|${c.type}`, c.id);

    // 去重：已在本账本库中的订单号集合 + 本次批次已出现的（订单号 / 无订单指纹），防止重复导入重复入账
    let duplicates = 0;
    const existingOrders = new Set(
      (await select<{ order_no: string }>(
        `SELECT order_no FROM transactions WHERE ledger_id = $1 AND order_no IS NOT NULL AND order_no <> ''`, [lid]
      )).map((o) => o.order_no)
    );
    const batchOrders = new Set<string>();
    const batchFps = new Set<string>();

    for (const r of rows) {
      try {
        // —— 校验 ——
        if (!['income', 'expense', 'transfer', 'repay_in'].includes(r.type)) throw new Error(`不支持的交易类型「${r.type}」`);
        if (!(r.amount > 0)) throw new Error('金额必须大于 0');
        if (!r.date || !dayjs(r.date).isValid()) throw new Error(`日期无效：${r.date}`);
        const date = dayjs(r.date).format('YYYY-MM-DD');
        if (!r.account) throw new Error('账户不能为空');
        if (r.type === 'transfer' && !r.toAccount) throw new Error('转账缺少转入账户');
        if (r.type === 'transfer' && r.account === r.toAccount) throw new Error('转账账户与转入账户相同');

        // —— 账户解析：归一化账户名匹配已有账户；autoCreate 时按关键词推断类型 ——
        const fromId = await resolveAccount(accMap, r.account, lid, opts.autoCreate, createdAccountsSet, inferAccountType(r.account));
        let toId: number | null = null;
        if (r.type === 'transfer' && r.toAccount) {
          toId = await resolveAccount(accMap, r.toAccount, lid, opts.autoCreate, createdAccountsSet, inferAccountType(r.toAccount));
          if (toId === fromId) throw new Error('转账账户与转入账户相同');
        }

        // —— 分类解析（可选）——
        let catId: number | null = null;
        if (r.category) {
          const key = `${r.category}|${r.type}`;
          catId = catMap.get(key) ?? null;
          if (catId == null && opts.autoCreate) {
            const res = await execute(
              `INSERT INTO categories (name, type, sort_order) VALUES ($1, $2, 99)`,
              [r.category.trim(), r.type]
            );
            catId = res.lastInsertId as number;
            if (catId == null) throw new Error(`分类「${r.category}」创建失败`);
            catMap.set(key, catId);
            createdCategoriesSet.add(r.category.trim());
          }
          if (catId == null) throw new Error(`分类「${r.category}」不存在（需先创建或勾选自动创建）`);
        }

        // —— 去重拦截：订单号已在库/批内，或无订单指纹已在批内 → 判为疑似重复，跳过不重复入账
        const orderNo = String(r.orderNo ?? '').trim();
        if (orderNo && (existingOrders.has(orderNo) || batchOrders.has(orderNo))) {
          duplicates++;
          throw new Error(`疑似重复导入，已跳过（订单号 ${orderNo}）`);
        }
        if (orderNo) {
          batchOrders.add(orderNo);
        } else {
          const fp = rowFingerprint({ date, type: r.type, amount: r.amount, account: r.account, note: r.note });
          if (batchFps.has(fp)) {
            duplicates++;
            throw new Error('疑似重复导入（同日期/类型/金额/账户/备注），已跳过');
          }
          batchFps.add(fp);
        }

        const now = new Date().toISOString();
        const ins = await execute(
          `INSERT INTO transactions
            (type, amount, category_id, account_id, to_account_id, loan_id, date, note,
             pay_time, pay_method, payee, order_no, merchant_order_no,
             created_at, updated_at, ledger_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [r.type, r.amount, catId, fromId, toId, null, date, r.note ?? '',
           r.payTime ?? null, r.payMethod ?? null, r.payee ?? null,
           r.orderNo ?? null, r.merchantOrderNo ?? null,
           now, now, lid]
        );
        // 记录落库引用：供「导入后待核对」按行定位库中交易并修正（可疑行带 pending 原因）
        importedRows.push({
          rowKey: rowKeyOf(r), line: r.line, id: ins.lastInsertId as number,
          accountId: fromId, toAccountId: toId, pending: r._pending,
        });
        successful++;
      } catch (e) {
        skipped.push({ line: r.line, reason: (e as Error).message });
      }
    }

    // 转出/转入账户可能改变，但余额中性导入不需要同步虚拟账户（借贷不导入）
    return {
      imported: successful,
      skipped,
      duplicates,
      createdAccounts: [...createdAccountsSet],
      createdCategories: [...createdCategoriesSet],
      importedRows,
    };
  });
}

async function resolveAccount(
  accMap: Map<string, number>,
  name: string,
  lid: number,
  autoCreate: boolean,
  createdSet: Set<string>,
  type: string = 'cash'
): Promise<number> {
  const key = String(name ?? '').trim();
  const existing = accMap.get(key);
  if (existing != null) return existing;
  // 精确未命中时，优先并入「同义/包含」的已有账户（去掉尾号/后缀后可归并），避免重复创建
  const similar = findSimilarAccountId(accMap, key);
  if (similar != null) return similar;
  if (!autoCreate) {
    // 兼容：小写/非精确也可能错配，这里严格不匹配则抛错
    const any = accMap.get(key);
    if (any == null) throw new Error(`账户「${key}」不存在（需先创建或勾选自动创建）`);
    return any;
  }
  // 创建前先按「同账本 + 精确名称」回查库：即便 accMap 因账本/连接切换而未命中，
  // 只要该名称账户已存在于当前账本，就直接复用，绝不重复创建（解决「账户已存在却报创建失败」的误判）。
  const [dup] = await select<{ id: number }>(
    `SELECT id FROM accounts WHERE ledger_id = $1 AND name = $2`, [lid, key]
  );
  if (dup) { accMap.set(key, dup.id); return dup.id; }
  // 类型加固：账户名含信用语义关键词时强制为信用卡，避免带花呗/白条/信用卡字样的账户被误建为实体账户
  const finalType = enforceAccountType(key, type);
  const res = await execute(
    `INSERT INTO accounts (name, type, balance, initial_balance, icon, color, ledger_id) VALUES ($1,$2,0,0,'💵','#6B7280',$3)`,
    [key, finalType, lid]
  );
  // lastInsertId 兜底：个别驱动/连接下 execute 可能取不到自增 id，改为按 (账本, 名称) 回查账户 id。
  // 查到即复用；确实查不到（写入未生效）才报「写入失败」，避免把「已存在」误报成「创建失败」。
  let id = res.lastInsertId as number | undefined;
  if (id == null) {
    const [back] = await select<{ id: number }>(
      `SELECT id FROM accounts WHERE ledger_id = $1 AND name = $2`, [lid, key]
    );
    id = back?.id;
  }
  if (id == null) throw new Error(`账户「${key}」写入失败（未取得账户记录）`);
  accMap.set(key, id);
  createdSet.add(key);
  return id;
}

/**
 * 账户是否"确信同户"：归一化（保留尾号 + 同义词）后**完全相等**才算同一账户。
 * 用于导入时复用已有账户；不同卡（尾号不同）绝不会误并。
 * 例：`招商银行卡(1055)` 与 `招商银行卡(1055)`→同卡；`(1055)` 与 `(6222)`→不同卡；
 *     `支付宝账户` 与 `支付宝`→同义命中。
 */
export function accountsMatch(a: unknown, b: unknown): boolean {
  const na = normalizeAccountName(a);
  const nb = normalizeAccountName(b);
  if (!na || !nb) return false;
  return na === nb;
}

/** 在已有账户映射中查找第一个「归一化精确相等」账户的 id；没有则返回 null。 */
function findSimilarAccountId(accMap: Map<string, number>, name: string): number | null {
  for (const [existing, id] of accMap) {
    if (accountsMatch(existing, name)) return id;
  }
  return null;
}

// ==================== 支付宝 / 微信支付 真实账单适配 ====================
// 目标：让用户可直接导入支付宝导出的 CSV、微信支付账单 xlsx 等真实流水，
// 与其自定模板不同，这些账单表头前有若干说明行、并采用「收/支」列判定收支方向。
// 以下均为纯函数，便于单测。

/** 同义账户别名组：把常见不同名归并为同一规范账户名，避免重复创建。
 *  组内任一关键词出现在支付方式中即归入该规范名。 */
const ALIAS_GROUPS: Array<[string, string[]]> = [
  ['支付宝', ['支付宝账户', '支付宝余额', '支付宝钱包', '支付宝']], // 含 余额宝(余额) 不并，保留原名
  ['微信', ['微信零钱通', '零钱通', '零钱', '微信钱包', '微信']],
  ['花呗', ['花呗']],
  ['白条', ['白条']],
  // 「账户余额」及其括注/前后缀变体归并为同一账户，避免同一资金源被拆成多个账户
  ['账户余额', ['账户余额']],
];

/**
 * 账户名归一化：**保留括注尾号**（尾号是"卡标识"，用于区分同银行的不同卡），仅去除「&促销」后缀，
 * 并对明确同义词（支付宝/微信/花呗/白条）归一。
 * 例：`招商银行卡(1055)`→`招商银行卡(1055)`；`招商银行卡(6222)`→`招商银行卡(6222)`（两卡分开）；
 *     `支付宝余额`→`支付宝`；`零钱`→`微信`；`花呗分期(24期)`→`花呗`。
 */
export function normalizeAccountName(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 仅去除「&促销」后缀、保留括注尾号
  const origBase = s.split('&')[0].trim();
  // 纯符号/无实质内容（如微信中性交易的 "/"）不作为账户名
  if (!origBase || /^[\/。.、\-—_,]*$/.test(origBase)) return '';
  const low = origBase.toLowerCase();
  for (const [canon, keys] of ALIAS_GROUPS) {
    if (keys.some((k) => low.includes(k))) return canon;
  }
  return origBase;
}

/** 按账户名关键词推断帐户类型（供自动创建使用）。
 *  对应关系：储蓄/银行→银行卡；花呗/信用/白条/信用卡→信用卡；零钱/余额/支付宝/微信→电子钱包；其余→现金。 */
export function inferAccountType(name: string): 'cash' | 'bank' | 'ewallet' | 'credit' {
  const s = String(name ?? '');
  if (/花呗|信用|白条|信用卡/.test(s)) return 'credit';
  if (/储蓄|银行|农信|村镇|农商/.test(s)) return 'bank';
  if (/零钱|余额|支付宝|钱包|微信|财付通/.test(s)) return 'ewallet';
  return 'cash';
}

/** 类型加固：账户名含信用语义关键词（花呗/信用/白条/信用卡）时，强制返回 `credit`，否则退回推断类型。
 *  用于自动创建账户时的最终定档，避免含信用字样的账户被误建为现金等实体账户、破坏负余额语义。 */
export function enforceAccountType(name: string, fallback: string): string {
  const s = String(name ?? '');
  if (/信用|信用卡|花呗|白条/.test(s)) return 'credit';
  return fallback;
}

/** 账户名是否「信用（负债）」语义：花呗/白条/信用卡类账户余额为负即负债。 */
export function isCreditAccountName(name: unknown): boolean {
  return /花呗|白条|信用/.test(String(name ?? ''));
}

/**
 * 从账单文本（商品说明 / 交易对方 / 交易分类）中识别信用账户名。
 * 优先级：花呗 → 白条 → 「XX银行信用卡」全名 → 泛化「信用卡」；识别不到返回空串。
 * 例：`花呗主动还款-2026年09月账单` → `花呗`；`信用卡还款-招商银行` → `信用卡`。
 * 注意：花呗与白条各自独立账户，绝不互相归并（两者负债不可混同）。
 */
export function detectCreditAccount(text: unknown): string {
  const s = String(text ?? '');
  if (/花呗/.test(s)) return '花呗';
  if (/白条/.test(s)) return '白条';
  const m = /([\u4e00-\u9fa5]{2,10}(?:银行)?信用卡)/.exec(s);
  if (m) return m[1];
  if (/信用卡/.test(s)) return '信用卡';
  return '';
}

/**
 * 从账单文本中提取提现「服务费」金额——手续费是真实成本，必须单独记支出，不能被整体忽略。
 * 兼容 `服务费¥0.11`、`服务费: 0.11`、`服务费0.11`、`服务费 0.11 元` 等写法。
 */
export function extractServiceFee(text: unknown): number {
  const m = /服务费[^\d]{0,6}(\d+(?:\.\d+)?)/.exec(String(text ?? ''));
  const v = m ? parseFloat(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 行唯一标识：同一账单行可能派生多行（如提现「本金 + 服务费」），用 _rowKey 区分，避免预览里互相覆盖。 */
export function rowKeyOf(r: ImportRow): string {
  return r._rowKey ?? String(r.line);
}

/** Excel 日期序列号（1900 日期系统）→ `YYYY-MM-DD`；仅接受合理区间，避免误判普通数字。 */
function excelSerialToDate(n: number): string {
  if (!(n > 20000 && n < 80000)) return '';
  const ms = Math.round((n - 25569) * 86400000); // 25569 = 1970-01-01 对应的 Excel 序列号
  return dayjs(ms).format('YYYY-MM-DD');
}

/**
 * 账单日期解析：兼容 `2026/9/13`、`2026-09-13`、`20260913`，
 * 以及部分平台把时间存成 Excel 日期序列号（如微信账单 `46084.38`）的情况。
 */
export function parseBillDate(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 月/日补零：支付宝账单形如 `2026/9/13 17:36`，不补零会得到 `2026-9-13`，
  // 非 ISO 格式在不同运行时的 Date 解析行为不一致，必须规范为 `YYYY-MM-DD`。
  const slash = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (slash) return `${slash[1]}-${slash[2].padStart(2, '0')}-${slash[3].padStart(2, '0')}`;
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const n = Number(s);
  if (Number.isFinite(n)) return excelSerialToDate(n);
  return '';
}

/** 别名匹配列下标（容错）：先归一化（去空白/全角/斜杠、转小写）后，表头命中（等于或包含）别名。
 *  例：表头「 金额(元) 」能命中别名「金额」；「收/支」能命中「收支」。
 *  注意：只允许"表头包含别名"单方向，禁止反向 substring——否则别名「收支类型」会误匹配仅写「类型」的列，
 *  导致"非账单模板"被误判为账单（含收支方向列）。 */
function billColIndex(row: string[], aliases: string[]): number {
  return row.findIndex((h) => {
    if (h == null) return false;
    const nh = normalizeHeader(h);
    if (!nh) return false;
    return aliases.some((a) => {
      const na = normalizeHeader(a);
      return nh === na || nh.includes(na);
    });
  });
}

/** 表头/列值归一化：去空白、去斜杠（收/支→收支）、转小写、括号半角化。 */
function normalizeHeader(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/[\s\u3000\/／]/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')');
}

/**
 * 查找「账单格式」的表头行：需同时含「交易金额」与「收/支」与「金额」列。
 * 支付宝/微信账单的前若干行为说明/统计，真正的表头行满足该特征。
 * 列为名别名做了扩展，以兼容招商/云闪付/京东/美团/建行等常见平台的字段命名。
 * @returns 表头所在行号 + 各字段列索引；找不到返回 null
 */
function findBillHeader(aoa: string[][]): { headerIdx: number; cols: Record<string, number> } | null {
  const timeAliases = ['交易时间', '交易日期', '记账时间', '记账日期', '时间', '日期'];
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i];
    const time = billColIndex(row, timeAliases);
    if (time === -1) continue;
    const io = billColIndex(row, [
      '收/支', '收入/支出', '收支', '收支类型', '借贷标志', '借贷方向', '收付标志',
    ]);
    const amt = billColIndex(row, ['金额', '金额(元)', '金额（元）', '交易金额', '收入金额', '支出金额']);
    if (io === -1 || amt === -1) continue;
    return {
      headerIdx: i,
      cols: {
        time,
        date: billColIndex(row, ['记账日期', '交易日期', '记账时间', '日期']),
        io, amt,
        type: billColIndex(row, ['交易类型', '交易分类', '商品分类', '分类']),
        peer: billColIndex(row, ['交易对方', '对方户名', '商户名称', '商家名称', '收款方', '交易对方名称', '对方账户']),
        goods: billColIndex(row, ['商品', '商品说明', '商品名称', '物品', '用途']),
        channel: billColIndex(row, ['支付方式', '收/付款方式', '付款方式', '付款账户', '扣款账户', '出账账户', '资金来源', '资金渠道', '收付款方式', '账户名称']),
        status: billColIndex(row, ['当前状态', '交易状态', '状态', '交易状态查询']),
        orderNo: billColIndex(row, ['交易单号', '交易订单号', '订单号', '流水号', '交易号', '流水']),
        merchantNo: billColIndex(row, ['商户单号', '商家订单号', '商户订单号', '专柜单号']),
        note: billColIndex(row, ['备注', '摘要', '描述', '附言']),
      },
    };
  }
  return null;
}

/**
 * 解析支付宝/微信真实账单二维数组为 ImportRow。
 * - 「收/支」列判定：收入→income、支出→expense；「不计收支/中性交易」默认跳过；
 * - 「支付方式/收付款方式」作为账户名（可自动匹配/创建），同时写入 payMethod；
 * - 「交易对方」写入 payee，「商品/商品说明」+「备注」合成 note，
 *   「交易单号/订单号」「商户单号」分别写入 orderNo / merchantOrderNo；
 * - 「状态」为关闭/失败/未支付等未成功交易跳过。
 * @param rules 用户自定义资金流向规则（优先级最高，命中即按其判定类型/账户/分类）
 * @returns detected=false 表示非账单格式（应由自定义模板解析兜底）
 */
export function parseBillAOA(aoa: unknown[][], rules: ImportRule[] = []): { rows: ImportRow[]; skippedRows: ImportRow[]; skipped: string[]; detected: boolean } {
  const M = aoa.map((r) => (r as unknown[]).map((c) => String(c ?? '').trim()));
  const head = findBillHeader(M);
  if (!head) return { rows: [], skippedRows: [], skipped: [], detected: false };
  const { headerIdx, cols } = head;
  const rows: ImportRow[] = [];
  const skippedRows: ImportRow[] = [];
  const skipped: string[] = [];
  const get = (r: string[]) => (i: number) => (i >= 0 ? r[i] ?? '' : '');
  // 公共解析（金额/日期/账户/分类/备注等），供成功与跳过行共用
  const parseCommon = (row: string[], lineNo: number): Omit<ImportRow, 'type'> => {
    const v = get(row);
    const amount = Math.abs(parseFloat(String(v(cols.amt)).replace(/[,，元\s]/g, '')) || 0);
    const time = v(cols.time);
    const date = (cols.date >= 0 ? parseBillDate(v(cols.date)) || parseBillDate(time) : parseBillDate(time)) || '';
    const channel = v(cols.channel) || '';
    return {
      line: lineNo,
      amount,
      date,
      account: normalizeAccountName(channel) || '未识别账户',
      category: v(cols.type) || undefined,
      note: [v(cols.goods), v(cols.note)].filter(Boolean).join(' ') || undefined,
      payTime: time || undefined,
      payMethod: channel || undefined,
      payee: v(cols.peer) || undefined,
      orderNo: v(cols.orderNo) || undefined,
      merchantOrderNo: v(cols.merchantNo) || undefined,
    };
  };

  for (let r = headerIdx + 1; r < M.length; r++) {
    const row = M[r];
    if (!row || row.every((c) => !c)) continue;
    const v = get(row);
    const io = v(cols.io);
    // 收支方向：支付宝「不计收支」、微信「中性交易」及中性占位 "/" 均非真实收支
    const neutral = /不计|中性/.test(io) || /^\s*\/\s*$/.test(io);
    const typeText = v(cols.type);
    const goodsText = v(cols.goods);
    const statusText = v(cols.status);
    const lineNo = r + 1;
    const common = parseCommon(row, lineNo);

    // —— ⓪ 用户自定义资金流向规则（优先级最高）——
    // 命中关键词即按其判定：可强制把中性/未识别行归入某类型、指定账户与分类。
    // 规则可控且可解释，用户无需每次手工纠正同一类消费（如「停车费 → 支出/交通」）。
    const rowText = [goodsText, typeText, v(cols.peer), v(cols.channel), v(cols.note)].filter(Boolean).join(' ');
    const ruleHit = matchImportRule(rowText, rules);
    if (ruleHit) {
      const ruleAcc = ruleHit.account ? (normalizeAccountName(ruleHit.account) || ruleHit.account) : common.account;
      const ruleTo = ruleHit.toAccount ? (normalizeAccountName(ruleHit.toAccount) || ruleHit.toAccount) : '';
      rows.push({
        ...common,
        type: ruleHit.type,
        account: ruleAcc,
        toAccount: ruleHit.type === 'transfer' ? (ruleTo || undefined) : undefined,
        category: ruleHit.category || common.category,
        _pending: undefined,
        // 依据：明确指出命中哪条规则（可解释，用户可据此修正或删除规则）
        basis: `命中自定义规则「${ruleHit.match}」→ ${IMPORT_TYPE_LABEL[ruleHit.type] ?? ruleHit.type}`,
      });
      continue;
    }

    // —— ① 信用账户还款（花呗 / 白条 / 信用卡）——
    // 账单把还款记为「不计收支」，但其真实资金流向是「储蓄卡 → 信用账户」。
    // 必须记成转账（清偿负债）：否则负债永远清不掉，消费还会被当成支出重复统计。
    if (/还款|信用借还/.test(goodsText + typeText)) {
      const creditAccount = detectCreditAccount(`${goodsText} ${v(cols.peer)} ${typeText}`);
      const fromAccount = common.account;
      const ready = !!creditAccount && !!fromAccount && fromAccount !== '未识别账户';
      rows.push({
        ...common,
        type: 'transfer',
        account: fromAccount || '未识别账户',
        toAccount: creditAccount,
        // 来源卡或信用账户识别不出时不臆测，标待确认由用户补全
        _pending: ready ? undefined : (!creditAccount ? '还款目标信用账户待确认' : '还款来源账户待确认'),
        // 依据：账单把还款记为「不计收支」，但其真实资金流向是 储蓄卡→信用账户（清偿负债）
        basis: '账单识别「还款 / 信用借还」→ 转账（来源卡 → 信用账户）',
      });
      continue;
    }

    // —— ② 退款 ——
    // 账单「收/付款方式」列给出退款到账渠道：回储蓄卡/余额 → 资金真实流入（income）；
    // 回花呗/白条/信用卡 → 负债减少（repay_in，系统统计只认 income/expense，不会被误算成收入）。
    // 但账单不能 100% 保证真实到账账户，故一律标「待确认」，由用户核对后再导入。
    if ((/退款/.test(goodsText) || /退款/.test(typeText)) && (/退款/.test(statusText) || neutral)) {
      const rawChannel = v(cols.channel);
      const dest = normalizeAccountName(rawChannel);
      const isCredit = isCreditAccountName(dest) || isCreditAccountName(rawChannel);
      rows.push({
        ...common,
        type: isCredit ? 'repay_in' : 'income',
        account: dest || '未识别账户',
        category: typeText || '退款',
        _pending: '退款去向待确认',
        // 依据：退款回信用账户是负债减少（不计收入）；回储蓄卡/余额才是真实收入
        basis: isCredit ? '账单识别「退款」→ 负债减少（回信用账户，不计收入）' : '账单识别「退款」→ 收入（回原付款渠道）',
      });
      continue;
    }

    // —— ③ 提现（零钱 / 余额 → 银行卡）——
    // 本金是账户间平移（转账，不计收支）；服务费是真实成本，单独记一笔支出，避免手续费被整体忽略。
    if (/提现/.test(typeText + goodsText)) {
      // 两个平台的列语义不同：
      // 微信「零钱提现」的支付方式列给的是**到账银行卡**（来源固定是微信零钱）；
      // 支付宝「提现」的收/付款方式列给的是**来源**（余额），到账银行只能从交易对方列看到机构名。
      const channelText = v(cols.channel);
      const isWechatWithdraw = /零钱/.test(typeText + goodsText);
      const rawFrom = isWechatWithdraw ? '微信' : normalizeAccountName(channelText);
      const fromAccount = rawFrom === '余额' ? '账户余额' : rawFrom || '未识别账户';
      const toAccount = isWechatWithdraw ? normalizeAccountName(channelText) : '';
      rows.push({
        ...common,
        type: 'transfer',
        account: fromAccount,
        toAccount,
        // 到账卡不可确定时才标待确认（微信账单已明示到账卡，无需打扰用户）
        _pending: toAccount ? undefined : '提现到账账户待确认',
        // 依据：提现本金是账户间平移（转账），不计收支；服务费单独记支出
        basis: '账单识别「提现」→ 转账（账户 → 银行卡）',
      });
      // 服务费可能落在备注 / 商品说明 / 金额括号里，故在整行文本中检索
      const fee = extractServiceFee(row.join(' '));
      if (fee > 0) {
        rows.push({
          ...common,
          _rowKey: `${lineNo}:fee`,
          type: 'expense',
          amount: fee,
          category: '手续费',
          note: [common.note, '提现服务费'].filter(Boolean).join(' '),
          basis: '账单识别「提现」→ 服务费单独记支出（手续费）',
        });
      }
      continue;
    }

    let type: 'income' | 'expense' | null = null;
    if (!neutral && /收入|收款|入账|存入|转入|到账/.test(io)) type = 'income';
    else if (!neutral && /支出|付款|消费|转出|汇款/.test(io)) type = 'expense';
    if (!type) {
      const reason = `收支方向为「${io || '空'}」`;
      skipped.push(`第${lineNo}行：${reason}，已跳过`);
      skippedRows.push({ ...common, type: 'expense', _skippedReason: reason });
      continue;
    }

    if (!(common.amount > 0)) {
      const reason = '金额为 0 或无效';
      skipped.push(`第${lineNo}行：${reason}，已跳过`);
      skippedRows.push({ ...common, type: 'expense', _skippedReason: reason });
      continue;
    }

    if (/关闭|失败|未支付|未付款|无效/.test(statusText)) {
      const reason = `状态「${statusText}」未成功`;
      skipped.push(`第${lineNo}行：${reason}，已跳过`);
      skippedRows.push({ ...common, type: 'expense', _skippedReason: reason });
      continue;
    }

    rows.push({
      ...common,
      type,
      // 依据：按「收/支」方向列判断普通收支（未命中还款/退款/提现/自定义规则）
      basis: `账单识别收支方向「${io}」→ ${IMPORT_TYPE_LABEL[type]}`,
    });
  }
  return { rows, skippedRows, skipped, detected: true };
}

// ==================== 导入列映射预览（通用表格/自定义模板） ====================
// 目的：当表格不是支付宝/微信等"自动识别"的账单格式时，用户可手动指定"哪个表头列对应该业务字段"，
// 再按映射解析成 ImportRow。以下均为纯函数，便于单测。

/** 可被用户映射的业务字段（不含自动化字段类型推导） */
export type ImportFieldKey =
  | 'date' | 'type' | 'amount' | 'account' | 'toAccount' | 'category' | 'note'
  | 'payTime' | 'payMethod' | 'payee' | 'orderNo' | 'merchantOrderNo';

export type ColumnMap = Partial<Record<ImportFieldKey, number>>;

/** 各业务字段的表头别名（供自动推断默认映射） */
export const IMPORT_FIELD_ALIASES: Record<ImportFieldKey, string[]> = {
  date: ['日期', '交易日期', '记账日期', '交易时间', '记账时间', 'date', '时间'],
  payTime: ['支付时间', '付款时间', 'pay_time'],
  type: ['类型', '收支', '收/支', '收入/支出', '收支类型', '借贷标志', '方向', '类别', 'type'],
  amount: ['金额', '交易金额', '金额(元)', '收入金额', '支出金额', 'amount'],
  account: ['账户', '账户名称', '付款账户', '扣款账户', '收入账户', 'account'],
  toAccount: ['转入账户', '转至账户', '目标账户', '收账账户', '入账账户', 'to_account', '到账账户'],
  payee: ['收款方', '收款方全称', '交易对方', '商户名称', '商家名称', '对方户名', '对方账户', 'payee'],
  orderNo: ['订单号', '交易单号', '交易订单号', '流水号', 'order_no'],
  merchantOrderNo: ['商家订单号', '商户单号', '商户订单号', 'merchant_order_no'],
  payMethod: ['付款方式', '支付方式', '收/付款方式', '收付款方式', 'pay_method', '资金来源'],
  category: ['分类', '交易分类', '交易类型', '商品分类', 'category'],
  note: ['备注', '说明', '描述', '摘要', '附言', 'note'],
};

/** 字段名 → 展示标签（供 UI 下拉） */
export const IMPORT_FIELD_LABELS: Record<ImportFieldKey, string> = {
  date: '日期', type: '类型', amount: '金额', account: '账户', toAccount: '转入账户',
  category: '分类', note: '备注', payTime: '支付时间', payMethod: '付款方式',
  payee: '收款方', orderNo: '订单号', merchantOrderNo: '商家订单号',
};

/** 字段优先顺序：越靠前越先"认领"表头列（避免同一列被多字段抢占） */
const FIELD_PRIORITY: ImportFieldKey[] = [
  'date', 'payTime', 'type', 'amount', 'account', 'toAccount', 'payee',
  'orderNo', 'merchantOrderNo', 'payMethod', 'category', 'note',
];

/**
 * 根据表头自动推断「业务字段 → 表头列索引」的映射（贪心：每个字段认领首个未被占用的匹配列）。
 * 供列映射预览的默认值；用户可在 UI 调整后回传自定义映射。
 */
export function buildColumnMap(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<number>();
  for (const field of FIELD_PRIORITY) {
    const idx = billColIndex(header, IMPORT_FIELD_ALIASES[field]);
    if (idx >= 0 && !used.has(idx)) { map[field] = idx; used.add(idx); }
  }
  return map;
}

/** raw 列值 → 交易方向/类型；无法识别返回 null */
export function parseTxType(raw: string): ImportTxType | null {
  const t = String(raw ?? '').trim().toLowerCase();
  if (/不计|中性/.test(t)) return null;
  if (/收入|收款|入账|存入|到账|income|\+/i.test(t)) return 'income';
  if (/支出|付款|消费|转出|汇款|expense|purchase/i.test(t)) return 'expense';
  if (/转账|转帐|转入|转出中转|transfer/i.test(t)) return 'transfer';
  // 负债减少（还款/退款回信用账户）：与导入类型下拉的「负债减少」选项对齐，模板中可直接使用
  if (/负债减少|还款|repay_in/i.test(t)) return 'repay_in';
  return null;
}

/**
 * 按用户指定的列映射解析表格数据行为 ImportRow。
 * @param aoa     原始二维数组
 * @param header  表头行内容（用于定位数据起始行：headerIdx 之后为数据行）
 * @param map     业务字段 → 表头列索引；缺省/为负表示不映射该字段
 * @param headerIdx 表头所在行（默认 0）；其后的行视为数据
 * @param rules   用户自定义资金流向规则（优先级最高，与账单路径 parseBillAOA 口径一致）
 */
export function parseAoaWithMap(
  aoa: unknown[][],
  map: ColumnMap,
  headerIdx = 0,
  rules: ImportRule[] = []
): { rows: ImportRow[]; skipped: string[] } {
  const rows: ImportRow[] = [];
  const skipped: string[] = [];
  const at = (row: unknown[], key: ImportFieldKey) => {
    const i = map[key];
    return i != null && i >= 0 && i < row.length ? String(row[i] ?? '').trim() : '';
  };
  for (let r = headerIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] as unknown[];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
    const line = r + 1;
    // 金额必填且 >0
    const amtStr = at(row, 'amount').replace(/[,，元¥￥\s]/g, '');
    const amount = parseFloat(amtStr) || 0;
    if (!(amount > 0)) { skipped.push(`第${line}行：金额为 0 或无效，已跳过`); continue; }
    const rawType = at(row, 'type');
    const type = parseTxType(rawType);
    if (!type) { skipped.push(`第${line}行：类型「${rawType || '空'}」无法识别，已跳过`); continue; }
    const date = parseBillDate(at(row, 'date'));
    const account = at(row, 'account');
    // —— 用户自定义资金流向规则（优先级最高）——
    // 与账单路径口径一致：命中关键词即按其判定类型/账户/转入账户/分类，
    // 可把模板里未显式指明或识别不准的流水固定归到某类型，避免每次导入都要手工纠正。
    const rowText = [at(row, 'payee'), at(row, 'note'), at(row, 'category'), rawType, account].filter(Boolean).join(' ');
    const ruleHit = matchImportRule(rowText, rules);
    let typeF: ImportTxType = type;
    let accountF = account;
    let toAccountF = at(row, 'toAccount') || undefined;
    let categoryF = at(row, 'category') || undefined;
    let basis: string | undefined;
    if (ruleHit) {
      typeF = ruleHit.type;
      accountF = ruleHit.account ? (normalizeAccountName(ruleHit.account) || ruleHit.account) : accountF;
      toAccountF = ruleHit.type === 'transfer'
        ? (ruleHit.toAccount ? (normalizeAccountName(ruleHit.toAccount) || ruleHit.toAccount) : toAccountF)
        : undefined;
      categoryF = ruleHit.category || categoryF;
      basis = `命中自定义规则「${ruleHit.match}」→ ${IMPORT_TYPE_LABEL[ruleHit.type] ?? ruleHit.type}`;
    }
    if (!accountF && typeF !== 'transfer') { skipped.push(`第${line}行：缺少账户，已跳过`); continue; }
    rows.push({
      line,
      type: typeF,
      amount,
      date,
      account: accountF,
      toAccount: toAccountF,
      category: categoryF,
      note: at(row, 'note') || undefined,
      payTime: at(row, 'payTime') || undefined,
      payMethod: at(row, 'payMethod') || undefined,
      payee: at(row, 'payee') || undefined,
      orderNo: at(row, 'orderNo') || undefined,
      merchantOrderNo: at(row, 'merchantOrderNo') || undefined,
      ...(basis ? { basis } : {}),
    });
  }
  return { rows, skipped };
}

/** 标准 CSV 文本 → 二维数组（处理双引号转义与跨行字段） */
export function parseCsvText(text: string): unknown[][] {
  const rows: unknown[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}