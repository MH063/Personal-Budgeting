import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText,
  PiggyBank, Users, BarChart3, Trash2, FileCheck2, Settings as SettingsIcon,
  Calendar, Sparkles, Target, HeartPulse,
} from 'lucide-react';
import { useUIStore } from '@/stores/useUIStore';

const NAV = [
  { to: '/', icon: LayoutDashboard, label: '仪表板' },
  { to: '/transactions', icon: ReceiptText, label: '流水记账' },
  { to: '/savings', icon: PiggyBank, label: '储蓄' },
  { to: '/loans', icon: Users, label: '借贷' },
  { to: '/stats', icon: BarChart3, label: '统计' },
  { to: '/insights', icon: Sparkles, label: '智能洞察' },
  { to: '/financial-checkup', icon: HeartPulse, label: '财务体检' },
  { to: '/calendar', icon: Calendar, label: '日历' },
  { to: '/reconcile', icon: FileCheck2, label: '银行对账' },
  { to: '/trash', icon: Trash2, label: '回收站' },
  { to: '/settings', icon: SettingsIcon, label: '设置' },
];

export default function Sidebar() {
  const { collapsed, toggle } = useUIStore();
  return (
    <aside
      className={`flex flex-col border-r transition-all duration-300 ${collapsed ? 'w-16' : 'w-56'}`}
      style={{
        borderColor: 'var(--border)',
        background: 'rgba(var(--card-rgb), 0.7)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex h-16 items-center justify-center gap-2 px-4 font-bold" style={{ color: 'var(--color-primary)' }}>
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow-sm">
          <span className="text-sm leading-none">M</span>
        </div>
        {!collapsed && <span className="text-lg tracking-tight text-[var(--fg)]">MoneyBook</span>}
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `group relative mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow-md'
                  : 'text-muted hover:bg-black/5 hover:text-[var(--fg)] dark:hover:bg-white/10'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon size={18} className={`transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`} />
                {!collapsed && <span>{label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-3">
        <button
          onClick={toggle}
          className="flex w-full items-center justify-center rounded-xl px-3 py-2.5 text-xs font-medium text-muted transition-colors hover:bg-black/5 hover:text-[var(--fg)] dark:hover:bg-white/10"
        >
          {collapsed ? '»' : '« 收起侧边栏'}
        </button>
      </div>
    </aside>
  );
}