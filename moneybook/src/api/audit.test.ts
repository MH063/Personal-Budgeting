/**
 * 审计日志模块单元测试（mock db 层）。
 * 覆盖：写入容错、分页查询的 SQL 组装与参数（source 筛选 / 关键字 / limit 夹取 / offset）、
 * 清理（全部 / N 天前）与来源文案的完整性。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— mock 数据访问层与账本（audit.ts 仅依赖 db 与 ledger）——
const execMock = vi.fn();
const selectMock = vi.fn();

vi.mock('@/api/db', () => ({
  execute: (...args: unknown[]) => execMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
}));

vi.mock('@/lib/ledger', () => ({
  currentLedgerId: () => 1,
}));

import {
  recordAudit,
  queryAuditLogs,
  purgeAuditLogs,
  AUDIT_SOURCE_LABEL,
} from '@/api/audit';

beforeEach(() => {
  execMock.mockReset();
  selectMock.mockReset();
  selectMock.mockResolvedValue([]);
  execMock.mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
});

describe('recordAudit：写入容错', () => {
  it('写入审计行（含账本与全部字段）', async () => {
    await recordAudit({ kind: 'categorize', source: 'rule', action: '归类', after: '咖啡', basis: '用户规则' });
    expect(execMock).toHaveBeenCalledTimes(1);
    const [sql, params] = execMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO ai_audit_log');
    expect(params).toEqual([1, 'categorize', 'rule', '归类', null, '咖啡', '用户规则', null]);
  });

  it('写入失败时不抛出（审计失败不影响主流程）', async () => {
    execMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      recordAudit({ kind: 'x', source: 'ai', action: 'y' })
    ).resolves.toBeUndefined();
  });
});

describe('queryAuditLogs：分页与筛选', () => {
  it('无筛选：默认 limit 50 / offset 0，参数顺序正确', async () => {
    selectMock.mockResolvedValueOnce([{ c: 2 }]).mockResolvedValueOnce([{ id: 2 }, { id: 1 }]);
    const r = await queryAuditLogs();
    const [cntSql, cntParams] = selectMock.mock.calls[0] as [string, unknown[]];
    const [rowSql, rowParams] = selectMock.mock.calls[1] as [string, unknown[]];
    expect(cntSql).toContain('COUNT(*)');
    expect(cntParams).toEqual([1]);
    expect(rowSql).toContain('ORDER BY id DESC');
    expect(rowParams).toEqual([1, 50, 0]);
    expect(r.total).toBe(2);
    expect(r.rows).toHaveLength(2);
  });

  it('source 筛选：追加 source 条件（all 视为不过滤）', async () => {
    await queryAuditLogs({ source: 'ai', limit: 10, offset: 20 });
    const [rowSql, rowParams] = selectMock.mock.calls[1] as [string, unknown[]];
    expect(rowSql).toContain('source = $2');
    expect(rowParams).toEqual([1, 'ai', 10, 20]);

    selectMock.mockClear();
    selectMock.mockResolvedValue([]);
    await queryAuditLogs({ source: 'all' });
    const [rowSql2] = selectMock.mock.calls[1] as [string, unknown[]];
    expect(rowSql2).not.toContain('source =');
  });

  it('关键字：对 动作/改前/改后/依据/方法 做 LIKE 模糊匹配', async () => {
    await queryAuditLogs({ keyword: ' 星巴克 ' });
    const [rowSql, rowParams] = selectMock.mock.calls[1] as [string, unknown[]];
    expect(rowSql).toContain('action LIKE $2');
    expect(rowSql).toContain("IFNULL(basis,'') LIKE $2");
    expect(rowParams).toEqual([1, '%星巴克%', 50, 0]);
  });

  it('limit 夹取到 1-500，offset 负数归零', async () => {
    await queryAuditLogs({ limit: 9999, offset: -5 });
    let [, rowParams] = selectMock.mock.calls[1] as [string, unknown[]];
    expect(rowParams).toEqual([1, 500, 0]);

    selectMock.mockClear();
    selectMock.mockResolvedValue([]);
    await queryAuditLogs({ limit: 0 });
    [, rowParams] = selectMock.mock.calls[1] as [string, unknown[]];
    expect(rowParams).toEqual([1, 1, 0]);
  });

  it('查询异常时返回空结果（不抛出）', async () => {
    selectMock.mockRejectedValueOnce(new Error('db error'));
    const r = await queryAuditLogs();
    expect(r).toEqual({ total: 0, rows: [] });
  });
});

describe('purgeAuditLogs：清理', () => {
  it('不传天数：清空当前账本全部记录', async () => {
    execMock.mockResolvedValueOnce({ rowsAffected: 12 });
    const n = await purgeAuditLogs();
    const [sql, params] = execMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('DELETE FROM ai_audit_log WHERE ledger_id = $1');
    expect(params).toEqual([1]);
    expect(n).toBe(12);
  });

  it('传天数：仅删除该天数前的记录（保留近期留痕）', async () => {
    execMock.mockResolvedValueOnce({ rowsAffected: 3 });
    const n = await purgeAuditLogs(90);
    const [sql, params] = execMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("created_at < datetime('now','localtime', $2)");
    expect(params).toEqual([1, '-90 days']);
    expect(n).toBe(3);
  });

  it('清理失败时返回 0（不抛出）', async () => {
    execMock.mockRejectedValueOnce(new Error('locked'));
    await expect(purgeAuditLogs()).resolves.toBe(0);
  });
});

describe('AUDIT_SOURCE_LABEL：来源文案覆盖', () => {
  it('覆盖全部 5 类来源且均为非空中文/缩写', () => {
    for (const s of ['ai', 'rule', 'local', 'import', 'user']) {
      expect(AUDIT_SOURCE_LABEL[s]).toBeTruthy();
    }
  });
});