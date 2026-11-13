// ===== v2026.11.13.1 redcode.red 公開單據頁 — 型別 + normalize + 顯示 helpers =====
// 純邏輯：無 React、無 DOM、無副作用，vitest node 環境直接測。
// 口徑跟 WMS `src/pages/webDesignBill.ts`（v2026.11.12.1）一字不變，外加 SPEC §9 新欄位：
//   kind（monthly/project）、publicToken、onlineUrl、notes（text + updatedAt，唔公開操作人）。
// 契約：trpc.webDesignPublicBill.getPublic.useQuery({ token }) → PublicBillView。
// 公開頁唔准顯示內部資料；normalize 會再剥一次 adjustLog.by（操作員名）。

// ---------- 型別 ----------
export interface WDBillItem {
  code?: string | null;
  name: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  // 原價/折扣快照（如有）；純展示，收費/退款永遠以 amountCents（折實價）為準
  origPriceCents?: number;
  discountCents?: number;
}

export interface WDAdjustEntry {
  deltaCents: number;
  reason?: string;
  at?: string | null;
  fromCents?: number;
  toCents?: number;
}

export type WDBillStatus = 'issued' | 'paid' | 'refunded' | 'void';
export type WDBillKind = 'monthly' | 'project';

// 專案單據備註 snapshot（SPEC §4/§5）：公開 text + updatedAt；updatedBy（員工）永遠唔出現
export interface WDBillNote {
  id: string | null;
  text: string;
  updatedAt: string | null;
}

export interface WebDesignPublicBillView {
  billNo: string;
  customerName: string;
  items: WDBillItem[];
  subtotalCents: number;
  adjustCents: number;
  adjustLog: WDAdjustEntry[];
  finalCents: number;
  status: string; // issued | paid | refunded | void
  mode: string; // test | live
  orderDate: string | null;
  sessionNo: string | null;
  createdAt: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  customerPaidCents: number | null;
  refundedAt: string | null;
  refundedCents: number | null; // 累計已退（部份退款會喺已付款狀態下顯示）
  refundStatus: string | null; // 退款異步狀態（processing 時顯示處理中）
  companyName: string | null;
  remark: string | null;
  surchargeOn: boolean | null;
  // 月費單據專屬（SPEC-EXPANSION §4）
  period: string | null; // 'YYYY-MM' 香港帳期（專案單係 null）
  projectTitle: string | null;
  // SPEC §9 新增
  kind: WDBillKind; // 舊資料缺 kind = monthly
  publicToken: string | null;
  onlineUrl: string | null; // 後端保證 https://redcode.red/web-design-bill/<token>
  notes: WDBillNote[];
}

// ---------- normalize（同 WMS normalizeWebDesignBill 口徑，加 kind/publicToken/onlineUrl/notes）----------
function parseJsonMaybe<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PUBLIC_BILL_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const DEFAULT_PUBLIC_BASE_URL = 'https://redcode.red';

function normalizeNotes(raw: unknown): WDBillNote[] {
  const arr = parseJsonMaybe<unknown[]>(raw, []);
  if (!Array.isArray(arr)) return [];
  const out: WDBillNote[] = [];
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue;
    const text = String((n as any).text ?? '').trim();
    if (!text) continue;
    const updatedAtRaw = (n as any).updatedAt;
    out.push({
      id: typeof (n as any).id === 'string' && (n as any).id.trim() ? String((n as any).id).trim() : null,
      text,
      updatedAt: typeof updatedAtRaw === 'string' && updatedAtRaw.trim() ? updatedAtRaw : null,
    });
  }
  return out;
}

/**
 * 畫面顯示＋QR payload 唯一來源（SPEC §9 驗收：onlineUrl／QR decode／畫面顯示三者完全相同）。
 * 只接受官方公開 origin（redcode.red）嘅 onlineUrl；任何其他 origin（包括 WMS 內部域名、
 * evil.example 之類）一律唔信，直接用官方 base＋publicToken 重砌 canonical。
 * 舊後端未返嗰陣用 token 本地補返（舊 token 兼容，唔會整斷已發出單據）。
 */
export function resolveBillOnlineUrl(onlineUrl: string | null | undefined, publicToken: string | null | undefined): string | null {
  const token = typeof publicToken === 'string' && PUBLIC_BILL_TOKEN_RE.test(publicToken) ? publicToken : null;
  if (!token) return null;
  const canonical = `${DEFAULT_PUBLIC_BASE_URL}/web-design-bill/${token}`;
  if (typeof onlineUrl === 'string' && onlineUrl.trim()) {
    try {
      const url = new URL(onlineUrl.trim());
      const official = url.origin === DEFAULT_PUBLIC_BASE_URL;
      const pathOk = url.pathname === `/web-design-bill/${token}` && !url.search && !url.hash;
      if (official && pathOk) return canonical;
    } catch {
      /* fallthrough 去 canonical */
    }
  }
  return canonical;
}

