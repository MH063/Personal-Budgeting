import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { buildReport, type ReportResult } from '@/api/report';

/**
 * 自动周报 / 月报区块：点击生成后调用本地 report 引擎（开启 AI 时由 AI 归纳总结），
 * 结果以等宽文本展示；生成中禁用按钮避免重复触发。
 * （自「智能洞察」页拆出，展示与交互保持不变。）
 */
export default function ReportSection() {
  const [report, setReport] = useState<ReportResult | null>(null);
  const [reporting, setReporting] = useState<'week' | 'month' | null>(null);

  /** 生成指定周期的报告（week=周报 / month=月报），生成中忽略重复点击 */
  async function genReport(period: 'week' | 'month') {
    if (reporting) return;
    setReporting(period);
    try {
      const res = await buildReport(period);
      setReport(res);
    } finally {
      setReporting(null);
    }
  }

  return (
    <section>
      <h3 className="mb-2 font-semibold">📄 自动周报 / 月报</h3>
      <Card className="p-4">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={reporting != null} onClick={() => void genReport('week')}>
            {reporting === 'week' ? '生成中…' : '生成周报'}
          </Button>
          <Button variant="outline" size="sm" disabled={reporting != null} onClick={() => void genReport('month')}>
            {reporting === 'month' ? '生成中…' : '生成月报'}
          </Button>
        </div>
        {report && (
          <div className="mt-3 overflow-auto rounded-lg border border-[var(--border)] bg-black/2 px-3 py-2 dark:bg-white/5">
            <div className="mb-1 text-xs text-muted">
              {report.title} · {report.range}{report.source === 'ai' && <span className="ml-1 text-[10px] text-[var(--color-primary-fg)]">AI 总结</span>}
            </div>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed">{report.text}</pre>
          </div>
        )}
      </Card>
    </section>
  );
}
