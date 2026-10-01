import dayjs from 'dayjs';

/** 金额格式化为两位小数的货币字符串，如 ¥1,234.56 */
export function formatMoney(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? '-' : ''}¥${formatted}`;
}

/** 金额高亮颜色 */
export function moneyColor(n: number): string {
  if (n > 0) return '#10B981';
  if (n < 0) return '#EF4444';
  return '#64748B';
}

/** 日期转显示文本 */
export function formatDate(date?: string | null): string {
  if (!date) return '-';
  return dayjs(date).format('YYYY-MM-DD');
}

/** 百分比文本 */
export function formatPercent(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}