export function normalizeWebDesignPublicBill(raw: any): WebDesignPublicBillView | null {
  if (!raw) return null;
  // 巢狀形狀兼容：{ bill, items, mode, surchargeOn } → 拍平；欄位名兼容 camelCase / snake_case
  const b: any = raw.bill && typeof raw.bill === 'object' ? { ...raw.bill, ...raw, bill: undefined } : raw;
  const billNo = b.billNo ?? b.bill_no;
  const finalCents = b.finalCents ?? b.final_cents;
  if (!billNo || typeof finalCents !== 'number') return null;
  const itemsRaw = parseJsonMaybe<any[]>(b.items ?? b.items_json ?? b.itemsJson, []);
  const items: WDBillItem[] = (Array.isArray(itemsRaw) ? itemsRaw : []).map((it: any) => ({
    code: it.code ?? null,
    name: String(it.name ?? ''),
    qty: Number(it.qty ?? 0),
    unitPriceCents: Number(it.unitPriceCents ?? it.unit_price_cents ?? 0),
    amountCents: Number(it.amountCents ?? it.amount_cents ?? 0),
    origPriceCents:
      it.origPriceCents != null ? Number(it.origPriceCents) : it.orig_price_cents != null ? Number(it.orig_price_cents) : undefined,
    discountCents:
      it.discountCents != null ? Number(it.discountCents) : it.discount_cents != null ? Number(it.discount_cents) : undefined,
  }));
  const periodRaw = b.period ?? null;
  const publicTokenRaw = b.publicToken ?? b.public_token ?? null;
  const publicToken =
    typeof publicTokenRaw === 'string' && PUBLIC_BILL_TOKEN_RE.test(publicTokenRaw.trim()) ? publicTokenRaw.trim() : null;
  return {
    billNo: String(billNo),
    customerName: String(b.customerName ?? b.customer_name ?? ''),
    items,
    subtotalCents: Number(b.subtotalCents ?? b.subtotal_cents ?? finalCents),
    adjustCents: Number(b.adjustCents ?? b.adjust_cents ?? 0),
    // 雙保險：就算上游漏咗操作員名（by），公開頁都唔會有
    adjustLog: parseJsonMaybe<any[]>(b.adjustLog ?? b.adjust_log, []).map((a: any) => {
      const { by: _by, updatedBy: _updatedBy, ...entry } = a ?? {};
      return entry as WDAdjustEntry;
    }),
    finalCents,
    status: String(b.status ?? 'issued'),
    mode: String(b.mode ?? raw.mode ?? 'live'),
    orderDate: b.orderDate ?? b.order_date ?? null,
    sessionNo: b.sessionNo ?? b.session_no ?? null,
    createdAt: b.createdAt ?? b.created_at ?? null,
    paidAt: b.paidAt ?? b.paid_at ?? null,
    paymentMethod: b.paymentMethod ?? b.payment_method ?? null,
    customerPaidCents: b.customerPaidCents ?? b.customer_paid_cents ?? null,
    refundedAt: b.refundedAt ?? b.refunded_at ?? null,
    refundedCents: b.refundedCents ?? b.refunded_cents ?? null,
    refundStatus: b.refundStatus ?? b.refund_status ?? null,
    companyName: b.companyName ?? b.company_name ?? null,
    remark: b.remark ?? null,
    surchargeOn:
      typeof (b.surchargeOn ?? b.surcharge_on) === 'boolean' ? (b.surchargeOn ?? b.surcharge_on) : null,
    period: typeof periodRaw === 'string' && periodRaw.trim() ? periodRaw.trim() : null,
    projectTitle:
      typeof (b.projectTitle ?? b.project_title) === 'string' && (b.projectTitle ?? b.project_title).trim()
        ? String(b.projectTitle ?? b.project_title).trim()
        : null,
    kind: b.kind === 'project' ? 'project' : 'monthly',
    publicToken,
    onlineUrl: resolveBillOnlineUrl(b.onlineUrl ?? b.online_url ?? null, publicToken),
    notes: normalizeNotes(b.notes),
  };
}

// ---------- 標題（SPEC §5：project 用專案服務單據；monthly 保留原標題）----------
export function billTitles(kind: WDBillKind): { zh: string; en: string } {
  return kind === 'project'
    ? { zh: '專案服務單據', en: 'PROJECT SERVICE STATEMENT' }
    : { zh: '月費服務單據', en: 'MONTHLY SERVICE STATEMENT' };
}

