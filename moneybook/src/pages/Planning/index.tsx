// 预算与现金流规划页
// -----------------------------------------------------------------------------
// 四个能力集中在此页：年度预算总览、滚动预算策略、场景预测、债务偿还模拟。
// 仅做编排与分节；各区块自带数据加载，互不耦合。
// -----------------------------------------------------------------------------
import type { ReactNode } from 'react';
import AnnualBudgetSection from './sections/AnnualBudgetSection';
import RolloverPolicySection from './sections/RolloverPolicySection';
import CashflowScenarioSection from './sections/CashflowScenarioSection';
import DebtPayoffSection from './sections/DebtPayoffSection';

/** 分节容器：标题 + 说明 + 内容 */
function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mb-4 mt-1 text-xs text-muted">{desc}</p>
      {children}
    </section>
  );
}

export default function Planning() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">预算与现金流规划</h1>
        <p className="mt-1 text-sm text-muted">用真实数据做年度预算体检、未来现金流推演与还债模拟，辅助做花钱与还款决策。</p>
      </div>

      <Section title="年度预算总览" desc="年度预算 vs 实际、时间与消耗进度、按当前节奏外推的年末支出与结余。">
        <AnnualBudgetSection />
      </Section>

      <Section title="滚动预算策略" desc="控制上期结余如何滚入下期：可整体关闭，或限制滚入不超过本期额度的百分比（默认全额滚入）。">
        <RolloverPolicySection />
      </Section>

      <Section title="场景预测" desc="在近半年基线之上设定假设（收入涨跌、分类支出调整、一次性收支、额外储蓄），推演未来现金流。">
        <CashflowScenarioSection />
      </Section>

      <Section title="债务偿还模拟" desc="对比「仅最低还款」与「追加额外还款」，按雪球/雪崩策略给出结清顺序、总利息与节省效果。">
        <DebtPayoffSection />
      </Section>
    </div>
  );
}
