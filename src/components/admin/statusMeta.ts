import type { OrderStatus } from './types';

/** 訂單狀態顯示設定（§P8 色碼延伸；語義色只行 粉→紫→金→薄荷綠 四線） */
export interface StatusMeta {
  label: string;
  className: string;
  dot?: string; // 狀態點顏色（CSS 色值）
}

export const ORDER_STATUS_META: Record<OrderStatus, StatusMeta> = {
  pending_payment: {
    label: '待付款',
    className: 'border-lavender/50 text-lavender',
    dot: 'var(--lavender)',
  },
  payment_review: {
    label: '審核中',
    className: 'border-gold/70 text-gold',
    dot: 'var(--gold)',
  },
  approved: {
    label: '已確認',
    className: 'border-success/60 text-success',
    dot: 'var(--success)',
  },
  rejected: {
    label: '已拒絕',
    className: 'border-pink/70 text-pink-soft',
    dot: 'var(--pink-soft)',
  },
  // F-D：shipped＝進行出貨（完成終態）；completed 係 legacy 值，顯示層映射去同一終態
  shipped: {
    label: '進行出貨',
    className: 'border-success bg-success text-space-1 font-bold',
  },
  completed: {
    label: '進行出貨',
    className: 'border-success bg-success text-space-1 font-bold',
  },
  cancelled: {
    label: '已取消',
    className: 'border-space-line text-txt-3',
    dot: 'var(--text-3)',
  },
};

export const STATUS_FILTERS: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending_payment', label: '待付款' },
  { key: 'payment_review', label: '審核中' },
  { key: 'approved', label: '已確認' },
  { key: 'rejected', label: '已拒絕' },
  // F-D：進行出貨＝完成終態；legacy completed 歸入「全部」（badge 同樣顯示進行出貨）
  { key: 'shipped', label: '進行出貨' },
  { key: 'cancelled', label: '取消' },
];
