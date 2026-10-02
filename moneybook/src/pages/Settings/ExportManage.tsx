import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { getCategoryDistribution } from '@/api/stats';
import { exportToCsv, exportToPdf } from '@/api/export';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';

export default function ExportManage() {
  const [from, setFrom] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = useState(dayjs().format('YYYY-MM-DD'));
  const [loading, setLoading] = useState(false);
  const [cats, setCats] = useState<{ name: string; icon: string; total: number }[]>([]);

  const loadPreview = async () => {
    // 选定区间分类汇总（PDF 打印表的源数据）
    setCats(await getCategoryDistribution('expense', from, to));
  };

  useEffect(() => { loadPreview(); }, [from, to]);

  async function onExportCsv() {
    if (!from || !to) { toast.error('请先选择日期范围'); return; }
    try {
      setLoading(true);
      const msg = await exportToCsv({ from, to });
      toast.success(msg);
    } catch (e) {
      toast.error('导出 CSV 失败' + (e instanceof Error ? `：${e.message}` : ''));
    } finally {
      setLoading(false);
    }
  }

  async function onExportPdf() {
    if (!from || !to) { toast.error('请先选择日期范围'); return; }
    try {
      setLoading(true);
      const msg = await exportToPdf({ from, to });
      toast.success(msg);
    } catch (e) {
      toast.error('导出报表失败' + (e instanceof Error ? `：${e.message}` : ''));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>报表导出 CSV / PDF</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">起始日期</span>
              <Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-44" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">结束日期</span>
              <Input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-44" />
            </div>
            <Button onClick={onExportCsv} disabled={loading}>导出 CSV</Button>
            <Button variant="outline" onClick={onExportPdf} disabled={loading}>导出 PDF (打印)</Button>
          </div>
          <p className="text-xs text-muted">PDF 通过浏览器打印功能实现，在弹出的打印窗口中选择「另存为 PDF」即可导出。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>分类汇总（支出 · {from} ~ {to}）</CardTitle>
        </CardHeader>
        <CardContent>
          {cats.length === 0 ? (
            <p className="text-sm text-muted">区间内暂无支出记录</p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {cats.map((c) => (
                <span key={c.name} className="flex items-center gap-1 text-sm">
                  <span>{c.icon} {c.name}</span>
                  <span className="font-medium text-muted">{formatMoney(c.total)}</span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}