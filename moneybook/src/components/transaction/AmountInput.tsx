import { forwardRef } from 'react';

export const AmountInput = forwardRef<HTMLInputElement, {
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>>(({ error, ...rest }, ref) => (
  <div>
    <div
      className="flex items-center gap-2 rounded-lg border px-3 py-2 focus-within:border-[var(--color-primary)]"
      style={{ borderColor: error ? 'var(--color-danger)' : 'var(--border)' }}
    >
      <span className="text-2xl text-muted">¥</span>
      <input
        ref={ref}
        type="number"
        step="0.01"
        min="0"
        placeholder="0.00"
        className="flex-1 border-0 bg-transparent text-2xl outline-none"
        {...rest}
      />
    </div>
    {error && <p className="mt-1 text-xs text-danger">{error}</p>}
  </div>
));
AmountInput.displayName = 'AmountInput';