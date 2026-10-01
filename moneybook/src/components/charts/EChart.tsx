import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

/**
 * echarts 基础封装。
 * - 统一管理初始化 / 尺寸自适应 / 销毁；
 * - 自动适配暗色：页脚 textStyle 默认色随主题切换（亮色 #555，暗色 #cbd5e1），
 *   保证图例、坐标轴、标签在暗色模式下文字清晰可读；业务侧显式指定的
 *   textStyle.color 仍然优先。
 */
export function EChart({ option, height = 300, className }: {
  option: EChartsOption; height?: number | string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = echarts.init(ref.current);
    const onResize = () => chartRef.current?.resize();
    window.addEventListener('resize', onResize);

    // 监听 <html> 的 dark class 变化，保证图表文字颜色跟随主题，避免暗色下手动切主题后文字仍为深色
    const mutate = () => { chartRef.current?.setOption(buildOption(option), true); };
    const observer = new MutationObserver(mutate);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 根据当前暗色状态生成合并了默认文字颜色的配置；外部显式 color 优先
  function buildOption(opt: EChartsOption): EChartsOption {
    const isDark = document.documentElement.classList.contains('dark');
    const baseColor = isDark ? '#cbd5e1' : '#555';
    return {
      ...opt,
      textStyle: { color: baseColor, ...(opt.textStyle ?? {}) },
      legend: opt.legend
        ? { ...opt.legend, textStyle: { color: baseColor, ...((opt.legend as { textStyle?: object }).textStyle ?? {}) } }
        : undefined,
    };
  }

  useEffect(() => {
    chartRef.current?.setOption(buildOption(option), true);
  }, [option]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} className={className} style={{ height, width: '100%' }} />;
}