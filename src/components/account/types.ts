import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** trpc.orders.myOrders 回傳嘅單張訂單（含 items + proofs，Date 已由 superjson 還原） */
export type MyOrder = RouterOutputs['orders']['myOrders'][number];
export type MyOrderItem = MyOrder['items'][number];
export type MyOrderProof = MyOrder['proofs'][number];
export type OrderStatus = MyOrder['status'];

/** HKD 整數價錢格式 */
export function formatHKD(amount: number): string {
  return `HK$${amount.toLocaleString('en-HK')}`;
}

/** 訂單日期格式（zh-HK） */
export function formatOrderDate(date: Date): string {
  return date.toLocaleDateString('zh-HK', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
