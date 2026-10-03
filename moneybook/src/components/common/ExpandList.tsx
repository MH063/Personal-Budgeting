import { useState, type ReactNode } from 'react';

/**
 * 列表「默认展示 Top N + 展开全部」容器。
 * 背景：智能洞察等页面存在多个无上限的数据列表（商户画像 / 订阅 / 异常 / 疑似重复等），
 * 数据量多时会无限纵向堆叠、铺满全屏影响美观。此组件把长列表收敛为
 * 「默认 Top N 条 + 展开全部 N 条 ▼ / 收起 ▲」。
 *
 * 设计要点（展开后不铺满全屏）：
 *  - 收起态：仅渲染前 N 条，自然高度，页面紧凑；
 *  - 展开态：容器限制最大高度（50vh）+ 内部滚动，全部数据可见但不再无限堆叠，
 *    「展开全部」不再等于「铺满全屏」；
 *  - 展开/收起按钮位于滚动容器之外：用户滚动到底部后仍能一键收起，不必回滚。
 */
export function ExpandList<T>(props: { items: T[]; initial?: number; render: (item: T, index: number) => ReactNode; className?: string }) {
  const { items, initial = 6, render, className } = props;
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, initial);
  return (
    <div className={className}>
      {/* 展开态限制高度并内部滚动：数据全量可见但容器不再撑高页面 */}
      <div className={open ? 'max-h-[50vh] overflow-y-auto pr-1' : undefined}>
        {shown.map(render)}
      </div>
      {items.length > initial && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1.5 w-full rounded-lg border border-dashed border-[var(--border)] py-1.5 text-xs text-[var(--color-primary-fg)] hover:bg-black/2 dark:hover:bg-white/5"
        >
          {open ? '收起 ▲' : `展开全部 ${items.length} 条 ▼`}
        </button>
      )}
    </div>
  );
}
