import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText,
  PiggyBank, Users, BarChart3, Trash2, FileCheck2, Settings as SettingsIcon,
  Calendar, Sparkles,
} from 'lucide-react';
import { useUIStore } from '@/stores/useUIStore';

const NAV = [
  { to: '/', icon: LayoutDashboard, label: '仪表板' },
  { to: '/transactions', icon: ReceiptText, label: '流水记账' },
  { to: '/savings', icon: PiggyBank, label: '储蓄' },
  { to: '/loans', icon: Users, label: '借贷' },
  { to: '/stats', icon: BarChart3, label: '统计' },
  { to: '/insights', icon: Sparkles, label: '智能洞察' },
  { to: '/calendar', icon: Calendar, label: '日历' },
  { to: '/reconcile', icon: FileCheck2, label: '银行对账' },
  { to: '/trash', icon: Trash2, label: '回收站' },
  { to: '/settings', icon: SettingsIcon, label: '设置' },
];

export default function Sidebar() {
  const { collapsed, toggle } = useUIStore();
  return (
    <aside
      className={`flex flex-col border-r transition-all duration-200 ${collapsed ? 'w-16' : 'w-56'}`}
      style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
    >
      <div className="flex h-14 items-center gap-2 px-4 font-bold" style={{ color: 'var(--color-primary)' }}>
        <span className="text-xl">💰</span>
        {!collapsed && <span>个人记账</span>}
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `mx-2 my-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive ? 'text-white' : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            style={({ isActive }) => (isActive ? { background: 'var(--color-primary)' } : {})}
          >
            <Icon size={18} />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>
      <button
        onClick={toggle}
        className="m-2 rounded-lg px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5"
      >
        {collapsed ? '»' : '« 收起'}
      </button>
    </aside>
  );
}