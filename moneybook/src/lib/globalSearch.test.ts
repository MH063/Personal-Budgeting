/**
 * 全局搜索（命令面板）纯过滤函数单元测试。
 * 覆盖：通用关键词匹配的空词/大小写/多字段行为，以及规则、导入历史、对账记录、审计记录
 * 四路来源的命中与不命中判定；并校验中文标签映射覆盖全部取值。
 */
import { describe, it, expect } from 'vitest';
import type { UserRule } from '@/api/merchantNorm';
import type { ImportRule } from '@/api/import';
import type { ImportLog } from '@/api/importLog';
import type { Reconciliation } from '@/api/reconciliation';
import type { AuditEntry } from '@/api/audit';
import {
  matchKeyword,
  matchUserRule,
  matchImportRule,
  matchImportLog,
  matchReconciliation,
  matchAuditEntry,
  USER_RULE_KIND_LABEL,
  RECON_STATUS_LABEL,
} from '@/lib/globalSearch';

/** 构造一条商户规则（仅填必要字段） */
function userRule(match: string, to: string): UserRule {
  return { kind: 'merchant_renamed', match, to, enabled: true };
}

/** 构造一条资金流向（导入）规则 */
function importRule(match: string, extra: Partial<ImportRule> = {}): ImportRule {
  return { match, type: 'expense', enabled: true, ...extra };
}

/** 构造一条导入历史 */
function importLog(fileName: string): ImportLog {
  return {
    id: 1, file_name: fileName, file_count: 10, imported: 8, skipped: 1,
    duplicates: 1, created_accounts: 0, created_categories: 0, ledger_id: 1, imported_at: '2026-10-01 10:00:00',
  };
}

/** 构造一条对账批次（含账户名） */
function reconciliation(accountName: string, start: string, end: string): Reconciliation & { account_name: string } {
  return {
    id: 1, account_id: 1, period_start: start, period_end: end, opening_balance: 0,
    bank_balance: null, calc_balance: null, diff_total: 0, status: 'draft',
    created_at: '2026-10-01 10:00:00', ledger_id: 1, account_name: accountName,
  };
}

/** 构造一条审计记录 */
function auditEntry(patch: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1, ledger_id: 1, kind: 'txn', source: 'ai', action: 'ai_categorize',
    before: null, after: '餐饮', basis: null, method: 'llm', created_at: '2026-10-01 10:00:00', ...patch,
  };
}

describe('matchKeyword：通用关键词匹配', () => {
  it('空关键词一律不命中（避免空搜索列出全部数据）', () => {
    expect(matchKeyword(['餐饮'], '')).toBe(false);
    expect(matchKeyword(['餐饮'], '   ')).toBe(false);
  });

  it('忽略大小写且任一字段命中即算命中', () => {
    expect(matchKeyword(['Starbucks', null], 'starbucks')).toBe(true);
    expect(matchKeyword([undefined, '麦当劳'], '麦当劳')).toBe(true);
    expect(matchKeyword(['餐饮', '交通'], '购物')).toBe(false);
  });
});

describe('四路来源命中判定', () => {
  it('规则：匹配词 / 目标名均可命中', () => {
    expect(matchUserRule(userRule('星巴克', '咖啡'), '星巴')).toBe(true);
    expect(matchUserRule(userRule('星巴克', '咖啡'), '咖啡')).toBe(true);
    expect(matchUserRule(userRule('星巴克', '咖啡'), '麦当劳')).toBe(false);
  });

  it('导入规则：目标账户 / 转入账户 / 分类均可命中', () => {
    expect(matchImportRule(importRule('停车费', { category: '交通' }), '交通')).toBe(true);
    expect(matchImportRule(importRule('转账', { toAccount: '招商储蓄卡' }), '储蓄')).toBe(true);
    expect(matchImportRule(importRule('停车费', { category: '交通' }), '医疗')).toBe(false);
  });

  it('导入历史：按账单文件名命中（含扩展名）', () => {
    expect(matchImportLog(importLog('微信支付账单(20260901-20260930).xlsx'), '微信')).toBe(true);
    expect(matchImportLog(importLog('alipay_record_2026.csv'), 'ALIPAY')).toBe(true);
    expect(matchImportLog(importLog('alipay_record_2026.csv'), '招商')).toBe(false);
  });

  it('对账记录：按账户名或起止期间命中', () => {
    const rec = reconciliation('招商信用卡', '2026-09-01', '2026-09-30');
    expect(matchReconciliation(rec, '信用卡')).toBe(true);
    expect(matchReconciliation(rec, '2026-09')).toBe(true);
    expect(matchReconciliation(rec, '工商')).toBe(false);
  });

  it('审计记录：动作 / 依据 / 方法均可命中', () => {
    expect(matchAuditEntry(auditEntry(), 'ai_categorize')).toBe(true);
    expect(matchAuditEntry(auditEntry({ method: 'llm' }), 'llm')).toBe(true);
    expect(matchAuditEntry(auditEntry({ after: '餐饮' }), '交通')).toBe(false);
  });
});

describe('中文标签映射', () => {
  it('规则类型标签覆盖全部 kind 取值', () => {
    expect(USER_RULE_KIND_LABEL.merchant_renamed).toBe('商户归并');
    expect(USER_RULE_KIND_LABEL.categorize).toBe('自动归类');
  });

  it('对账状态标签覆盖全部状态取值', () => {
    expect(RECON_STATUS_LABEL.draft).toBe('进行中');
    expect(RECON_STATUS_LABEL.locked).toBe('已锁定');
  });
});
