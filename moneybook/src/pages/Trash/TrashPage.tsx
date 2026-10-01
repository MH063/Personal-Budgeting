// 回收站页面：按实体筛选，支持恢复与彻底删除（删除操作进入回收站后在此兜底）
import { useState } from 'react';
import { toast } from 'sonner';
import { TRASH_LABEL, type TrashEntity } from '@/api/trash';
import { useTrash } from '@/hooks/useTrash';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { DataTable } from '@/components/data-table/DataTable';
import { formatDate } from '@/lib/format';

const ENTITY_ORDER: TrashEntity[] = [
  'transaction', 'account', 'category', 'tag', 'budget', 'savings_goal', 'loan', 'recurring',
];

// 各实体快照的高层描述（从快照 JSON 中提取关键字段便于识别）
function describe(item: { entity: TrashEntity; entity_id: number; ref_object: string }): string {
  try {
    const ref = JSON.parse(item.ref_object) as Record<string, unknown>;
    switch (item.entity) {
      case 'transaction':
        return `¥${Number(ref.amount).toFixed(2)} · ${String(ref.type ?? '')} · ${String(ref.note ?? '') || '无备注'}`;
      case 'account': return String(ref.name ?? '');
      case 'category': return `${String(ref.icon ?? '')} ${String(ref.name ?? '')}`;
      case 'tag': return String(ref.name ?? '');
      case 'budget': return `¥${Number(ref.amount).toFixed(2)}`;
      case 'savings_goal': return `${String(ref.icon ?? '')} ${String(ref.name ?? '')}`;
      case 'loan': return `${ref.direction === 'lend' ? '借出' : '借入'} · ${String(ref.counterparty ?? '')} · ¥${Number(ref.principal).toFixed(2)}`;
      case 'recurring': return `${String(ref.type ?? '')} · ¥${Number(ref.amount).toFixed(2)} · ${String(ref.note ?? '') || '无备注'}`;
      default: return `#${item.entity_id}`;
    }
  } catch {
    return `#${item.entity_id}`;
  }
}

export default function TrashPage() {
  const [entity, setEntity] = useState<TrashEntity | undefined>(undefined);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<number | null>(null);
  // 「清空回收站」二次确认（批量硬删除不可恢复，需用户明确确认）
  const [clearOpen, setClearOpen] = useState(false);
  const { list, restore, purge, clear } = useTrash(entity);

  const items = list.data ?? [];
  const loading = list.isLoading;

  async function onRestore() {
    if (restoreTarget == null) return;
    try {
      await restore.mutateAsync(restoreTarget);
      toast.success('已恢复');
    } catch (e) {
      toast.error(`恢复失败：${(e as Error).message}`);
    }
    setRestoreTarget(null);
  }

  async function onPurge() {
    if (purgeTarget == null) return;
    try {
      await purge.mutateAsync(purgeTarget);
      toast.success('已彻底删除');
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
    setPurgeTarget(null);
  }

  const columns = [
    { key: 'category', header: '类型', render: (r: (typeof items)[number]) => TRASH_LABEL[r.entity] },
    { key: 'detail', header: '内容', render: (r: (typeof items)[number]) => describe(r) },
    { key: 'deleted_at', header: '删除时间', render: (r: (typeof items)[number]) => formatDate(r.deleted_at) },
    {
      key: 'actions', header: '操作',
      render: (r: (typeof items)[number]) => (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRestoreTarget(r.id)}
            className="rounded px-2 py-0.5 text-xs text-[var(--color-primary-fg)] hover:bg-black/5 dark:hover:bg-white/5"
          >
            恢复
          </button>
          <button
            type="button"
            onClick={() => setPurgeTarget(r.id)}
            className="rounded px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-black/5 dark:hover:bg-white/5"
          >
            彻底删除
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="回收站"
        description="误删除的交易、账户、分类、预算等记录可在此恢复；彻底删除后不可再找回。"
        action={items.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setClearOpen(true)} title="清空当前筛选下的全部回收站记录（不可恢复）">
            清空回收站
          </Button>
        ) : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setEntity(undefined)}
          className={`rounded-full px-3 py-1 text-xs ${!entity ? 'text-white' : 'bg-black/5 dark:bg-white/10 text-muted'}`}
          style={!entity ? { background: 'var(--color-primary)' } : {}}
        >
          全部
        </button>
        {ENTITY_ORDER.map((e) => {
          const on = entity === e;
          return (
            <button
              key={e}
              type="button"
              onClick={() => setEntity(on ? undefined : e)}
              className={`rounded-full px-3 py-1 text-xs ${on ? 'text-white' : 'bg-black/5 dark:bg-white/10 text-muted'}`}
              style={on ? { background: 'var(--color-primary)' } : {}}
            >
              {TRASH_LABEL[e]}
            </button>
          );
        })}
      </div>

      {items.length === 0 ? (
        <EmptyState icon="🗑️" text="回收站为空，删除的记账数据会先进入这里" />
      ) : (
        <DataTable
          columns={columns}
          data={items}
          isLoading={loading}
        />
      )}

      <ConfirmDialog
        open={restoreTarget != null}
        title="恢复记录"
        description="将把该条记录恢复到原账户与分类，涉及金额会同步回补账户余额。确定恢复吗？"
        confirmText="恢复"
        onConfirm={onRestore}
        onClose={() => setRestoreTarget(null)}
      />
      <ConfirmDialog
        open={purgeTarget != null}
        title="彻底删除"
        description="彻底删除后记录无法再恢复。确定继续吗？"
        confirmText="彻底删除"
        danger
        onConfirm={onPurge}
        onClose={() => setPurgeTarget(null)}
      />
      <ConfirmDialog
        open={clearOpen}
        title="清空回收站"
        description={`将彻底删除当前筛选下共 ${items.length} 条回收站记录，删除后无法再恢复。建议先确认无需找回再操作。确定清空吗？`}
        confirmText="全部清空"
        danger
        onConfirm={() => { clear.mutateAsync(entity); setClearOpen(false); }}
        onClose={() => setClearOpen(false)}
      />
    </div>
  );
}