// ---------- 格式化 ----------
export function fmtHKD(cents: number | null | undefined): string {
  const n = typeof cents === 'number' && Number.isFinite(cents) ? cents : 0;
  return 'HK$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ISO → YYYY年M月D日 HH:MM（同 BillPage 口徑）
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 帳期 'YYYY-MM' → 'YYYY年M月'；唔合法就原样返（唔靜默吞）
export function fmtPeriod(period: string | null | undefined): string {
  if (!period) return '';
  const p = period.trim();
  if (!PERIOD_RE.test(p)) return p;
  return `${p.slice(0, 4)}年${Number(p.slice(5, 7))}月`;
}

const METHOD_LABEL: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  alipay_hk: 'AlipayHK',
  alipay: 'Alipay',
  wechat_pay: 'WeChat Pay',
  fps: '轉數快',
  unionpay: '銀聯',
};
export function fmtMethod(m: string | null | undefined): string {
  if (!m) return '';
  return METHOD_LABEL[m] ?? m;
}

// 幾折（折實價 ÷ 原價 × 10；整數或 1 位小數）— 同 BillPage 口徑
export function foldLabel(orig: number, unit: number): string {
  if (orig <= 0 || unit <= 0 || orig <= unit) return '';
  const z = Math.round(((unit / orig) * 10) * 10) / 10;
  return `${Number.isInteger(z) ? z : z.toFixed(1)}折`;
}

// 逐行折扣判定：原價 > 折實價 兼 折扣 > 0 先成立；折扣留空就系統自己計（原價−折實價）
// 權威總額永遠係 finalCents（逐行折實價加總），折扣純展示，唔會再扣一次。
export function lineDisc(it: WDBillItem): { has: boolean; isGift: boolean; orig: number; disc: number } {
  const unit = it.unitPriceCents;
  const orig = it.origPriceCents ?? 0;
  let disc = it.discountCents ?? 0;
  if (disc <= 0 && orig > unit && unit >= 0) disc = orig - unit;
  const has = orig > unit && unit >= 0 && disc > 0;
  return { has, isGift: has && unit === 0, orig, disc };
}

// ---------- 狀態 ----------
export function normalizeStatus(status: string | null | undefined): WDBillStatus {
  return status === 'paid' || status === 'refunded' || status === 'void' ? status : 'issued';
}

export interface WDStatusInfo {
  key: WDBillStatus;
  zh: string;
  en: string;
  // live：待付款（cyan 呼吸 node）；done：已付款（cyan 實心 node）；muted：已退款；dead：已作廢
  tone: 'live' | 'done' | 'muted' | 'dead';
}

export function statusInfo(status: string | null | undefined): WDStatusInfo {
  const key = normalizeStatus(status);
  switch (key) {
    case 'paid':
      return { key, zh: '已付款', en: 'PAID', tone: 'done' };
    case 'refunded':
      return { key, zh: '已退款', en: 'REFUNDED', tone: 'muted' };
    case 'void':
      return { key, zh: '已作廢', en: 'VOID', tone: 'dead' };
    default:
      return { key: 'issued', zh: '待付款', en: 'AWAITING PAYMENT', tone: 'live' };
  }
}

// 單據主日期行：paid → 付款日期；refunded → 退款日期；否則開單日期（createdAt 優先，fallback orderDate）
export function primaryDateLine(b: Pick<WebDesignPublicBillView, 'status' | 'paidAt' | 'refundedAt' | 'createdAt' | 'orderDate'>): string {
  const s = normalizeStatus(b.status);
  if (s === 'paid' && b.paidAt) return `付款日期　${fmtDateTime(b.paidAt)}`;
  if (s === 'refunded' && b.refundedAt) return `退款日期　${fmtDateTime(b.refundedAt)}`;
  if (b.createdAt) return `開單日期　${fmtDateTime(b.createdAt)}`;
  if (b.orderDate) return `開單日期　${b.orderDate}`;
  return '';
}

// ---------- meta 區（客戶 / 帳期 / 專案 / 備註 / 訂單日期 / 場次）----------
export function metaRows(b: WebDesignPublicBillView): Array<[string, string]> {
  const rows: Array<[string, string]> = [['客戶', b.customerName]];
  const period = fmtPeriod(b.period);
  if (period) rows.push(['帳期', period]);
  if (b.projectTitle) rows.push(['專案', b.projectTitle]);
  if (b.remark) rows.push(['備註', b.remark]);
  if (b.orderDate) rows.push(['訂單日期', b.orderDate]);
  if (b.sessionNo) rows.push(['場次', `第 ${b.sessionNo} 場`]);
  return rows;
}

// ---------- 合計區 ----------
export interface WDTotalsRow {
  kind: 'orig' | 'disc' | 'sub' | 'adjust' | 'adjustReason' | 'grand' | 'saved';
  label: string;
  value: string;
}

