import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useUIStore } from '@/stores/useUIStore';
import { useFilterStore } from '@/stores/useFilterStore';
import { listTransactionsDetailed, type Transaction } from '@/api/transactions';
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

  function goTransaction(tx: Transaction) {
    setQuickSearch(tx.note || (TX_TYPES[tx.type]?.label ?? ''));
    navigate(pageOf(tx));
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

            {!keyword && (
              <Command.Group heading="导航">
                {ITEMS.map((it) => (
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

            {keyword && txResults.length === 0 && keyword.length > 0 && (
              <Command.Group heading="导航">
                {ITEMS.filter((it) => it.label.includes(keyword) || it.path.includes(keyword)).map((it) => (
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
          </Command.List>
        </Command>
      </div>
    </div>
  );
}