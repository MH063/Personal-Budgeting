import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useUIStore } from '@/stores/useUIStore';
import { useFilterStore } from '@/stores/useFilterStore';
import { listTransactionsDetailed, type Transaction } from '@/api/transactions';
import { listCategories } from '@/api/categories';
import { listAccounts } from '@/api/accounts';
import { listImportLogs } from '@/api/importLog';
import { listReconciliations } from '@/api/reconciliation';
import { queryAuditLogs, AUDIT_SOURCE_LABEL } from '@/api/audit';
import { loadUserRules, type UserRule } from '@/api/merchantNorm';
import { loadImportRules } from '@/api/importRules';
import type { ImportRule } from '@/api/import';
import {
  matchUserRule,
  matchImportRule,
  matchImportLog,
  matchReconciliation,
  matchAuditEntry,
  USER_RULE_KIND_LABEL,
  RECON_STATUS_LABEL,
} from '@/lib/globalSearch';
import { SETTINGS_TABS } from '@/lib/settingsTabs';
import { TX_TYPES } from '@/lib/constants';
import { formatMoney, formatDate } from '@/lib/format';

const ITEMS = [
  { label: '仪表板', path: '/' },
  { label: '流水记账（收支转/借贷流水）', path: '/transactions' },
  { label: '账户', path: '/accounts' },
  { label: '储蓄目标', path: '/savings' },
  { label: '借贷管理', path: '/loans' },
  { label: '统计', path: '/stats' },
  { label: '智能洞察', path: '/insights' },
  { label: '设置', path: '/settings' },
];

/** 交易来源的服务端搜索防抖时长（毫秒），避免每次按键都查库 */
const DEBOUNCE_MS = 300;

/** 规则来源的命中项（商户/归类规则 + 资金流向规则合并展示） */
interface RuleHit {
  id: string;        // cmdk value（全局唯一前缀）
  kindLabel: string; // 类型中文标签（商户归并 / 自动归类 / 资金流向）
  label: string;     // 匹配词
  sub: string;       // 目标（→ xxx）
}

/** 交易的归属页（下钻跳转）：统一流水页 + 类型 Tab */
function pageOf(tx: Transaction): string {
  const m: Record<string, string> = {
    income: 'income', expense: 'expense', transfer: 'transfer',
    lend: 'lend', repay_in: 'lend', borrow: 'borrow', repay_out: 'borrow',
  };
  return `/transactions?type=${m[tx.type] ?? 'expense'}`;
}

