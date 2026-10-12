import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cleanTransaction } from '@/api/txnClean';

/**
 * 交易字段清洗区块：粘贴备注／收款方文本，本地解析出实付金额、原价与优惠、
 * 手续费与税费、净消费、支付方式及退款状态。全部本地规则计算，不联网、不上送数据。
 * （自「智能洞察」页拆出，展示与交互保持不变。）
 */
export default function CleanSection() {
  const [input, setInput] = useState('');
  const [out, setOut] = useState(cleanTransaction(''));
  const [touched, setTouched] = useState(false);

  return (
    <section>
      <h3 className="mb-2 font-semibold">🧹 交易字段清洗</h3>
      <Card className="p-4">
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setOut(cleanTransaction(e.target.value)); setTouched(true); }}
          placeholder="粘贴备注/收款方，如：微信支付 100.00 手续费 2.00 优惠 5"
          className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm outline-none"
        />
        {touched && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-muted">实付</div><div className="font-medium">{out.paid != null ? `¥${out.paid.toFixed(2)}` : '—'}</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-muted">原价 / 优惠</div>
              <div className="font-medium">{out.original != null ? `¥${out.original}` : '—'}{out.discount ? `（省¥${out.discount}）` : ''}</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-muted">手续/税费</div>
              <div className="font-medium">{out.fee != null ? `¥${out.fee.toFixed(2)}` : '—'}</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-muted">净消费</div><div className="font-medium">{out.cleanAmount != null ? `¥${out.cleanAmount.toFixed(2)}` : '—'}</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-muted">支付方式</div><div className="font-medium">{out.payMethod ? `${out.payMethod.icon} ${out.payMethod.name}` : '—'}</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="text-muted">状态</div>
              <div className="font-medium">{out.isRefund ? '退款/退货' : '正常'}</div>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
