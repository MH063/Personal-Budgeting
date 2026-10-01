import { Link } from 'react-router-dom';
import { useAIStore } from '@/stores/useAIStore';
import { useAiAssistantStore } from '@/stores/useAiAssistantStore';

/**
 * 仪表盘 AI 助手入口卡片（紧凑形态）。
 *
 * 历史背景：此前仪表盘内嵌完整 AI 助手（查询 + 自然语言记账 + 报告），
 * 与智能洞察「财务问答」、月度体检「AI 深度分析」是三个独立调用点，
 * 同一问题会在多处重复触发 LLM、重复消耗 Tokens，且大段答案直接铺在页面上。
 * 现所有 AI 对话能力统一收敛到全局单例弹窗（AiAssistantDialog）：
 * 本组件只保留入口按钮，自身不发起任何 AI 请求。
 */
export default function AiAssistant() {
  const enabled = useAIStore((s) => s.enabled);
  const openAssistant = useAiAssistantStore((s) => s.openAssistant);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold">🤖 AI 助手（统一入口）</div>
          <div className="text-sm text-muted">
            问答对话、月度报告、省钱建议、财务体检、下月预测、预算建议与自然语言记账，统一在弹窗中进行；
            {enabled
              ? '已开启 AI：自动接入，仅上送脱敏聚合事实，不含单笔明细。'
              : '未开启 AI 时仍可用本地规则问答，不影响其他功能。'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openAssistant()}
            className="rounded-lg px-3 py-1.5 text-sm text-white hover:opacity-90"
            style={{ background: 'var(--color-primary)' }}
          >
            打开 AI 助手
          </button>
          <Link to="/settings?tab=ai" className="text-xs text-muted hover:underline">
            {enabled ? 'AI 设置 →' : '去开启 →'}
          </Link>
        </div>
      </div>
    </div>
  );
}