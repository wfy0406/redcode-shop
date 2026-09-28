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

/**
 * 付款渠道顯示 label（2026-09 Airwallex 網上付款）：
 * 唔係新訂單狀態——airwallex 單收款後照舊行 payment_review 流程，淨係多個渠道標記。
 * manual＝手動過數上傳截圖；airwallex＝Airwallex 網上付款（webhook 已確認收款）。
 */
export const PAYMENT_CHANNEL_LABELS: Record<'airwallex' | 'manual', string> = {
  airwallex: 'Airwallex 網上付款',
  manual: '手動過數',
};

/** 付款渠道 key（order.paymentChannel 嘅已知值；未知值顯示層 fallback 原字串） */
export type PaymentChannel = keyof typeof PAYMENT_CHANNEL_LABELS;

/**
 * 退款狀態（2026-09 F7 WMS↔官網原路退款）：
 * none＝冇退款；pending＝員工已申請、WMS 主管審批中；refunded＝Airwallex 原路已退；
 * manual＝手動過數單，同事人手退款；rejected＝主管拒絕；failed＝Airwallex 退款失敗（可重試）。
 */
export type RefundStatus = 'none' | 'pending' | 'refunded' | 'manual' | 'rejected' | 'failed';

/**
 * 退款狀態顯示設定（跟 PAYMENT_CHANNEL_LABELS 風格；色調跟 ORDER_STATUS_META 語義色）。
 * 'none' 唔使顯示，所以唔喺度；rejected 後台先見到（客人側唔顯示）。
 */
export const REFUND_STATUS_META: Record<Exclude<RefundStatus, 'none'>, StatusMeta> = {
  pending: {
    label: '⏳ 退款審批中',
    className: 'border-gold/70 text-gold',
    dot: 'var(--gold)',
  },
  refunded: {
    label: '已退款',
    className: 'border-space-line text-txt-3',
    dot: 'var(--text-3)',
  },
  manual: {
    label: '人手退款',
    className: 'border-space-line text-txt-3',
    dot: 'var(--text-3)',
  },
  rejected: {
    label: '退款已拒絕',
    className: 'border-lavender/50 text-lavender',
    dot: 'var(--lavender)',
  },
  failed: {
    label: '退款失敗',
    className: 'border-pink/70 text-pink-soft',
    dot: 'var(--pink-soft)',
  },
};

/**
 * 退款狀態 lookup（order.refundStatus 喺 DB 係 varchar → TS 推斷做 string）：
 * 未知值／'none' 回 undefined，顯示層就唔 render badge，唔會冧。
 */
export function refundStatusMeta(status: string): StatusMeta | undefined {
  return (REFUND_STATUS_META as Record<string, StatusMeta>)[status];
}

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
