export type AuditFilter = {
  key: string;
  label: string;
  match: (action: string) => boolean;
};

export const AUDIT_FILTERS: AuditFilter[] = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'order', label: '訂單', match: (action) => action.startsWith('order.') },
  { key: 'member', label: '會員', match: (action) => action.startsWith('member.') },
  { key: 'product', label: '商品', match: (action) => action.startsWith('product.') },
  { key: 'staff', label: '帳號', match: (action) => action.startsWith('staff.') },
  { key: 'approval', label: '審批', match: (action) => action.startsWith('approval.') },
  { key: 'tryon', label: '試穿', match: (action) => action.startsWith('tryon.') },
  { key: 'other', label: '其他', match: (action) => /^(promo|praise|setting|station|audit)\./.test(action) },
];

/** 日誌分類只按 action prefix 篩選，唔會因商品名或詳情文字誤歸類。 */
export function filterAuditRowsByAction<T extends { action: string }>(
  rows: readonly T[],
  filterKey: string,
): T[] {
  const active = AUDIT_FILTERS.find((filter) => filter.key === filterKey) ?? AUDIT_FILTERS[0]!;
  return rows.filter((row) => active.match(row.action));
}
