/**
 * 全局搜索（命令面板）的纯过滤函数与展示映射。
 * ---------------------------------------------------------------------------
 * 命令面板（Ctrl/⌘+K）在「页面 / 分类 / 账户 / 设置项 / 交易」之外新增 4 路来源：
 * 规则、导入历史、对账记录、AI 审计。这里只做「数据 + 关键词 → 是否命中」的纯判断，
 * 便于单元测试；不引入任何运行时依赖（类型全部 `import type`，编译后擦除）。
 */
import type { UserRule } from '@/api/merchantNorm';
import type { ImportRule } from '@/api/import';
import type { ImportLog } from '@/api/importLog';
import type { Reconciliation } from '@/api/reconciliation';
import type { AuditEntry } from '@/api/audit';

/** 规则类型中文标签（商户归并 / 自动归类） */
export const USER_RULE_KIND_LABEL: Record<string, string> = {
  merchant_renamed: '商户归并',
  categorize: '自动归类',
};

/** 对账批次状态中文标签 */
export const RECON_STATUS_LABEL: Record<string, string> = {
  draft: '进行中',
  locked: '已锁定',
};

/**
 * 通用关键词匹配：对若干字段做「忽略大小写的包含」判断。
 * 空关键词一律视为不命中，避免空搜索把所有数据都列出来。
 */
export function matchKeyword(fields: (string | null | undefined)[], kw: string): boolean {
  const k = kw.trim().toLowerCase();
  if (!k) return false;
  return fields.some((f) => (f ?? '').toLowerCase().includes(k));
}

/** 商户/归类规则命中：匹配词或目标名 */
export function matchUserRule(r: UserRule, kw: string): boolean {
  return matchKeyword([r.match, r.to], kw);
}

/** 资金流向（导入）规则命中：匹配词、目标账户、转入账户或目标分类 */
export function matchImportRule(r: ImportRule, kw: string): boolean {
  return matchKeyword([r.match, r.account, r.toAccount, r.category], kw);
}

/** 导入历史命中：账单文件名 */
export function matchImportLog(l: ImportLog, kw: string): boolean {
  return matchKeyword([l.file_name], kw);
}

/** 对账批次命中：账户名或起止期间 */
export function matchReconciliation(r: Reconciliation & { account_name?: string }, kw: string): boolean {
  return matchKeyword([r.account_name, r.period_start, r.period_end], kw);
}

/** 审计记录命中：动作、改前、改后、依据或方法 */
export function matchAuditEntry(e: AuditEntry, kw: string): boolean {
  return matchKeyword([e.action, e.before, e.after, e.basis, e.method], kw);
}
