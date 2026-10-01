import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { queryAuditLogs, purgeAuditLogs, AUDIT_SOURCE_LABEL, type AuditEntry } from '@/api/audit';

/**
 * 审计历史弹窗（AI / 规则修改留痕）
 * ---------------------------------------------------------------
 * 为什么弹窗：审计记录会随使用持续增长，内联列表（死高度滚动）在数据量上来后
 * 既占页面空间又难查阅。改为独立弹窗后：
 *  - 支持「来源筛选 + 关键字搜索」，快速定位某类留痕；
 *  - 分页「加载更多」（每页 50 条），不一次性拉全表；
 *  - 单条可展开查看完整改前/改后/依据/方法；
 *  - 提供「清理 90 天前 / 清空全部」的数据治理手段，避免无限膨胀。
 * 记录仅存本机 SQLite，不进云端。
 */

/** 单页条数：点「加载更多」时按此增量追加 */
const PAGE_SIZE = 50;

/** 来源筛选 chips（与 AUDIT_SOURCE_LABEL 同口径） */
const SOURCE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'ai', label: 'AI' },
  { value: 'rule', label: '规则' },
  { value: 'user', label: '用户' },
  { value: 'import', label: '导入' },
  { value: 'local', label: '本地' },
];

export default function AuditHistoryDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** 清理完成后通知外层（设置页的审计摘要同步刷新） */
  onChanged?: () => void;
}) {
  const [source, setSource] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [kwDebounced, setKwDebounced] = useState('');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // 清理确认：null=未触发；'90d'=清理 90 天前；'all'=清空全部
  const [purgeKind, setPurgeKind] = useState<'90d' | 'all' | null>(null);
  // 请求序号：筛选快速切换 / 加载更多并发时，仅最新响应可落状态（防竞态）
  const seqRef = useRef(0);

  // 关键字 300ms 防抖：避免中文输入法逐字触发查询
  useEffect(() => {
    const t = setTimeout(() => setKwDebounced(keyword), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  /** 拉取一页（按当前筛选条件） */
  const fetchPage = useCallback(
    (offset: number) => queryAuditLogs({ source, keyword: kwDebounced, limit: PAGE_SIZE, offset }),
    [source, kwDebounced]
  );

  /** 回到第一页（筛选条件变化、清理后调用） */
  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    const r = await fetchPage(0);
    if (seq !== seqRef.current) return; // 过期响应直接丢弃
    setRows(r.rows);
    setTotal(r.total);
    setExpandedId(null);
    setLoading(false);
  }, [fetchPage]);

  // 打开弹窗或筛选变化时重新加载第一页
  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  /** 追加下一页 */
  async function loadMore() {
    if (loading || rows.length >= total) return;
    const seq = ++seqRef.current;
    setLoading(true);
    const r = await fetchPage(rows.length);
    if (seq !== seqRef.current) return;
    setRows((prev) => [...prev, ...r.rows]);
    setTotal(r.total);
    setLoading(false);
  }

  /** 执行清理（清空全部 / 仅清理 90 天前） */
  async function doPurge() {
    const kind = purgeKind;
    if (!kind) return;
    const n = kind === 'all' ? await purgeAuditLogs() : await purgeAuditLogs(90);
    toast.success(n > 0 ? `已清理 ${n} 条审计记录` : '没有可清理的记录');
    onChanged?.();
    await reload();
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="审计历史（AI / 规则修改留痕）" wide>
        {/* —— 筛选行：来源 chips + 关键字搜索 —— */}
        <div className="flex flex-wrap items-center gap-2">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSource(f.value)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                source === f.value
                  ? 'border-[var(--color-primary)] font-medium text-[var(--color-primary)]'
                  : 'border-[var(--border)] text-muted hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {f.label}
            </button>
          ))}
          <Input
            placeholder="搜索动作 / 依据 / 改前改后…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="ml-auto max-w-[220px]"
          />
        </div>

        {/* —— 统计行 —— */}
        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>共 {total} 条 · 已显示 {rows.length} 条</span>
          {loading && <span>加载中…</span>}
        </div>

        {/* —— 记录列表（弹窗内滚动） —— */}
        <div className="mt-2 max-h-[46vh] space-y-1 overflow-auto pr-1">
          {rows.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-muted">暂无匹配的审计记录。</p>
          ) : (
            rows.map((a) => (
              <AuditRow
                key={a.id}
                item={a}
                expanded={expandedId === a.id}
                onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
              />
            ))
          )}
        </div>

        {/* —— 底部：分页 + 数据清理 —— */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
          {rows.length < total ? (
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
              加载更多（剩余 {total - rows.length} 条）
            </Button>
          ) : (
            <span className="text-xs text-muted">已到底部</span>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={total === 0 || loading} onClick={() => setPurgeKind('90d')}>
              清理 90 天前
            </Button>
            <Button variant="danger" size="sm" disabled={total === 0 || loading} onClick={() => setPurgeKind('all')}>
              清空全部
            </Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          审计记录仅存本机，不上传云端。数据量大时建议「清理 90 天前」保留近期留痕；如需留存完整历史，请先在「数据备份与导出」中导出数据。
        </p>
      </Modal>

      {/* 清理二次确认：明确告知影响范围，防止误清 */}
      <ConfirmDialog
        open={purgeKind !== null}
        title={purgeKind === 'all' ? '清空全部审计记录' : '清理 90 天前的审计记录'}
        description={
          purgeKind === 'all'
            ? `将永久删除当前账本的全部审计记录（共 ${total} 条），删除后不可恢复。如需留存，请先取消并在「数据备份与导出」中导出数据。`
            : '将永久删除 90 天前的审计记录，近 90 天的留痕会保留。此操作不可恢复。'
        }
        confirmText={purgeKind === 'all' ? '确认清空' : '确认清理'}
        danger
        onConfirm={() => void doPurge()}
        onClose={() => setPurgeKind(null)}
      />
    </>
  );
}

/** 单条审计记录：折叠摘要 → 展开显示完整字段 */
function AuditRow({ item, expanded, onToggle }: { item: AuditEntry; expanded: boolean; onToggle: () => void }) {
  const src = AUDIT_SOURCE_LABEL[item.source] ?? item.source;
  return (
    <div className="rounded-md border border-[var(--border)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-black/2 dark:hover:bg-white/5"
      >
        <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/10">{src}</span>
        <span className="shrink-0 text-muted">{item.created_at}</span>
        <span className="min-w-0 flex-1 truncate">
          {item.action}
          {item.after ? ` · ${item.after}` : ''}
        </span>
        <span className="shrink-0 text-muted">{expanded ? '收起' : '详情'}</span>
      </button>
      {expanded && (
        <dl className="space-y-1 border-t border-[var(--border)] px-2.5 py-2 text-xs">
          <AuditField label="事件类型" value={item.kind} />
          <AuditField label="改前" value={item.before} />
          <AuditField label="改后" value={item.after} />
          <AuditField label="依据" value={item.basis} />
          <AuditField label="方法" value={item.method} />
        </dl>
      )}
    </div>
  );
}

/** 详情字段行：空值直接不渲染，避免出现无意义的空标签 */
function AuditField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-all">{value}</dd>
    </div>
  );
}