import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';
import MonthlyCheckup from './MonthlyCheckup';
import CleanSection from './sections/CleanSection';
import HealthBudgetSection from './sections/HealthBudgetSection';
import ReportSection from './sections/ReportSection';
import MerchantSection from './sections/MerchantSection';
import SubscriptionSection from './sections/SubscriptionSection';
import AnomalySection from './sections/AnomalySection';
import DupSection from './sections/DupSection';

/**
 * 智能洞察：聚合展示本地规则引擎的结果，页面本身只做编排，各区块独立成组件（见 ./sections）。
 *  - 支出预测与预算建议（predict）
 *  - 订阅 / 重复扣费到期提醒（subscription）
 *  - 反欺诈 / 异常交易（anomaly）
 *  - 疑似重复记账（dupDetect：本地候选 + 可选 AI 判定 + 人工复核）
 *  - 交易字段清洗（txnClean）、财务健康评分（healthScore）、周月报（report）、商户画像（merchant）
 * 核心计算全部本地完成；仅用户主动触发「AI 判定」且允许明细时才上云（文本已脱敏）。
 */
export default function InsightsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="智能洞察"
        description="本地引擎：支出预测、订阅提醒、异常检测、财务问答、健康评分与省钱建议、周/月报、商户画像"
      />

      {/* —— AI 助手统一入口（合并原「财务问答」与月度体检「AI 深度分析」） —— */}
      <section className="flex items-center gap-1.5">
        <Button type="button" onClick={() => useAiAssistantStore.getState().openAssistant()}>💬 打开 AI 助手（连续对话 · 报告 · 体检）</Button>
        <Hint text="仪表盘、智能洞察与月度体检的 AI 能力已合并到此弹窗，同一对话内共享上下文，避免重复调用、重复计费；启用 AI 后仅上送脱敏聚合事实，不上送单笔明细。" />
      </section>

      {/* —— 月度体检（并入智能洞察的统一区块，与各引擎连贯展示） —— */}
      <section>
        <h3 className="mb-2 font-semibold">📋 月度体检</h3>
        <MonthlyCheckup />
      </section>

      {/* —— 交易字段清洗 —— */}
      <CleanSection />

      {/* —— 财务健康评分与省钱建议 —— */}
      <HealthBudgetSection />

      {/* —— 自动周报/月报 —— */}
      <ReportSection />

      {/* —— 商户画像与消费去向 —— */}
      <MerchantSection />

      {/* —— 订阅 / 重复扣费 —— */}
      <SubscriptionSection />

      {/* —— 异常交易 —— */}
      <AnomalySection />

      {/* —— 疑似重复记账（识别「同商户不同订单号」的重复消费：本地启发式 + 可选 AI 判定 + 用户人工复核） —— */}
      <DupSection />
    </div>
  );
}
