import { useState } from 'react';
import { toast } from 'sonner';
import { useLedgerMutations, useLedgerOverview, useSwitchLedger } from '@/hooks/useLedgers';
import { useLedgerStore } from '@/stores/useLedgerStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';

/** 可选账本图标（emoji，避免引入额外图标库依赖） */
const ICONS = ['📒', '💰', '🏠', '💼', '🚗', '✈️'];

/**
 * 账本管理页。
 *
 * 设计要点：
 * - 每个账本是一张卡片，除了名称还展示账户数、流水数、最近记账日期、储蓄目标与借贷数，
 *   让用户能直观判断「哪个账本还活着、哪个可以归档删除」；
 * - 所有写操作（新建 / 重命名 / 删除 / 复制）都有明确的确认或结果提示，避免误删数据；
 * - 数据全部来自数据库真实统计（ledgerOverview 子查询聚合），页面不展示任何模拟值。
 */
export default function LedgerManage() {
  const { data: ledgers = [], isLoading } = useLedgerOverview();
  const currentId = useLedgerStore((s) => s.currentId);
  const switchLedger = useSwitchLedger();
  const { create, update, remove, copy } = useLedgerMutations();

  // 新建表单
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  // 行内重命名
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  // 删除确认 / 复制目标选择
  const [delId, setDelId] = useState<number | null>(null);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  // 进行中的写操作：防止连续点击造成重复创建 / 重复复制
  const [busy, setBusy] = useState(false);

  /** 新建账本并自动切换过去；失败时提示具体原因 */
  async function onCreate() {
    const n = name.trim();
    if (!n) {
      toast.error('请输入账本名称');
      return;
    }
    setBusy(true);
    try {
      const id = await create.mutateAsync({ name: n, icon });
      await switchLedger(id);
      setName('');
      toast.success(`已创建「${n}」并切换`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 保存行内重命名 */
  async function onRename(id: number) {
    const n = editName.trim();
    if (!n) {
      toast.error('账本名称不能为空');
      return;
    }
    try {
      await update.mutateAsync({ id, name: n });
      setEditId(null);
      setEditName('');
      toast.success('已重命名');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** 删除账本：级联删除其账户/流水/借贷/储蓄/预算，删当前账本时自动切到剩余的第一个 */
  async function onDelete() {
    if (delId == null) return;
    setBusy(true);
    try {
      const next = ledgers.find((l) => l.id !== delId);
      await remove.mutateAsync(delId);
      if (delId === currentId && next) await switchLedger(next.id);
      setDelId(null);
      toast.success('已删除账本及其全部数据');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 把源账本数据复制到目标账本（分类/标签全局共享，其余引用按新 ID 重映射） */
  async function onCopy(targetId: number) {
    if (copyFrom == null) return;
    setBusy(true);
    try {
      const r = await copy.mutateAsync({ sourceId: copyFrom, targetId });
      setCopyFrom(null);
      toast.success(
        `已复制：账户 ${r.accounts}、流水 ${r.transactions}、借贷 ${r.loans}、储蓄目标 ${r.savingsGoals}` +
          (r.skipped ? `；跳过 ${r.skipped} 条引用缺失的数据` : '')
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const delTarget = ledgers.find((l) => l.id === delId) ?? null;
  const copyTargets = ledgers.filter((l) => l.id !== copyFrom);

  return (
    <div className="space-y-4">
      {/* 新建账本 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="text-sm font-bold">新建账本</h3>
        <p className="mt-1 text-xs text-muted">账本之间数据完全隔离，适合「家庭 / 个人 / 副业」分开记账。</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {ICONS.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIcon(i)}
                aria-label={`选择图标 ${i}`}
                className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
                  icon === i
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                    : 'border-[var(--border)] hover:border-[var(--color-primary)]'
                }`}
              >
                {i}
              </button>
            ))}
          </div>
          <Input
            className="min-w-0 flex-1 sm:max-w-xs"
            placeholder="账本名称，如「家庭账本」"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onCreate(); }}
          />
          <Button size="sm" className="shrink-0" onClick={onCreate} disabled={busy || !name.trim()}>
            创建
          </Button>
        </div>
      </section>

      {/* 账本列表 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">我的账本</h3>
          <span className="text-xs text-muted">共 {ledgers.length} 个</span>
        </div>

        {isLoading && <p className="mt-3 text-sm text-muted">加载中…</p>}

        {!isLoading && ledgers.length === 0 && (
          <p className="mt-3 text-sm text-muted">还没有账本，请在上方输入名称创建第一个账本。</p>
        )}

        {!isLoading && ledgers.length > 0 && (
          <ul className="mt-3 space-y-2">
            {ledgers.map((l) => (
              <li
                key={l.id}
                className={`rounded-lg border p-3 ${
                  l.id === currentId
                    ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/5'
                    : 'border-[var(--border)]'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xl">{l.icon}</span>
                  {editId === l.id ? (
                    <>
                      <Input
                        className="h-8 w-44"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void onRename(l.id);
                          if (e.key === 'Escape') { setEditId(null); setEditName(''); }
                        }}
                        autoFocus
                      />
                      <Button size="sm" onClick={() => void onRename(l.id)}>保存</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditId(null); setEditName(''); }}>取消</Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 max-w-full truncate font-semibold">{l.name}</span>
                      {l.id === currentId && (
                        <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-[10px] text-[var(--color-primary-foreground)]">
                          当前
                        </span>
                      )}
                      <span className="ml-auto flex shrink-0 gap-1.5">
                        {l.id !== currentId && (
                          <button
                            type="button"
                            className="text-xs text-[var(--color-primary-fg)] hover:underline"
                            onClick={async () => {
                              await switchLedger(l.id);
                              toast.success(`已切换到「${l.name}」`);
                            }}
                          >
                            切换
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-xs text-[var(--color-primary-fg)] hover:underline"
                          onClick={() => { setEditId(l.id); setEditName(l.name); }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="text-xs text-[var(--color-primary-fg)] hover:underline"
                          onClick={() => setCopyFrom(l.id)}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="text-xs text-[var(--color-danger)] hover:underline"
                          onClick={() => setDelId(l.id)}
                        >
                          删除
                        </button>
                      </span>
                    </>
                  )}
                </div>
                {/* 数据概览：让用户判断账本是否还在使用 */}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>账户 {l.account_count}</span>
                  <span>流水 {l.tx_count}</span>
                  <span>最近记账 {l.last_tx_date ?? '—'}</span>
                  <span>储蓄目标 {l.goal_count}</span>
                  <span>借贷 {l.loan_count}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 删除确认 */}
      <Modal open={delId != null} onClose={() => setDelId(null)} title="删除账本">
        <div className="p-4">
          <p className="text-sm">
            将删除「{delTarget?.name ?? ''}」及其全部账户、流水、借贷、储蓄目标与预算数据，此操作不可撤销。确定继续？
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDelId(null)}>取消</Button>
            <Button size="sm" variant="danger" onClick={() => void onDelete()} disabled={busy}>删除</Button>
          </div>
        </div>
      </Modal>

      {/* 复制目标选择 */}
      <Modal open={copyFrom != null} onClose={() => setCopyFrom(null)} title="复制账本数据">
        <div className="p-4">
          <p className="space-y-1 text-sm">
            把「{ledgers.find((l) => l.id === copyFrom)?.name ?? ''}」的数据复制到另一个账本。
            分类与标签为全局共享，账户、流水、借贷、储蓄目标、预算会按新 ID 重新关联。
          </p>
          <div className="mt-3 space-y-1">
            {copyTargets.length === 0 && <p className="text-xs text-muted">没有其他账本可作为目标，请先新建一个账本。</p>}
            {copyTargets.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={busy}
                onClick={() => void onCopy(t.id)}
                className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-left text-sm transition-colors hover:border-[var(--color-primary)]"
              >
                <span>{t.icon}</span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="shrink-0 text-xs text-muted">已有流水 {t.tx_count}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">目标账本已有数据时不会清空，复制结果会追加进去。</p>
        </div>
      </Modal>
    </div>
  );
}
