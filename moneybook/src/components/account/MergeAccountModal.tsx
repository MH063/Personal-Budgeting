import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import type { Account } from '@/api/accounts';

/**
 * 合并账户弹窗：选择来源账户将被并入的目标账户（仅同类型且非自身），二次确认后执行。
 * 首次选择目标并点击「下一步」，展示来源/目标/合并后余额的确认信息，再确认执行，避免误操作。
 * 仅展示交互与确认，实际合并由父级调用 mergeAccounts 完成。
 */
export default function MergeAccountModal({ open, from, accounts, onClose, onMerge }: {
  open: boolean;
  /** 来源账户（将被并入并删除） */
  from: Account | null;
  /** 全部可选账户（用于挑选目标） */
  accounts: Account[];
  onClose: () => void;
  /** 确认合并：来源 id → 目标 id */
  onMerge: (fromId: number, toId: number) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState<number | null>(null);
  const [step, setStep] = useState<'pick' | 'confirm'>('pick');
  const [loading, setLoading] = useState(false);

  // 目标候选：同类型、非来源自身
  const candidates = accounts.filter((a) => from && a.id !== from.id && a.type === from.type);
  const target = candidates.find((a) => a.id === targetId) ?? null;

  function handleClose(v?: boolean) {
  if (v) return;
  setStep('pick');
  setTargetId(null);
  onClose();
}

  async function handleConfirm() {
    if (!from || !target) return;
    setLoading(true);
    try {
      await onMerge(from.id, target.id);
      handleClose(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="合并账户">
      {step === 'pick' ? (
        <div>
          <p className="mb-3 text-sm text-muted">
            把账户「{from?.name}」（余额 {from != null ? formatMoney(from.balance) : ''}）并入哪个同类型账户？
            来源账户的资金往来与余额将全部并入目标账户，随后删除来源账户。
          </p>
          {candidates.length === 0 ? (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm">
              没有可合并的同类型账户。
            </p>
          ) : (
            <ul className="space-y-2">
              {candidates.map((a) => (
                <li key={a.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-3 text-sm hover:bg-black/5 dark:hover:bg-white/5">
                    <input type="radio" name="merge-target" checked={targetId === a.id} onChange={() => setTargetId(a.id)} />
                    <span className="font-medium">{a.name}</span>
                    <span className="ml-auto text-muted">{formatMoney(a.balance)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => handleClose(false)}>取消</Button>
            <Button
              size="sm"
              disabled={!target}
              onClick={() => target && setStep('confirm')}
            >
              下一步
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-sm text-muted">确认把「{from?.name}」合并进「{target?.name}」？此操作不可撤销。</p>
          <ul className="mt-3 space-y-1 rounded-lg border border-[var(--border)] px-4 py-3 text-sm">
            <li className="flex justify-between"><span className="text-muted">来源余额</span><span>{from != null ? formatMoney(from.balance) : ''}</span></li>
            <li className="flex justify-between"><span className="text-muted">目标余额</span><span>{target ? formatMoney(target.balance) : ''}</span></li>
            <li className="flex justify-between font-semibold"><span>合并后余额</span><span>{from && target ? formatMoney(from.balance + target.balance) : ''}</span></li>
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => setStep('pick')}>上一步</Button>
            <Button variant="danger" size="sm" disabled={loading} onClick={handleConfirm}>
              {loading ? '合并中…' : '确认合并'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}