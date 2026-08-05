import type { OrderStatus } from "@/components/admin/types";

/**
 * 訂單狀態中文標籤＋淺色 badge 樣式（後台會員管理嘅最近訂單列表用）。
 * 狀態集合同 db/schema.ts orderStatusEnum 一致；
 * label 語義對齊 admin/statusMeta.ts（completed 係 legacy 值，顯示層映射去「進行出貨」）。
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "待付款",
  payment_review: "審核中",
  approved: "已確認",
  rejected: "已拒絕",
  shipped: "進行出貨",
  completed: "進行出貨",
  cancelled: "已取消",
};

/** 各狀態嘅 pill badge class（Tailwind 淺色系，配 MemberList 嘅石色設計） */
export const ORDER_STATUS_BADGE: Record<OrderStatus, string> = {
  pending_payment: "bg-amber-100 text-amber-700",
  payment_review: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  shipped: "bg-emerald-100 text-emerald-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-stone-200 text-stone-500",
};
