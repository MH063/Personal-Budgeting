import dayjs from 'dayjs';
import { execute } from './db';
import { listCategories } from './categories';
import { listAccounts } from './accounts';
import { currentLedgerId } from '@/lib/ledger';

/**
 * 一键填充测试数据（余额中性）
 * ---------------------------------------------------------------
 * 在桌面（Tauri）环境向 transactions 直接 INSERT 一组近 3 个月的真实感交易，
 * 供财务问答/预测/订阅/异常/洞察等读取型功能有数据可测。
 * - 不走 createTransaction（避免余额校验/虚拟账户），保持余额中性，只测读取链路。
 * - 幂等：先清旧 seed（note 以 `seed:` 前缀），再插入。
 * - 浏览器预览（非 Tauri）数据库不可达，返回 -1 表示未写入，由调用方提示。
 */

interface SeedRow {
  type: string; amount: number; categoryName?: string; accountName: string;
  toAccountName?: string; dateDaysAgo: number; note: string; timeMin?: number;
  payMethod?: string; payee?: string; orderNo?: string; merchantOrderNo?: string;
}

const ROWS: SeedRow[] = [
  // 支出·餐饮
  { type: 'expense', amount: 32.5, categoryName: '餐饮', accountName: '支付宝', dateDaysAgo: 70, note: 'seed:午餐 麦当劳', timeMin: 8, payMethod: '支付宝', payee: '麦当劳', orderNo: 'ORDER-1-001', merchantOrderNo: 'M1-001' },
  { type: 'expense', amount: 28, categoryName: '餐饮', accountName: '微信', dateDaysAgo: 60, note: 'seed:午餐 星巴克', timeMin: 12, payMethod: '微信支付', payee: 'Starbucks', orderNo: 'ORDER-1-002', merchantOrderNo: 'M1-002' },
  { type: 'expense', amount: 88, categoryName: '餐饮', accountName: '支付宝', dateDaysAgo: 45, note: 'seed:晚餐 火锅', timeMin: 18, payMethod: '支付宝', payee: '海底捞火锅', orderNo: 'ORDER-1-003', merchantOrderNo: 'M1-003' },
  { type: 'expense', amount: 16.5, categoryName: '餐饮', accountName: '微信', dateDaysAgo: 30, note: 'seed:午餐 麦当劳', timeMin: 9, payMethod: '微信支付', payee: '麦当劳', orderNo: 'ORDER-1-004', merchantOrderNo: 'M1-004' },
  // 支出·交通
  { type: 'expense', amount: 4, categoryName: '交通', accountName: '微信', dateDaysAgo: 62, note: 'seed:地铁通勤', timeMin: 40, payMethod: '微信支付', payee: '地铁', orderNo: 'ORDER-2-001', merchantOrderNo: 'M2-001' },
  { type: 'expense', amount: 4, categoryName: '交通', accountName: '微信', dateDaysAgo: 32, note: 'seed:地铁通勤', timeMin: 41, payMethod: '微信支付', payee: '地铁', orderNo: 'ORDER-2-002', merchantOrderNo: 'M2-002' },
  { type: 'expense', amount: 100, categoryName: '交通', accountName: '支付宝', dateDaysAgo: 10, note: 'seed:加油', timeMin: 50, payMethod: '支付宝', payee: '中石化', orderNo: 'ORDER-2-003', merchantOrderNo: 'M2-003' },
  // 支出·订阅（重复扣费 + 涨价）
  { type: 'expense', amount: 15, categoryName: '娱乐', accountName: '微信', dateDaysAgo: 75, note: 'seed:视频会员', timeMin: 10, payMethod: '微信支付', payee: '某视频会员', orderNo: 'ORDER-3-001', merchantOrderNo: 'M3-001' },
  { type: 'expense', amount: 15, categoryName: '娱乐', accountName: '微信', dateDaysAgo: 45, note: 'seed:视频会员', timeMin: 10, payMethod: '微信支付', payee: '某视频会员', orderNo: 'ORDER-3-002', merchantOrderNo: 'M3-002' },
  { type: 'expense', amount: 25, categoryName: '娱乐', accountName: '微信', dateDaysAgo: 15, note: 'seed:视频会员（涨价）', timeMin: 10, payMethod: '微信支付', payee: '某视频会员', orderNo: 'ORDER-3-003', merchantOrderNo: 'M3-003' },
  { type: 'expense', amount: 30, categoryName: '娱乐', accountName: '支付宝', dateDaysAgo: 60, note: 'seed:云盘会员', timeMin: 15, payMethod: '支付宝', payee: '某云盘超级会员', orderNo: 'ORDER-4-001', merchantOrderNo: 'M4-001' },
  { type: 'expense', amount: 30, categoryName: '娱乐', accountName: '支付宝', dateDaysAgo: 30, note: 'seed:云盘会员', timeMin: 15, payMethod: '支付宝', payee: '某云盘超级会员', orderNo: 'ORDER-4-002', merchantOrderNo: 'M4-002' },
  // 支出·居住（房租 + 水电）
  { type: 'expense', amount: 3200, categoryName: '居住', accountName: '银行卡', dateDaysAgo: 70, note: 'seed:房租', timeMin: 5, payMethod: '银行卡', payee: '房租·王房东', orderNo: 'ORDER-5-001', merchantOrderNo: 'M5-001' },
  { type: 'expense', amount: 3200, categoryName: '居住', accountName: '银行卡', dateDaysAgo: 40, note: 'seed:房租', timeMin: 5, payMethod: '银行卡', payee: '房租·王房东', orderNo: 'ORDER-5-002', merchantOrderNo: 'M5-002' },
  { type: 'expense', amount: 120, categoryName: '居住', accountName: '微信', dateDaysAgo: 33, note: 'seed:水电', timeMin: 3, payMethod: '微信支付', payee: '国网电费', orderNo: 'ORDER-5-003', merchantOrderNo: 'M5-003' },
  { type: 'expense', amount: 150, categoryName: '居住', accountName: '微信', dateDaysAgo: 12, note: 'seed:水电', timeMin: 3, payMethod: '微信支付', payee: '国网电费', orderNo: 'ORDER-5-004', merchantOrderNo: 'M5-004' },
  // 异常大额
  { type: 'expense', amount: 8800, categoryName: '购物', accountName: '信用卡', dateDaysAgo: 18, note: 'seed:疑似大额', timeMin: 25, payMethod: '信用卡', payee: '某境外网站', orderNo: 'ORDER-9-001', merchantOrderNo: 'M9-001' },
  // 收入
  { type: 'income', amount: 15000, categoryName: '工资', accountName: '银行卡', dateDaysAgo: 80, note: 'seed:工资', timeMin: 1, payMethod: '银行代发', payee: '公司', orderNo: 'PAY-1-001', merchantOrderNo: 'C1' },
  { type: 'income', amount: 15000, categoryName: '工资', accountName: '银行卡', dateDaysAgo: 50, note: 'seed:工资', timeMin: 1, payMethod: '银行代发', payee: '公司', orderNo: 'PAY-1-002', merchantOrderNo: 'C1' },
  { type: 'income', amount: 15500, categoryName: '工资', accountName: '银行卡', dateDaysAgo: 19, note: 'seed:工资', timeMin: 1, payMethod: '银行代发', payee: '公司', orderNo: 'PAY-1-003', merchantOrderNo: 'C1' },
  { type: 'income', amount: 500, categoryName: '奖金', accountName: '银行卡', dateDaysAgo: 10, note: 'seed:季度奖金', timeMin: 2, payMethod: '银行代发', payee: '公司', orderNo: 'PAY-2-001', merchantOrderNo: 'C2' },
  // 转账
  { type: 'transfer', amount: 2000, accountName: '银行卡', toAccountName: '微信', dateDaysAgo: 28, note: 'seed:转零钱', timeMin: 30, payMethod: '银行转账', orderNo: 'T-1-001' },
  // 借出
  { type: 'lend', amount: 1000, accountName: '现金', dateDaysAgo: 40, note: 'seed:借给朋友', payee: '张三' },
];

