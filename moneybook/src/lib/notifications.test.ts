/**
 * 通知中心数据组装（铃铛）单元测试。
 * 覆盖：四类提醒（逾期借贷/预算超支/回收站/存储告警）的触发与内容、
 * 多提醒叠加、全部无提醒、金额与字节格式化。
 */
import { describe, it, expect } from 'vitest';
import { buildNotices, formatBytes, formatMoney, STORAGE_WARN_PERCENT } from '@/lib/notifications';

const empty = {
  overdueCount: 0,
  overduePartyNames: [],
  overBudgets: [],
  trashCount: 0,
  dueRecurrings: [],
  storageUsage: null,
};

describe('buildNotices：逾期借贷提醒', () => {
  it('无逾期时不产生提醒', () => {
    const { notices, total } = buildNotices(empty);
    expect(total).toBe(0);
    expect(notices.some((n) => n.key === 'overdue')).toBe(false);
  });

  it('有逾期时生成 1 条 danger 提醒，跳转借贷页', () => {
    const { notices, total } = buildNotices({
      ...empty,
      overdueCount: 2,
      overduePartyNames: ['张三', '李四'],
    });
    expect(total).toBe(1);
    const n = notices[0];
    expect(n.key).toBe('overdue');
    expect(n.tone).toBe('danger');
    expect(n.to).toBe('/loans');
    expect(n.title).toContain('2 笔借贷已逾期');
    expect(n.desc).toContain('张三');
  });

  it('逾期超过 3 笔时对方名称折叠', () => {
    const { notices } = buildNotices({
      ...empty,
      overdueCount: 5,
      overduePartyNames: ['A', 'B', 'C', 'D', 'E'],
    });
    expect(notices[0].desc).toContain('等 5 笔');
    expect(notices[0].desc).not.toContain('D');
  });
});

describe('buildNotices：预算超支提醒', () => {
  it('无超支不提醒', () => {
    const { total } = buildNotices({ ...empty, overBudgets: [] });
    expect(total).toBe(0);
  });

  it('有超支时生成 warn 提醒，含分类名与超支金额', () => {
    const { notices, total } = buildNotices({
      ...empty,
      overBudgets: [
        { category_name: '餐饮', actual: 2000, usable: 1500 },
        { category_name: '购物', actual: 900, usable: 1000 },
      ],
    });
    expect(total).toBe(1);
    const n = notices[0];
    expect(n.key).toBe('budget');
    expect(n.tone).toBe('warn');
    expect(n.to).toBe('/settings?tab=budget');
    expect(n.title).toContain('2 项预算已超支');
    expect(n.desc).toContain('餐饮');
    expect(n.desc).toContain('超预算');
  });

  it('总预算（无分类名）超支时使用通用文案', () => {
    const { notices } = buildNotices({
      ...empty,
      overBudgets: [{ category_name: null, actual: 100, usable: 80 }],
    });
    expect(notices[0].desc).toContain('请到预算页查看');
  });
});

describe('buildNotices：回收站提醒', () => {
  it('回收站有记录时生成 info 提醒，跳转回收站', () => {
    const { notices, total } = buildNotices({ ...empty, trashCount: 3 });
    expect(total).toBe(1);
    const n = notices[0];
    expect(n.key).toBe('trash');
    expect(n.tone).toBe('info');
    expect(n.to).toBe('/trash');
    expect(n.title).toContain('3 条可恢复记录');
  });

  it('回收站为空时不提醒', () => {
    const { total } = buildNotices({ ...empty, trashCount: 0 });
    expect(total).toBe(0);
  });
});

describe('buildNotices：周期记账到期提醒', () => {
  it('无到期项不提醒', () => {
    const { total } = buildNotices({ ...empty, dueRecurrings: [] });
    expect(total).toBe(0);
  });

  it('有到期项时生成 info 提醒，跳转周期记账页，合计金额正确', () => {
    const { notices, total } = buildNotices({
      ...empty,
      dueRecurrings: [
        { note: '房租', amount: -3000, type: 'expense' },
        { note: '工资', amount: 15000, type: 'income' },
      ],
    });
    expect(total).toBe(1);
    const n = notices[0];
    expect(n.key).toBe('recurring');
    expect(n.tone).toBe('info');
    expect(n.to).toBe('/settings?tab=recurring');
    expect(n.title).toContain('2 项周期记账今日到期');
    expect(n.desc).toContain('18,000.00');
    expect(n.desc).toContain('房租');
  });

  it('无备注时按类型推断名称', () => {
    const { notices } = buildNotices({
      ...empty,
      dueRecurrings: [{ note: null, amount: 500, type: 'transfer' }],
    });
    expect(notices[0].desc).toContain('转账');
  });
});

describe('buildNotices：存储告警', () => {
  it('占用低于阈值不提醒（边界 74%）', () => {
    const { total } = buildNotices({
      ...empty,
      storageUsage: { percent: STORAGE_WARN_PERCENT - 1, usedBytes: 1024 * 1024, quotaBytes: 5120 * 1024 },
    });
    expect(total).toBe(0);
  });

  it('占用达到阈值（≥75%）生成 warn 提醒', () => {
    const { notices, total } = buildNotices({
      ...empty,
      storageUsage: { percent: 80, usedBytes: 4096 * 1024, quotaBytes: 5120 * 1024 },
    });
    expect(total).toBe(1);
    const n = notices[0];
    expect(n.key).toBe('storage');
    expect(n.tone).toBe('warn');
    expect(n.to).toBe('/settings?tab=backup');
    expect(n.title).toContain('80%');
    expect(n.desc).toContain('4.0 MB');
  });

  it('无配额信息时仍提醒且文案不含配额', () => {
    const { notices } = buildNotices({
      ...empty,
      storageUsage: { percent: 90, usedBytes: 1024 * 1024, quotaBytes: null },
    });
    expect(notices[0].desc).toContain('导出备份');
  });

  it('storageUsage 为 null 不提醒', () => {
    const { total } = buildNotices({ ...empty, storageUsage: null });
    expect(total).toBe(0);
  });
});

describe('buildNotices：多提醒叠加与顺序', () => {
  it('五类提醒同时存在时按 overdue→budget→recurring→trash→storage 排序', () => {
    const { notices, total } = buildNotices({
      overdueCount: 1,
      overduePartyNames: ['王五'],
      overBudgets: [{ category_name: '餐饮', actual: 10, usable: 1 }],
      dueRecurrings: [{ note: '房租', amount: -3000, type: 'expense' }],
      trashCount: 1,
      storageUsage: { percent: 90, usedBytes: 1, quotaBytes: null },
    });
    expect(total).toBe(5);
    expect(notices.map((n) => n.key)).toEqual(['overdue', 'budget', 'recurring', 'trash', 'storage']);
  });
});

describe('formatMoney / formatBytes', () => {
  it('金额格式化保留两位小数', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50');
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(-12.345)).toBe('12.35');
  });

  it('字节格式化', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});