// 规划页 · 滚动预算策略区块
// -----------------------------------------------------------------------------
// 配置"上期结余如何滚入下期"：可整体关闭，或限制滚入不超过本期额度的百分比。
// 策略存于 settings 表的 kv.budget.rollover，保存后立即影响预算/记账页的滚入计算；
// 默认（开启 + 不设上限）与历史行为一致，不做任何隐式改动。
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format';
import { getRolloverPolicy, setRolloverPolicy } from '@/api/budgetPolicy';
import {
  DEFAULT_ROLLOVER_POLICY, describeRolloverPolicy, type RolloverPolicy,
} from '@/lib/budgetRolloverPolicy';

/** 示例额度：用于直观展示不同策略下的滚入效果 */
const SAMPLE_AMOUNT = 1000;
/** 示例结余：故意大于额度，用以体现"上限"的作用 */
const SAMPLE_SURPLUS = 1500;

export default function RolloverPolicySection() {
  const [policy, setPolicy] = useState<RolloverPolicy>(DEFAULT_ROLLOVER_POLICY);
  const [capInput, setCapInput] = useState('');
  const [saving, setSaving] = useState(false);

  // 首次进入读取已保存策略并回填表单
  useEffect(() => {
    const p = getRolloverPolicy();
    setPolicy(p);
    setCapInput(p.capPercent == null ? '' : String(p.capPercent));
  }, []);

  /** 把表单值归一为策略对象（上限留空 = 不设上限） */
  const buildPolicy = (): RolloverPolicy => ({
    enabled: policy.enabled,
    capPercent: capInput.trim() === '' ? null : Math.max(0, Number(capInput) || 0),
  });

  async function onSave() {
    setSaving(true);
    try {
      const next = buildPolicy();
      const ok = await setRolloverPolicy(next);
      if (ok) {
        setPolicy(next);
        toast.success('滚动预算策略已保存');
      } else {
        toast.error('保存失败，请重试');
      }
    } finally {
      setSaving(false);
    }
  }

  const draft = buildPolicy();
  // 示例预测：结余 1500、额度 1000 → 展示实际能滚入多少
  const sampleRolled = !draft.enabled
    ? 0
    : draft.capPercent == null
      ? SAMPLE_SURPLUS
      : Math.round(Math.min(SAMPLE_SURPLUS, SAMPLE_AMOUNT * draft.capPercent / 100) * 100) / 100;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch checked={policy.enabled} onChange={(v) => setPolicy((p) => ({ ...p, enabled: v }))} />
        <span className="text-sm">{policy.enabled ? '上期结余滚入下期' : '不滚入（每期只按原始额度）'}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">滚入上限（相对本期额度）</span>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            step="1"
            min="0"
            placeholder="留空 = 不设上限"
            value={capInput}
            disabled={!policy.enabled}
            onChange={(e) => setCapInput(e.target.value)}
            className="w-40"
          />
          <span className="text-xs text-muted">%</span>
        </div>
        <Button onClick={onSave} disabled={saving}>保存</Button>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-black/5 p-3 text-xs text-muted dark:bg-white/5">
        <div>当前设置：{describeRolloverPolicy(draft)}</div>
        <div className="mt-1">
          示例：本期额度 ¥{formatMoney(SAMPLE_AMOUNT)}、上期结余 ¥{formatMoney(SAMPLE_SURPLUS)} 时，可滚入 ¥{formatMoney(sampleRolled)}。
        </div>
      </div>

      <p className="text-xs text-muted">
        说明：预算采用「单行多期」滚动模型，上期可用额度减去实际支出后的结余会逐期结转。若希望每期严格按新额度执行（不累积结余），可关闭滚动；
        若不希望结余无限累积，可设置上限百分比（例如 100% 表示最多滚入一期额度）。
      </p>
    </div>
  );
}
