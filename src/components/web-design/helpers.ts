/**
 * Web Design 前台共用 helpers：金額格式、購物車計數、狀態標籤。
 * 計價只係顯示用途——server createOrder 會用 DB catalog 重新計價（唔信 browser）。
 */
import {
  planAllows,
  discountPercent,
  type WebDesignCatalog,
  type WebDesignCatalogItem,
  type WebDesignPlan,
} from '@contracts/webDesign';
import type { WdOrderStatus, WdPaymentStatus } from './api';

export const fmtHKD = (n: number): string =>
  `HK$${Math.round(n).toLocaleString('en-HK', { maximumFractionDigits: 0 })}`;

/** 慳幾多（市場價 − RedCode 價） */
export const savings = (price: number, marketPrice: number): number =>
  Math.max(0, marketPrice - price);

/** 幾多折，例如 28 → 「2.8 折」；100 → 「原價」 */
export const discountLabel = (price: number, marketPrice: number): string => {
  if (marketPrice <= 0) return '實報實銷';
  const pct = discountPercent(price, marketPrice);
  if (pct >= 100) return '原價';
  return `${(pct / 10).toFixed(1)} 折`;
};

export const billingLabel = (billing: WebDesignCatalogItem['billing']): string =>
  billing === 'monthly' ? '每月' : billing === 'at_cost' ? '實報實銷' : '一次性';

export interface CartTotals {
  /** 一次性：方案基本價 + 所有 one_off 項目 */
  oneOff: number;
  /** 月費項目每月合計 */
  monthly: number;
  /** 今次應付 = 一次性 + 首月月費 */
  dueNow: number;
  /** 已計入嘅可選項目 */
  items: WebDesignCatalogItem[];
}

/**
 * 購物車計數：plan 必選；full_stack-only 項目喺 front_only 底下會被忽略
 * （UI 已擋，呢度係第二重保險；server 仲會再擋同重新計價）。
 */
export function computeCart(
  catalog: WebDesignCatalog,
  plan: WebDesignPlan | null,
  itemKeys: ReadonlySet<string>,
): CartTotals {
  const items = catalog.items.filter(
    (it) => it.active && it.selectable && itemKeys.has(it.key) && plan && planAllows(plan, it.requiredPlan),
  );
  const oneOffItems = items.filter((it) => it.billing === 'one_off');
  const monthlyItems = items.filter((it) => it.billing === 'monthly');
  const base = plan === 'full_stack' ? catalog.fullStackPrice : plan === 'front_only' ? catalog.frontOnlyPrice : 0;
  const oneOff = base + oneOffItems.reduce((s, it) => s + it.price, 0);
  const monthly = monthlyItems.reduce((s, it) => s + it.price, 0);
  return { oneOff, monthly, dueNow: oneOff + monthly, items };
}

export const ORDER_STATUS_LABEL: Record<WdOrderStatus, string> = {
  received: '已收單',
  in_production: '製作中',
  completed: '網站已完成',
  cancelled: '已取消',
};

export const PAYMENT_STATUS_LABEL: Record<WdPaymentStatus, string> = {
  pending: '待付款',
  review: '付款待確認',
  paid: '已付款',
  rejected: '付款被拒',
};

export const orderStatusLabel = (s: string): string =>
  ORDER_STATUS_LABEL[s as WdOrderStatus] ?? s;
export const paymentStatusLabel = (s: string): string =>
  PAYMENT_STATUS_LABEL[s as WdPaymentStatus] ?? s;

/** 姓名+電話基本核驗（server 會再驗） */
export const isNonEmpty = (s: string): boolean => s.trim().length > 0;
export const looksLikePhone = (s: string): boolean => /^[+\d][\d\s-]{5,19}$/.test(s.trim());
export const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