/** 在桌面库直接插入测试交易（余额中性、幂等）。非 Tauri 返回 -1，成功返回插入条数。 */
export async function seedTestData(): Promise<number> {
  const [cats, accs] = await Promise.all([listCategories(), listAccounts(false)]);
  const catId = (n?: string) => (n ? cats.find((c) => c.name === n)?.id : undefined);
  const accId = (n: string) => accs.find((a) => a.name === n)?.id;

  // 幂等：清掉旧 seed（仅当前账本，避免误删其它账本数据）
  await execute(`DELETE FROM transactions WHERE note LIKE 'seed:%' AND ledger_id = $1`, [currentLedgerId()]);

  let inserted = 0;
  for (const s of ROWS) {
    const aid = accId(s.accountName);
    if (!aid) continue;
    const date = dayjs().subtract(s.dateDaysAgo, 'day').format('YYYY-MM-DD');
    const payTime = s.timeMin ? dayjs(date).add(s.timeMin, 'minute').format('YYYY-MM-DD HH:mm:ss') : null;
    await execute(
      `INSERT INTO transactions
        (type, amount, category_id, account_id, to_account_id, loan_id, date, note,
         pay_time, pay_method, payee, order_no, merchant_order_no,
         created_at, updated_at, ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [s.type, s.amount, catId(s.categoryName) ?? null, aid,
       (s.toAccountName ? accId(s.toAccountName) : null) ?? null, null, date, s.note,
       payTime, s.payMethod ?? null, s.payee ?? null, s.orderNo ?? null, s.merchantOrderNo ?? null,
       new Date().toISOString(), new Date().toISOString(), currentLedgerId()]
    );
    inserted++;
  }
  return inserted;
}