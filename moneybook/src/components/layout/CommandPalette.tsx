import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useUIStore } from '@/stores/useUIStore';
import { useFilterStore } from '@/stores/useFilterStore';
import { listTransactionsDetailed, type Transaction } from '@/api/transactions';
import { listCategories } from '@/api/categories';
import { listAccounts } from '@/api/accounts';
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

  // 打开时复位搜索词，避免缓存上一次结果
  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  // 快捷键监听已统一收敛到 useGlobalShortcuts（键位可在设置中自定义），此处不再单独监听

  const keyword = q.trim();
  const { data: txResults = [] } = useQuery({
    queryKey: ['command-search', keyword],
    // 无关键词时不请求
    queryFn: () => listTransactionsDetailed({ search: keyword, limit: 12 }),
    enabled: keyword.length > 0,
  });

  // 分类搜索：placeholder 承诺可搜「分类」，此前未实现。这里拉取全部分类后按名称本地过滤，
  // 结果可直达「设置 → 分类」管理页；queryKey 不含关键词，避免每次输入都重新查库。
  const { data: allCategories = [] } = useQuery({
    queryKey: ['command-categories'],
    queryFn: () => listCategories(),
    enabled: keyword.length > 0,
  });
  const catResults = keyword ? allCategories.filter((c) => c.name.includes(keyword)).slice(0, 6) : [];

  // 账户搜索：与分类同模式——拉取账户列表后本地按名称过滤，结果直达「设置 → 账户管理」
  const { data: allAccounts = [] } = useQuery({
    queryKey: ['command-accounts'],
    queryFn: () => listAccounts(),
    enabled: keyword.length > 0,
  });
  const accResults = keyword ? allAccounts.filter((a) => a.name.includes(keyword)).slice(0, 6) : [];

  // 设置项搜索：复用 SETTINGS_TABS 静态清单按名称过滤，直达对应设置分区（无需查库）
  const settingResults = keyword ? SETTINGS_TABS.filter((t) => t.label.includes(keyword)).slice(0, 6) : [];

  // 页面导航：有关键词时按名称/路径过滤，无关键词时展示全部
  const navResults = keyword
    ? ITEMS.filter((it) => it.label.includes(keyword) || it.path.includes(keyword))
    : ITEMS;

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
            placeholder="搜索页面、分类或交易备注…"
            value={q}
            onValueChange={setQ}
            className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3 outline-none"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="p-4 text-center text-muted">无结果</Command.Empty>

            {/* 页面导航：无关键词展示全部，有关键词按名称/路径过滤（与分类、交易结果并列） */}
            {navResults.length > 0 && (
              <Command.Group heading="页面">
                {navResults.map((it) => (
                  <Command.Item
                    key={it.path}
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
                    value={`${tx.id}`}
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
          </Command.List>
        </Command>
      </div>
    </div>
  );
}