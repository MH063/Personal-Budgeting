import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/stats', label: '总览', end: true },
  { to: '/stats/income', label: '收入' },
  { to: '/stats/expense', label: '支出' },
  { to: '/stats/surplus', label: '盈余' },
  { to: '/stats/net-worth', label: '净资产' },
  { to: '/stats/flow', label: '资金流向' },
  { to: '/stats/money-flow', label: '资金去向' },
];

export default function StatsNav() {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto rounded-lg bg-black/5 p-1 dark:bg-white/5">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `whitespace-nowrap rounded-md px-4 py-1.5 text-sm transition-colors ${
              isActive ? 'bg-[var(--color-primary)] font-medium text-white shadow-sm' : 'text-[var(--color-primary-fg)] hover:opacity-80'
            }`}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}