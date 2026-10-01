import { execute, select } from './db';
import { currentLedgerId } from '@/lib/ledger';

/**
 * AI / 规则 审计与反馈日志
 * ---------------------------------------------------------------
 * 记录每次"AI 或规则参与的修改/建议/回写"，含：事件类型、来源（ai/rule/local/import/user）、
 * 动作、改前/改后、依据、关联的原始文本与时间。用于可解释性与"用户纠正→回写规则"闭环。
 */

export interface AuditEntry {
  id: number;
  ledger_id: number;
  kind: string;
  source: string;
  action: string;
  before: string | null;
  after: string | null;
  basis: string | null;
  method: string | null;
  created_at: string;
}

/** 写入一条审计日志（本地保存，不涉及任何网络）。 */
export async function recordAudit(p: {
  kind: string;
  source: 'ai' | 'rule' | 'local' | 'import' | 'user';
  action: string;
  before?: string | null;
  after?: string | null;
  basis?: string | null;
  method?: string | null;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO ai_audit_log (ledger_id, kind, source, action, before, after, basis, method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [currentLedgerId(), p.kind, p.source, p.action, p.before ?? null, p.after ?? null, p.basis ?? null, p.method ?? null]
    );
  } catch {
    /* 审计写入失败不影响主流程 */
  }
}

/** 查询最近审计日志（倒序）。 */
export function listAuditLogs(limit = 50): Promise<AuditEntry[]> {
  try {
    return select<AuditEntry>(
      `SELECT * FROM ai_audit_log WHERE ledger_id = $1 ORDER BY id DESC LIMIT $2`,
      [currentLedgerId(), limit]
    );
  } catch {
    return Promise.resolve([]);
  }
}

/** 审计来源的展示文案（弹窗筛选 chips 与列表徽标共用一份口径） */
export const AUDIT_SOURCE_LABEL: Record<string, string> = {
  ai: 'AI',
  rule: '规则',
  local: '本地',
  import: '导入',
  user: '用户',
};

/** 审计日志分页查询条件 */
export interface AuditQuery {
  /** 来源筛选（ai/rule/local/import/user）；缺省或 'all' 表示全部 */
  source?: string;
  /** 关键字：模糊匹配 动作/改前/改后/依据/方法 */
  keyword?: string;
  /** 单页条数（1-500，默认 50） */
  limit?: number;
  /** 偏移量（>=0） */
  offset?: number;
}

/**
 * 分页查询审计日志（附带满足条件的总条数）。
 * 供「审计历史」弹窗使用：数据量大时靠分页 + 筛选避免一次性拉全表。
 */
export async function queryAuditLogs(
  q: AuditQuery = {}
): Promise<{ total: number; rows: AuditEntry[] }> {
  try {
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 500);
    const offset = Math.max(Math.floor(q.offset ?? 0), 0);
    const params: unknown[] = [currentLedgerId()];
    let where = `ledger_id = $1`;
    if (q.source && q.source !== 'all') {
      params.push(q.source);
      where += ` AND source = $${params.length}`;
    }
    const kw = (q.keyword ?? '').trim();
    if (kw) {
      params.push(`%${kw}%`);
      const p = `$${params.length}`;
      where += ` AND (action LIKE ${p} OR IFNULL(before,'') LIKE ${p} OR IFNULL(after,'') LIKE ${p} OR IFNULL(basis,'') LIKE ${p} OR IFNULL(method,'') LIKE ${p})`;
    }
    const cnt = await select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ai_audit_log WHERE ${where}`,
      params
    );
    const rows = await select<AuditEntry>(
      `SELECT * FROM ai_audit_log WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { total: Number(cnt[0]?.c ?? 0), rows };
  } catch {
    return { total: 0, rows: [] };
  }
}

/**
 * 清理审计日志，返回删除条数。
 * - olderThanDays 缺省：清空当前账本全部记录；
 * - 传天数：仅删除该天数之前的记录（保留近期留痕）。
 * 审计为日志类数据，不进回收站（回收站面向业务实体）；清理前弹窗会提示"如需留存请先导出"。
 */
export async function purgeAuditLogs(olderThanDays?: number): Promise<number> {
  try {
    if (olderThanDays === undefined) {
      const r = await execute(`DELETE FROM ai_audit_log WHERE ledger_id = $1`, [currentLedgerId()]);
      return r.rowsAffected;
    }
    const days = Math.max(0, Math.floor(olderThanDays));
    const r = await execute(
      `DELETE FROM ai_audit_log WHERE ledger_id = $1 AND created_at < datetime('now','localtime', $2)`,
      [currentLedgerId(), `-${days} days`]
    );
    return r.rowsAffected;
  } catch {
    return 0;
  }
}

/** 统计某类审计事件的条数（如纠正回写 rule_learned），用于"纠正率/反馈闭环"可观测。 */
export async function countAuditByKind(kind: string): Promise<number> {
  try {
    const rows = await select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ai_audit_log WHERE ledger_id = $1 AND kind = $2`,
      [currentLedgerId(), kind]
    );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}