export function discountTotals(items: WDBillItem[]): { orig: number; disc: number } {
  return items.reduce(
    (acc, it) => {
      const q = it.qty > 0 ? it.qty : 1;
      const d = lineDisc(it);
      acc.orig += (d.has ? d.orig : it.unitPriceCents) * q;
      acc.disc += d.has ? d.disc * q : 0;
      return acc;
    },
    { orig: 0, disc: 0 },
  );
}

export function totalsPlan(b: WebDesignPublicBillView): WDTotalsRow[] {
  const rows: WDTotalsRow[] = [];
  const disc = discountTotals(b.items);
  if (disc.disc > 0) {
    rows.push({ kind: 'orig', label: '原價合計', value: fmtHKD(disc.orig) });
    rows.push({ kind: 'disc', label: '折扣優惠', value: `−${fmtHKD(disc.disc)}` });
  }
  rows.push({ kind: 'sub', label: '小計', value: fmtHKD(b.subtotalCents) });
  if (b.adjustCents !== 0 || b.adjustLog.length > 0) {
    rows.push({
      kind: 'adjust',
      label: '調整',
      value: `${b.adjustCents >= 0 ? '+' : '−'}${fmtHKD(Math.abs(b.adjustCents))}`,
    });
    for (const a of b.adjustLog) {
      rows.push({
        kind: 'adjustReason',
        label: '',
        value: `${a.reason || '金額調整'}　(${a.deltaCents >= 0 ? '+' : '−'}${fmtHKD(Math.abs(a.deltaCents))})`,
      });
    }
  }
  rows.push({ kind: 'grand', label: '應付總額', value: fmtHKD(b.finalCents) });
  if (disc.disc > 0) rows.push({ kind: 'saved', label: '', value: `已為你節省 ${fmtHKD(disc.disc)}` });
  return rows;
}

// ---------- 已付款詳情行 ----------
export interface WDPaidLine {
  text: string;
  strong: boolean; // 金額行（實付／已退）
  warn: boolean; // 退款處理中（amber）
}

export function paidDetailLines(b: WebDesignPublicBillView): WDPaidLine[] {
  const lines: WDPaidLine[] = [];
  if (typeof b.customerPaidCents === 'number') {
    lines.push({ text: `實付金額　${fmtHKD(b.customerPaidCents)}`, strong: true, warn: false });
  }
  if (typeof b.refundedCents === 'number' && b.refundedCents > 0) {
    lines.push({ text: `已退款　${fmtHKD(b.refundedCents)}`, strong: true, warn: false });
  }
  if (b.refundStatus === 'processing') {
    lines.push({ text: '退款處理中　（款項將原路退回，一般 1–2 個工作天）', strong: false, warn: true });
  }
  if (b.paymentMethod) lines.push({ text: `付款方式　${fmtMethod(b.paymentMethod)}`, strong: false, warn: false });
  if (b.paidAt) lines.push({ text: `付款時間　${fmtDateTime(b.paidAt)}`, strong: false, warn: false });
  return lines;
}

// ---------- 付款 CTA / 手續費提示 ----------
// issued 且金額有效先顯示付款 CTA（SPEC-EXPANSION §5）
export function canPay(b: Pick<WebDesignPublicBillView, 'status' | 'finalCents'>): boolean {
  return normalizeStatus(b.status) === 'issued' && b.finalCents > 0;
}

// 手續費提示同現有收款單據口徑一致（一字唔准改嘅免責聲明）；
// surchargeOn === false（商戶承擔手續費）時如實改述，唔再話「平台將收取手續費」。
export const SURCHARGE_DISCLAIMER =
  '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準';
export const SURCHARGE_OFF_NOTE = '本單據唔會另收支付平台手續費，單據金額即最終應付金額';

export function surchargeNote(b: Pick<WebDesignPublicBillView, 'surchargeOn'>): string {
  return b.surchargeOn === false ? SURCHARGE_OFF_NOTE : SURCHARGE_DISCLAIMER;
}

// 全額退款說明（同現有口徑）
export const REFUNDED_NOTE = '款項已全額退回，退款手續費由商戶承擔';

// 部份退款判定：已付款狀態下有累計退款
export function isPartialRefund(b: Pick<WebDesignPublicBillView, 'status' | 'refundedCents'>): boolean {
  return normalizeStatus(b.status) === 'paid' && typeof b.refundedCents === 'number' && b.refundedCents > 0;
}

// ---------- 網上單據連結（SPEC §9：畫面顯示＋QR payload 同一來源）----------
/** QR payload＝畫面顯示嘅 onlineUrl；無有效 token 就 null（頁面會 loud 顯示錯誤，唔出假 QR） */
export function qrPayloadForBill(b: Pick<WebDesignPublicBillView, 'onlineUrl'>): string | null {
  return typeof b.onlineUrl === 'string' && b.onlineUrl.trim() ? b.onlineUrl : null;
}
