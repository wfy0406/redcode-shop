import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';

/** trpc orders.adminList 回傳嘅訂單（含 user / items / proofs，superjson 已還原 Date） */
type RouterOutputs = inferRouterOutputs<AppRouter>;

export type AdminOrder = RouterOutputs['orders']['adminList'][number];
export type AdminProof = AdminOrder['proofs'][number];
export type OrderStatus = AdminOrder['status'];
export type ProofStatus = AdminProof['status'];

export type ReviewHandler = (
  proofId: number,
  approve: boolean,
  note: string | undefined,
  order: AdminOrder,
) => void;

// F-D：新流程 approved → shipped（進行出貨＝完成終態），移除 completed 寫入
export type StatusHandler = (orderId: number, status: 'shipped' | 'cancelled') => void;
