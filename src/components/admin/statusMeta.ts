/**
 * 訂單狀態 metadata（label + 顏色）——StatusBadge、Orders、Members 共用。
 * 用 CSS var 色，唔好用實色 class，深淺色主題都啱。
 */

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: '待付款',
  payment_review: '審核中',
  approved: '已確認',
  rejected: '已退回',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
};

export const ORDER_STATUS_COLORS: Record<string, string> = {
  pending_payment: 'var(--gold)',
  payment_review: 'var(--lavender)',
  approved: 'var(--success)',
  rejected: 'var(--pink)',
  shipped: 'var(--gold)',
  completed: 'var(--success)',
  cancelled: 'var(--txt-3)',
};

/** 狀態篩選 pills（「全部」+ 七個狀態） */
export const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  ...Object.entries(ORDER_STATUS_LABELS).map(([key, label]) => ({ key, label })),
];

/**
 * 付款渠道 metadata（2026-09 Airwallex 網上付款）：
 * 'manual'＝手動過數（上傳截圖，舊有全部訂單自動係呢個）
 * 'airwallex'＝Airwallex 網上已付款
 */
export type PaymentChannel = 'manual' | 'airwallex';

export const PAYMENT_CHANNEL_LABELS: Record<PaymentChannel, string> = {
  manual: '手動過數（截圖）',
  airwallex: 'Airwallex 網上已付款',
};
