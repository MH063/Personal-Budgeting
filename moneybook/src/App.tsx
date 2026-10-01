import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense, useEffect } from 'react';
import AppShell from '@/components/layout/AppShell';
import Dashboard from '@/pages/Dashboard';
import { OnboardingModal } from '@/components/onboarding/OnboardingModal';
import { useActiveLedger } from '@/hooks/useLedgers';
import { useLedgerStore } from '@/stores/useLedgerStore';
import { runStartupTasks } from '@/api/startup';
import { hydrateKV, getKV } from '@/api/kv';
import { THEME_KEY } from '@/lib/constants';
import { useAIStore } from '@/stores/useAIStore';
import { useKnowledgeStore } from '@/stores/useKnowledgeStore';

const TransactionsPage = lazy(() => import('@/pages/Transactions/TransactionsPage'));
const SavingsPage = lazy(() => import('@/pages/Savings/SavingsPage'));
const LoansPage = lazy(() => import('@/pages/Loans/LoansPage'));
const StatsOverview = lazy(() => import('@/pages/Statistics/Overview'));
const IncomeStats = lazy(() => import('@/pages/Statistics/IncomeStats'));
const ExpenseStats = lazy(() => import('@/pages/Statistics/ExpenseStats'));
const SurplusStats = lazy(() => import('@/pages/Statistics/SurplusStats'));
const NetWorthStats = lazy(() => import('@/pages/Statistics/NetWorthStats'));
const FlowStats = lazy(() => import('@/pages/Statistics/FlowStats'));
const MoneyFlowPage = lazy(() => import('@/pages/Statistics/MoneyFlowPage'));
const TrashPage = lazy(() => import('@/pages/Trash/TrashPage'));
const ReconcilePage = lazy(() => import('@/pages/Reconcile'));
const Settings = lazy(() => import('@/pages/Settings'));
const CalendarPage = lazy(() => import('@/pages/Calendar/CalendarPage'));
const InsightsPage = lazy(() => import('@/pages/Insights'));

function PageFallback() {
  return <div className="flex items-center justify-center py-24 text-sm text-muted">加载中…</div>;
}

function LedgerInit() {
  const { data: active } = useActiveLedger();
  const setCurrentId = useLedgerStore((s) => s.setCurrentId);
  useEffect(() => {
    if (active) setCurrentId(active);
  }, [active, setCurrentId]);
  return null;
}

export default function App() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 先从数据库偏好表载入主题并应用，避免启动瞬间主题闪烁（不再依赖 localStorage）
      await hydrateKV();
      if (cancelled) return;
      const saved = (getKV(THEME_KEY, 'light') as 'light' | 'dark') || 'light';
      document.documentElement.classList.toggle('dark', saved === 'dark');
      // 偏好已载入内存缓存，通知各 store 从缓存重建持久化数据
      useAIStore.getState().hydrate();
      useKnowledgeStore.getState().hydrate();
      // 应用启动即运行"自动任务"（周期性记账/储蓄计提/逾期利息累计），与页面访问解耦
      runStartupTasks();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <HashRouter>
      <LedgerInit />
      <OnboardingModal />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            {/* 兼容旧入口：收支转各自直达流水页对应类型 Tab */}
            <Route path="/income" element={<Navigate to="/transactions?type=income" replace />} />
            <Route path="/expense" element={<Navigate to="/transactions?type=expense" replace />} />
            <Route path="/transfer" element={<Navigate to="/transactions?type=transfer" replace />} />
            {/* 账户管理已并入设置 */}
            <Route path="/accounts" element={<Navigate to="/settings?tab=account" replace />} />
            <Route path="/savings" element={<SavingsPage />} />
            <Route path="/loans" element={<LoansPage />} />
            <Route path="/stats" element={<StatsOverview />} />
            <Route path="/stats/income" element={<IncomeStats />} />
            <Route path="/stats/expense" element={<ExpenseStats />} />
            <Route path="/stats/surplus" element={<SurplusStats />} />
            <Route path="/stats/net-worth" element={<NetWorthStats />} />
            <Route path="/stats/flow" element={<FlowStats />} />
            <Route path="/stats/money-flow" element={<MoneyFlowPage />} />
            {/* 统计"洞察"已并入 /insights，旧地址重定向 */}
            <Route path="/stats/insights" element={<Navigate to="/insights" replace />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/reconcile" element={<ReconcilePage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  );
}