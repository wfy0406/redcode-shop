/**
 * Web Design 前台／後台 tRPC facade（2026-11-09 凍結契約）
 *
 * 背景：backend agent 同步實作 `api/webDesign*.ts`；喺 AppRouter 型別正式包含
 * `webDesign` 之前，呢個 module 用凍結 DTO 型別包住 `trpc.webDesign.*`，
 * 唔用 any——backend 回嚟 lead 會逐項核對呢度嘅型別。
 * Runtime 路徑同最終一致：`trpc.webDesign.getCatalog.useQuery()` 等。
 */
import { trpc } from '@/providers/trpc';
import type { WebDesignCatalog, WebDesignPlan, WebDesignBilling } from '@contracts/webDesign';

/* ===== 凍結 DTO（同 lead 2026-11-09 訊息逐項對齊） ===== */

export type WdOrderStatus = 'received' | 'in_production' | 'completed' | 'cancelled';
export type WdPaymentStatus = 'pending' | 'review' | 'paid' | 'rejected';

export interface WdOrderItemDto {
  itemKey: string;
  name: string;
  plan: WebDesignPlan;
  billing: WebDesignBilling;
  price: number;
  marketPrice: number;
}

export interface WdOrderDto {
  orderNo: string;
  plan: WebDesignPlan;
  status: WdOrderStatus;
  paymentStatus: WdPaymentStatus;
  oneOffTotal: number;
  monthlyTotal: number;
  total: number;
  orderImagePath: string | null;
  items: WdOrderItemDto[];
  createdAt: string; // ISO
}

export interface WdCreateOrderInput {
  plan: WebDesignPlan;
  itemKeys: string[];
  name: string;
  phone: string;
  email?: string;
  requirements: string;
  styleNotes: string;
}

export interface WdCreateOrderResult {
  orderNo: string;
  oneOffTotal: number;
  monthlyTotal: number;
  total: number;
  /** 成功落單必有正式訂單圖；server 產圖失敗會整張單報失敗，唔會回成功＋null。 */
  orderImagePath: string;
}

export interface WdCreatePaymentInput {
  orderNo: string;
  name: string;
  phone: string;
}

/**
 * 2026-11-09 lead 凍結 exact shape：
 * 成功 { enabled:true, intentId, clientSecret, env, currency, returnUrl, orderNo, amount }
 * 未啟用 { enabled:false, message }
 * 成功 variant 結構上包含 AirwallexCheckoutParams 全部欄位，可直接餵 redirectToAirwallexCheckout。
 */
export type WdCreatePaymentResult =
  | {
      enabled: true;
      intentId: string;
      clientSecret: string;
      env: 'demo' | 'prod';
      currency: string;
      returnUrl: string;
      orderNo: string;
      amount: number;
    }
  | { enabled: false; message: string };

export interface WdLookupInput {
  name: string;
  phone: string;
}

export interface WdLookupResult {
  found: boolean;
  orders: WdOrderDto[];
}

export interface WdInquiryInput {
  name: string;
  phone: string;
  email: string;
  message: string;
}

export interface WdAttachProofInput {
  orderNo: string;
  name: string;
  phone: string;
  imagePath: string;
}

/* ===== Admin DTO ===== */

export interface WdProofDto {
  id: number;
  imagePath: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  createdAt: string;
}

export interface WdAdminOrderDto extends WdOrderDto {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  requirements: string;
  styleNotes: string;
  wmsStatus: string | null;
  wmsError: string | null;
  wmsWebhookOrderId: string | null;
  proofs: WdProofDto[];
}

export interface WdInquiryDto {
  id: number;
  name: string;
  phone: string;
  email: string;
  message: string;
  /** backend 用 status，冇 handled boolean */
  status: 'new' | 'handled';
  emailSent: boolean;
  handledBy: string | null;
  handledAt: string | null;
  createdAt: string;
}

/* ===== 窄型 hook 簽名（mock 最少的 react-query 介面） ===== */

interface QueryResult<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => Promise<unknown>;
}

type QueryHook<TData> = (input?: undefined, opts?: { staleTime?: number }) => QueryResult<TData>;

interface MutationResult<TInput, TData> {
  mutate: (input: TInput) => void;
  mutateAsync: (input: TInput) => Promise<TData>;
  isPending: boolean;
  error: { message: string } | null;
}

type MutationHook<TInput, TData> = (opts?: {
  onSuccess?: (data: TData, variables: TInput) => void;
  onError?: (err: { message: string }) => void;
}) => MutationResult<TInput, TData>;

interface WdRouterShape {
  getCatalog: { useQuery: QueryHook<WebDesignCatalog> };
  createOrder: { useMutation: MutationHook<WdCreateOrderInput, WdCreateOrderResult> };
  createPayment: { useMutation: MutationHook<WdCreatePaymentInput, WdCreatePaymentResult> };
  lookup: { useMutation: MutationHook<WdLookupInput, WdLookupResult> };
  submitInquiry: {
    useMutation: MutationHook<
      WdInquiryInput,
      { ok: true; saved: true; inquiryId: number; emailSent: boolean; note?: string }
    >;
  };
  attachProof: { useMutation: MutationHook<WdAttachProofInput, { ok: boolean }> };
  adminCatalog: { useQuery: QueryHook<WebDesignCatalog> };
  /** backend input 係 { catalog }，唔係直接 catalog */
  setCatalog: { useMutation: MutationHook<{ catalog: WebDesignCatalog }, { ok: boolean }> };
  adminOrders: { useQuery: QueryHook<WdAdminOrderDto[]> };
  reviewProof: {
    useMutation: MutationHook<
      { proofId: number; decision: 'approve' | 'reject'; note?: string },
      {
        ok: true;
        orderNo: string;
        decision: 'approve' | 'reject';
        wms: { status: 'sent' | 'failed' | 'disabled'; error: string | null } | null;
      }
    >;
  };
  /** backend input 係 { orderNo }，唔係 orderId */
  retryWms: {
    useMutation: MutationHook<
      { orderNo: string },
      {
        ok: true;
        orderNo: string;
        wms: { status: 'sent' | 'failed' | 'disabled'; error: string | null };
      }
    >;
  };
  adminInquiries: { useQuery: QueryHook<WdInquiryDto[]> };
  markInquiryHandled: { useMutation: MutationHook<{ id: number }, { ok: boolean }> };
}

/** AppRouter 型別落地前嘅窄 cast——runtime 永遠係 trpc.webDesign.* */
export const wdApi = (trpc as unknown as { webDesign: WdRouterShape }).webDesign;

/** admin 操作用嘅 invalidate 助手（等價 trpc.useUtils().webDesign.*） */
export function useWdUtils(): Record<string, { invalidate: () => Promise<unknown> }> {
  const utils = trpc.useUtils();
  return (utils as unknown as { webDesign: Record<string, { invalidate: () => Promise<unknown> }> })
    .webDesign;
}

/* ===== 付款截圖上傳（tokenless 三欄核實，server 驗 orderNo+name+phone） ===== */

export async function uploadWdProof(input: {
  orderNo: string;
  name: string;
  phone: string;
  file: File;
}): Promise<string> {
  const form = new FormData();
  form.append('orderNo', input.orderNo);
  form.append('name', input.name);
  form.append('phone', input.phone);
  form.append('file', input.file);
  const res = await fetch('/api/web-design/upload', { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !data.path) {
    throw new Error(data.error ?? '上傳失敗，請再試一次');
  }
  return data.path;
}