export default function CommandPalette() {
  const open = useUIStore((s) => s.commandOpen);
  const setOpen = useUIStore((s) => s.setCommandOpen);
  const setQuickSearch = useFilterStore((s) => s.setQuickSearch);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  // 服务端搜索用的防抖关键词（本地来源仍用即时 keyword，保证输入即时响应）
  const [dq, setDq] = useState('');

  // 打开时复位搜索词，避免缓存上一次结果
  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  // 快捷键监听已统一收敛到 useGlobalShortcuts（键位可在设置中自定义），此处不再单独监听

  const keyword = q.trim();

  // 300ms 防抖：仅用于「服务端搜索」的两路来源（交易、审计），避免每次按键都查库
  useEffect(() => {
    const t = setTimeout(() => setDq(keyword), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [keyword]);

  // —— 来源 1：交易（服务端搜索 + 防抖） ——
  const { data: txResults = [], isFetching: txFetching } = useQuery({
    queryKey: ['command-search', dq],
    queryFn: () => listTransactionsDetailed({ search: dq, limit: 12 }),
    enabled: dq.length > 0,
    placeholderData: keepPreviousData,
  });

  // —— 来源 2：分类（拉全量 + 本地过滤，queryKey 不含关键词） ——
  const { data: allCategories = [] } = useQuery({
    queryKey: ['command-categories'],
    queryFn: () => listCategories(),
    enabled: keyword.length > 0,
  });
  const catResults = keyword ? allCategories.filter((c) => c.name.includes(keyword)).slice(0, 6) : [];

  // —— 来源 3：账户（同分类模式） ——
  const { data: allAccounts = [] } = useQuery({
    queryKey: ['command-accounts'],
    queryFn: () => listAccounts(),
    enabled: keyword.length > 0,
  });
  const accResults = keyword ? allAccounts.filter((a) => a.name.includes(keyword)).slice(0, 6) : [];

  // —— 来源 4：规则（本地 KV 同步读取，打开面板时取一次；纯本地过滤，不查库） ——
  const rulesData = useMemo<{ user: UserRule[]; flow: ImportRule[] }>(
    () => (open ? { user: loadUserRules(), flow: loadImportRules() } : { user: [], flow: [] }),
    [open]
  );
  const ruleResults = useMemo<RuleHit[]>(() => {
    if (!keyword) return [];
    const hits: RuleHit[] = [];
    for (const r of rulesData.user) {
      if (hits.length >= 8) break;
      if (matchUserRule(r, keyword)) {
        hits.push({
          id: `rule-${r.kind}-${r.match}`,
          kindLabel: USER_RULE_KIND_LABEL[r.kind] ?? r.kind,
          label: r.match,
          sub: `→ ${r.to}`,
        });
      }
    }
    for (const r of rulesData.flow) {
      if (hits.length >= 8) break;
      if (matchImportRule(r, keyword)) {
        hits.push({ id: `irule-${r.match}`, kindLabel: '资金流向', label: r.match, sub: r.category ? `→ ${r.category}` : r.account ? `→ ${r.account}` : '' });
      }
    }
    return hits;
  }, [keyword, rulesData]);

  // —— 来源 5：导入历史（拉最近 50 条 + 本地按文件名过滤） ——
  const { data: importLogs = [] } = useQuery({
    queryKey: ['command-import-logs'],
    queryFn: () => listImportLogs(50),
    enabled: keyword.length > 0,
  });
  const impResults = keyword ? importLogs.filter((l) => matchImportLog(l, keyword)).slice(0, 6) : [];

  // —— 来源 6：对账记录（复用现有 ['reconciliations'] 缓存键，批次增删后自动失效） ——
  const { data: reconList = [] } = useQuery({
    queryKey: ['reconciliations'],
    queryFn: () => listReconciliations(),
    enabled: keyword.length > 0,
  });
  const reconResults = keyword ? reconList.filter((r) => matchReconciliation(r, keyword)).slice(0, 6) : [];

  // —— 来源 7：AI 审计（服务端搜索；5 列 LIKE + COUNT 成本高，要求 ≥2 字） ——
  const { data: auditData, isFetching: auditFetching } = useQuery({
    queryKey: ['command-audit', dq],
    queryFn: () => queryAuditLogs({ keyword: dq, limit: 8 }),
    enabled: dq.length >= 2,
    placeholderData: keepPreviousData,
  });
  const auditResults = auditData?.rows ?? [];

  // 设置项搜索：复用 SETTINGS_TABS 静态清单按名称过滤，直达对应设置分区（无需查库）
  const settingResults = keyword ? SETTINGS_TABS.filter((t) => t.label.includes(keyword)).slice(0, 6) : [];

  // 页面导航：有关键词时按名称/路径过滤，无关键词时展示全部
  const navResults = keyword
    ? ITEMS.filter((it) => it.label.includes(keyword) || it.path.includes(keyword))
    : ITEMS;

  // 输入后结果仍在路上（防抖未落地或服务端查询中）时，先不显示「无结果」，避免闪烁
  const pending = keyword !== dq || txFetching || auditFetching;

  function goTransaction(tx: Transaction) {
    setQuickSearch(tx.note || (TX_TYPES[tx.type]?.label ?? ''));
    navigate(pageOf(tx));
    setOpen(false);
  }

  /** 跳转到设置页指定分区（设置页支持 ?tab= 深链，见 lib/settingsTabs） */
  function goSettings(tab: string) {
    navigate(`/settings?tab=${tab}`);
    setOpen(false);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32" onClick={() => setOpen(false)}>
      <div className="w-[560px] max-w-[90vw] rounded-xl bg-[var(--card)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <Command shouldFilter={false}>
          <Command.Input
            autoFocus
            placeholder="搜索页面、交易、分类、账户、规则、导入、对账、审计…"
            value={q}
            onValueChange={setQ}
            className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3 outline-none"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            {!pending && <Command.Empty className="p-4 text-center text-muted">无结果</Command.Empty>}

            {/* 页面导航：无关键词展示全部，有关键词按名称/路径过滤（与其它结果并列） */}
            {navResults.length > 0 && (
              <Command.Group heading="页面">
                {navResults.map((it) => (
                  <Command.Item
                    key={it.path}
                    value={`nav-${it.path}`}
                    onSelect={() => { navigate(it.path); setOpen(false); }}
                    className="cursor-pointer rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    {it.label}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 分类结果：点击直达「设置 → 分类管理」 */}
            {catResults.length > 0 && (
              <Command.Group heading={`分类（${catResults.length}）· 点击前往分类管理`}>
                {catResults.map((c) => (
                  <Command.Item
                    key={`cat-${c.id}`}
                    value={`cat-${c.id}`}
                    onSelect={() => goSettings('category')}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span>{c.icon}</span>
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="ml-auto shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted dark:bg-white/10">
                      {c.type === 'income' ? '收入' : '支出'}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 账户结果：点击直达「设置 → 账户管理」 */}
            {accResults.length > 0 && (
              <Command.Group heading={`账户（${accResults.length}）· 点击前往账户管理`}>
                {accResults.map((a) => (
                  <Command.Item
                    key={`acc-${a.id}`}
                    value={`acc-${a.id}`}
                    onSelect={() => goSettings('account')}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span>{a.icon}</span>
                    <span className="min-w-0 truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted">¥{formatMoney(a.balance)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 规则结果：商户/归类规则 + 资金流向规则，点击直达「设置 → 智能规则」 */}
            {ruleResults.length > 0 && (
              <Command.Group heading={`规则（${ruleResults.length}）· 点击前往智能规则`}>
                {ruleResults.map((r) => (
                  <Command.Item
                    key={r.id}
                    value={r.id}
                    onSelect={() => goSettings('rules')}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted dark:bg-white/10">{r.kindLabel}</span>
                    <span className="min-w-0 truncate">{r.label}</span>
                    {r.sub && <span className="min-w-0 truncate text-xs text-muted">{r.sub}</span>}
                    <span className="ml-auto shrink-0 text-xs text-muted">规则 →</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 设置项结果：静态清单本地过滤，直达对应设置分区 */}
            {settingResults.length > 0 && (
              <Command.Group heading={`设置（${settingResults.length}）`}>
                {settingResults.map((t) => (
                  <Command.Item
                    key={`set-${t.key}`}
                    value={`set-${t.key}`}
                    onSelect={() => goSettings(t.key)}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span>{t.icon}</span>
                    <span className="min-w-0 truncate">{t.label}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted">设置 →</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {keyword && txResults.length > 0 && (
              <Command.Group
                heading={`交易（${txResults.length}）· 点击下钻到所在列表`}
              >
                {txResults.map((tx) => (
                  <Command.Item
                    key={tx.id}
                    value={`tx-${tx.id}`}
                    onSelect={() => goTransaction(tx)}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span className="min-w-0 truncate">
                      <span className="mr-1 text-muted">{formatDate(tx.date)}</span>
                      <span className="mr-1">{tx.category_icon}</span>
                      <span className="mr-1">{tx.category_name ?? TX_TYPES[tx.type]?.label}</span>
                      {tx.note && <span className="text-muted">· {tx.note}</span>}
                    </span>
                    <span className={`shrink-0 font-medium ${['income', 'borrow', 'repay_in'].includes(tx.type) ? 'text-[var(--color-success)]' : tx.type === 'transfer' ? 'text-muted' : 'text-[var(--color-danger)]'}`}>
                      {['income', 'borrow', 'repay_in'].includes(tx.type) ? '+' : tx.type === 'transfer' ? '±' : '-'} ¥{formatMoney(tx.amount)}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 导入历史结果：本地按账单文件名过滤，点击直达「设置 → 账目导入」 */}
            {impResults.length > 0 && (
              <Command.Group heading={`导入历史（${impResults.length}）· 点击前往账目导入`}>
                {impResults.map((l) => (
                  <Command.Item
                    key={`imp-${l.id}`}
                    value={`imp-${l.id}`}
                    onSelect={() => goSettings('import')}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span className="min-w-0 truncate">{l.file_name}</span>
                    <span className="shrink-0 text-xs text-muted">导入 {l.imported} 条</span>
                    <span className="ml-auto shrink-0 text-xs text-muted">{formatDate(l.imported_at)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 对账记录结果：本地按账户名/期间过滤，点击直达「银行对账」 */}
            {reconResults.length > 0 && (
              <Command.Group heading={`对账记录（${reconResults.length}）· 点击前往银行对账`}>
                {reconResults.map((r) => (
                  <Command.Item
                    key={`rec-${r.id}`}
                    value={`rec-${r.id}`}
                    onSelect={() => { navigate('/reconcile'); setOpen(false); }}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span className="min-w-0 truncate">{r.account_name ?? `账户 #${r.account_id}`}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {r.period_start ?? '—'} ~ {r.period_end ?? '—'}
                    </span>
                    <span className="ml-auto shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted dark:bg-white/10">
                      {RECON_STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* AI 审计结果：服务端搜索（≥2 字），点击直达「设置 → 智能规则」（审计历史入口所在页） */}
            {auditResults.length > 0 && (
              <Command.Group heading={`AI 审计（${auditResults.length}）· 点击前往智能规则`}>
                {auditResults.map((e) => (
                  <Command.Item
                    key={`aud-${e.id}`}
                    value={`aud-${e.id}`}
                    onSelect={() => goSettings('rules')}
                    className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted dark:bg-white/10">
                      {AUDIT_SOURCE_LABEL[e.source] ?? e.source}
                    </span>
                    <span className="min-w-0 truncate">{e.action}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted">{formatDate(e.created_at)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
