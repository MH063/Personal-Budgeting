// 首次运行引导与样本数据
import dayjs from 'dayjs';
import { execute, runInTransaction, select } from './db';
import { createTransaction, type TxPayload } from './transactions';
import { currentLedgerId } from '@/lib/ledger';

const SEED_KEY = 'seed_done';

/** 是否已完成初始化（settings 表中 seed_done='1'） */
export async function isSeeded(): Promise<boolean> {
  const rows = await select<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1 LIMIT 1`,
    [SEED_KEY]
  );
  return rows.length > 0 && rows[0].value === '1';
}

/** 固化 seed_done 标记（幂等；防「标记丢失后样本重跑」） */
async function markSeeded(): Promise<void> {
  await execute(
    `INSERT INTO settings (key, value) VALUES ($1, '1')
     ON CONFLICT(key) DO UPDATE SET value = '1'`,
    [SEED_KEY]
  );
}

/** 001 迁移内置的默认分类名单（判断「分类是否用户自定义」的排除基准） */
const DEFAULT_CATEGORIES = [
  '餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '其他支出',
  '工资', '奖金', '兼职', '投资收益', '红包', '其他收入',
];

/**
 * 数据库里是否已存在「用户真实数据」（非内置默认/非样本）。
 * 用于防止样本数据在已有数据的库上重跑。历史缺陷：seed_done 标记一旦丢失
 * （数据库重建 / 损坏恢复 / 旧版本升级等），seedSampleData 会按需自动创建账户、
 * 补插分类、插入样本流水，造成用户反馈的「更新后账户被自动创建、分类/标签重复」。
 * 判定口径（全表维度，避免账本切换造成漏判）：
 *   - 已有任何流水（账户/标签同理：全新库经 008 迁移清理后账户为空、标签恒为空）；
 *   - 存在默认名单之外的分类（001 内置的默认分类不算用户数据）。
 */
async function hasRealUserData(): Promise<boolean> {
  const tx = await select<{ c: number }>(`SELECT COUNT(*) AS c FROM transactions`);
  if ((tx[0]?.c ?? 0) > 0) return true;
  const ac = await select<{ c: number }>(`SELECT COUNT(*) AS c FROM accounts`);
  if ((ac[0]?.c ?? 0) > 0) return true;
  const tg = await select<{ c: number }>(`SELECT COUNT(*) AS c FROM tags`);
  if ((tg[0]?.c ?? 0) > 0) return true;
  const cats = await select<{ name: string }>(`SELECT name FROM categories`);
  if (cats.some((c) => !DEFAULT_CATEGORIES.includes(c.name))) return true;
  return false;
}

/**
 * 载入样本数据（幂等 + 数据保护）。
 * 返回本次插入的流水条数；已 seed 或「库中已有用户真实数据」时返回 0。
 * 保护说明：只有确认「全新空库」才允许创建演示账户与样本流水——这是首次引导下
 * 用户主动点「载入示例数据」的有意行为；一旦发现任何用户真实使用痕迹，
 * 立即跳过并固化 seed_done，绝不重复创建账户/分类/流水（用户反馈的更新后异常即源于此）。
 */
export async function seedSampleData(): Promise<number> {
  if (await isSeeded()) return 0;
  // 已有用户真实数据：跳过样本并固化标记，杜绝「更新后账户自动创建、分类/标签重复」
  if (await hasRealUserData()) {
    await markSeeded();
    return 0;
  }

  return runInTransaction(async () => {
    // 账户：已不再内置默认账户（用户自行创建）；示例数据所需的 4 个账户缺失时按需创建，
    // 优先复用当前账本中的同名账户，避免重复创建
    const accounts = await select<{ id: number; name: string; type: string }>(
      `SELECT id, name, type FROM accounts WHERE ledger_id = $1 ORDER BY id`, [currentLedgerId()]
    );
    const byName = (name: string) => accounts.find((a) => a.name === name)?.id;
    const requiredAccounts: { name: string; type: string; icon: string; color: string }[] = [
      { name: '现金', type: 'cash', icon: '💵', color: '#10B981' },
      { name: '微信', type: 'ewallet', icon: '💬', color: '#10B981' },
      { name: '支付宝', type: 'ewallet', icon: '🅰️', color: '#3B82F6' },
      { name: '银行卡', type: 'bank', icon: '🏦', color: '#1E6FA9' },
    ];
    const accountIds = new Map<string, number>();
    for (const a of requiredAccounts) {
      let id = byName(a.name);
      if (!id) {
        const res = await execute(
          `INSERT INTO accounts (name, type, balance, initial_balance, icon, color, sort_order, ledger_id)
           VALUES ($1, $2, 0, 0, $3, $4, 99, $5)`,
          [a.name, a.type, a.icon, a.color, currentLedgerId()]
        );
        id = res.lastInsertId as number;
      }
      accountIds.set(a.name, id);
    }
    const cashId = accountIds.get('现金');
    const wechatId = accountIds.get('微信');
    const alipayId = accountIds.get('支付宝');
    const bankId = accountIds.get('银行卡');

    // 分类 id（INIT_SQL 已 seed 根分类；个别缺失则按需补插）
    async function categoryId(name: string, type: TxPayload['type']): Promise<number> {
      const rows = await select<{ id: number }>(`SELECT id FROM categories WHERE name = $1 LIMIT 1`, [name]);
      if (rows.length) return rows[0].id;
      const res = await execute(
        `INSERT INTO categories (name, type, icon, color, sort_order) VALUES ($1, $2, '📦', '#6B7280', 99)`,
        [name, type]
      );
      return res.lastInsertId as number;
    }

    // 时间：近 3 个月内的若干固定偏移（天）
    const days = [3, 6, 9, 12, 18, 24, 32, 40, 50, 63, 75, 88];
    const dateAt = (i: number) => dayjs().subtract(days[i % days.length], 'day').format('YYYY-MM-DD');

    // 待插入的样本流水（结合真实资金流动）
    const wageId = await categoryId('工资', 'income');
    const foodId = await categoryId('餐饮', 'expense');
    const trafficId = await categoryId('交通', 'expense');
    const shoppingId = await categoryId('购物', 'expense');
    const funId = await categoryId('娱乐', 'expense');

    const samples: TxPayload[] = [
      // 工资（银行卡，每月一笔）
      { type: 'income', amount: 12000, categoryId: wageId, accountId: bankId!, date: dateAt(0), note: '示范工资' },
      { type: 'income', amount: 12000, categoryId: wageId, accountId: bankId!, date: dateAt(3), note: '示范工资' },
      { type: 'income', amount: 12000, categoryId: wageId, accountId: bankId!, date: dateAt(6), note: '示范工资' },
      // 日常支出（现金/微信/支付宝 交替）
      { type: 'expense', amount: 35.5, categoryId: foodId, accountId: cashId!, date: dateAt(1), note: '示范餐饮' },
      { type: 'expense', amount: 15, categoryId: trafficId, accountId: wechatId!, date: dateAt(2), note: '示范交通' },
      { type: 'expense', amount: 299, categoryId: shoppingId, accountId: alipayId!, date: dateAt(4), note: '示范购物' },
      { type: 'expense', amount: 88, categoryId: funId, accountId: wechatId!, date: dateAt(5), note: '示范娱乐' },
      { type: 'expense', amount: 42, categoryId: foodId, accountId: alipayId!, date: dateAt(7), note: '示范餐饮' },
      { type: 'expense', amount: 50, categoryId: trafficId, accountId: alipayId!, date: dateAt(8), note: '示范交通' },
      // 转账（银行卡 → 现金/微信）
      { type: 'transfer', amount: 2000, accountId: bankId!, toAccountId: cashId!, date: dateAt(2), note: '示范转账' },
      { type: 'transfer', amount: 500, accountId: bankId!, toAccountId: wechatId!, date: dateAt(4), note: '示范转账' },
    ];

    for (const p of samples) {
      await createTransaction(p);
    }

    // 打点：标记初始化完成
    await execute(
      `INSERT INTO settings (key, value) VALUES ($1, '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
      [SEED_KEY]
    );

    return samples.length;
  });
}