/**
 * 訪客查單結果卡（2026-10-09 訪客購買）—— GuestPayment 頁同 MyOrders 查單區共用。
 * 結構跟 order-lookup.md §3：單號＋落單時間 → 狀態 badge → 商品清單 → 取貨方式 →
 * 總計 →（未付款）倒數＋立即付款；（已逾時）耷低頭 Glo＋重新落單。
 * 付款：createGuestPayment → redirectToAirwallexCheckout（官方 SDK 跳 HPP）。
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { redirectToAirwallexCheckout } from '@/lib/airwallexCheckout';
import { addToGuestCart } from '@/lib/guestCart';
import { CopyButton, MeteorProgressBar } from '@/components/shop/form-bits';
import GuestCountdown, { useGuestCountdown } from '@/components/shop/GuestCountdown';
import ClaimGuestOrderModal from '@/components/shop/ClaimGuestOrderModal';
import { formatHKD } from '@/components/cart/format';
import ShipmentSection, { ItemShipChips, batchMethodMap } from '@/components/orders/ShipmentInfo';

const WHATSAPP_URL = 'https://wa.me/85254835368';

/** 同 api/ordersRouter.ts guestOrderPayload 對齊（tRPC 推斷型別嘅手寫镜像） */
export interface GuestOrderPayload {
  orderNo: string;
  status: string;
  total: number;
  items: {
    /** v2.4.0（Wave 2）：orderItem id（出貨批次對照用） */
    id?: number;
    productId: number;
    productName: string;
    size: string | null;
    price: number;
    quantity: number;
    /** v2.4.0（Wave 2）：逐件出貨狀態／取消原因／員工更改 */
    shipStatus?: string;
    cancelReason?: string | null;
    /** v2.5.4：同款多件部分取消 — 已取消件數 */
    cancelledQty?: number | null;
    staffChangedAt?: string | null;
    staffChangeNote?: string | null;
  }[];
  /** v2.4.0（Wave 2）：出貨批次（順豐單號／寄出時間；已作廢批次 server 已滤走） */
  shipments?: {
    id: number;
    shipMethod: string;
    sfNo: string | null;
    itemIds: number[];
    shippedAt: string;
  }[];
  deliveryMethod: string | null;
  address: string | null;
  stationName: string | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  secondsLeft: number;
  canPay: boolean;
  guestToken?: string | null;
}

/* ---------- 狀態 badge（order-lookup.md §3.1） ---------- */
function StatusBadge({ status, secondsLeft }: { status: string; secondsLeft: number }) {
  let label = '已取消';
  let color = 'var(--text-3, #8D82B3)';
  let border = 'var(--space-line)';
  let bg = 'transparent';
  if (status === 'pending_payment' && secondsLeft > 0) {
    label = '等待付款';
    color = 'var(--gold)';
    border = 'rgba(245,197,24,0.45)';
    bg = 'rgba(245,197,24,0.08)';
  } else if (status === 'pending_payment') {
    label = '已逾時';
    color = 'var(--text-3, #8D82B3)';
    bg = 'var(--space-2)';
  } else if (status === 'payment_review' || status === 'approved') {
    label = '已付款，準備緊';
    color = 'var(--success)';
    border = 'rgba(94,224,160,0.35)';
    bg = 'rgba(94,224,160,0.08)';
  } else if (status === 'shipped') {
    label = '已寄出';
    color = 'var(--success)';
    border = 'rgba(94,224,160,0.35)';
    bg = 'rgba(94,224,160,0.08)';
  } else if (status === 'completed') {
    label = '已完成';
    color = 'var(--text-2, #C7BEE0)';
    border = 'var(--glass-border)';
  }
  return (
    <span
      className="inline-block rounded-full px-3 py-1 text-[12px] font-semibold"
      style={{ color, border: `1px solid ${border}`, background: bg }}
    >
      {label}
    </span>
  );
}

function deliveryText(o: GuestOrderPayload): string {
  if (o.deliveryMethod === 'address') return `送貨上門：${o.address ?? '—'}`;
  const kind = o.deliveryMethod === 'sf_locker' ? '智能櫃' : '順豐站／自提點';
  return `${kind}：${o.stationName ?? '—'}`;
}

export default function GuestOrderCard({
  order,
  guestToken,
  onExpire,
  focusRef,
  countdownVariant = 'inline',
  autoOpenClaim = false,
  onClaimed,
}: {
  order: GuestOrderPayload;
  /** 付款用：guestLookup（電話核實）先會返；guestByToken 路徑由 caller 裝返 URL token 入嚟 */
  guestToken: string | null;
  onExpire?: () => void;
  focusRef?: React.RefObject<HTMLDivElement | null>;
  /** hero＝特大倒數做主角（GuestPayment 付款頁）；inline＝行內圓環（MyOrders 查單區） */
  countdownVariant?: 'inline' | 'hero';
  /** URL 帶 claim=1（登入完返嚟）：已登入就自動彈「移入會員訂單」確認框 */
  autoOpenClaim?: boolean;
  /** 成功移入後 callback（caller 清 params／refetch） */
  onClaimed?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [restocked, setRestocked] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const claimAutoFired = useRef(false);
  const createGuestPayment = trpc.airwallex.createGuestPayment.useMutation();

  // 登入完帶 claim=1 返嚟：自動彈確認框（問「是否將該訪客訂單移入至你的會員旗下？」）
  useEffect(() => {
    if (autoOpenClaim && user && guestToken && !claimAutoFired.current) {
      claimAutoFired.current = true;
      setClaimOpen(true);
    }
  }, [autoOpenClaim, user, guestToken]);

  /** 撳「移入會員訂單」：已登入直接彈框；未登入先去登入（返嚟 URL 帶 claim=1 自動彈） */
  const onClaimClick = () => {
    if (!guestToken) return;
    if (user) {
      setClaimOpen(true);
      return;
    }
    const sp = new URLSearchParams(location.search);
    sp.set('claim', '1');
    void navigate('/login', { state: { from: `${location.pathname}?${sp.toString()}` } });
  };

  const secondsLeft = useGuestCountdown(order.secondsLeft, onExpire);
  const isPending = order.status === 'pending_payment';
  const expired = isPending && secondsLeft <= 0;
  // v2.4.0（Wave 2）：批次 → 物流方式對照（逐件 chip 分辨「儲貨中」用）
  const shipMethodMap = batchMethodMap(order.shipments ?? []);

  const pay = async () => {
    if (!guestToken || paying) return;
    setPayError(null);
    setPaying(true);
    try {
      const result = await createGuestPayment.mutateAsync({ orderNo: order.orderNo, guestToken });
      if (!result.enabled) {
        setPayError('即時付款暫時未能使用');
        setPaying(false);
        return;
      }
      // full-page 跳轉去 Airwallex HPP；成功之後 promise 正常唔會再行
      await redirectToAirwallexCheckout(result);
    } catch (e) {
      setPaying(false);
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('保留期')) setPayError('付款保留期已過，請重新落單');
      else setPayError('網絡唔穩定，請再試一次');
    }
  };

  /** 已逾時 → 將原單貨品倒返落訪客購物車，直接去購物車重買（order-lookup.md §4.2「cart 重灌為佳」） */
  const restock = () => {
    for (const it of order.items) {
      if (it.productId > 0) addToGuestCart(it.productId, it.size ?? null, it.quantity);
    }
    setRestocked(true);
    window.setTimeout(() => void navigate('/cart'), 350);
  };

  const createdDate = new Date(order.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const createdLabel = `${createdDate.getFullYear()}-${pad(createdDate.getMonth() + 1)}-${pad(createdDate.getDate())} ${pad(createdDate.getHours())}:${pad(createdDate.getMinutes())}`;

  return (
    <div
      ref={focusRef}
      tabIndex={focusRef ? -1 : undefined}
      aria-live="polite"
      aria-label={`訂單 ${order.orderNo} 詳情`}
      className="w-full rounded-2xl border p-6"
      style={{
        background: 'var(--glass-bg-strong)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderColor: expired ? 'var(--space-line)' : 'var(--glass-border)',
        animation: 'promo-fade-in .2s ease-out',
      }}
    >
      {/* 頂行：單號＋訪客標示＋落單時間 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-[15px] font-bold tracking-wider text-gold">{order.orderNo}</span>
        <span
          className="rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide"
          style={{ color: 'var(--lavender)', borderColor: 'rgba(186,166,255,0.45)', background: 'rgba(186,166,255,0.08)' }}
        >
          訪客單
        </span>
        <CopyButton text={order.orderNo} label="複製訂單編號" />
        <span className="ml-auto text-[12px] text-txt-3">{createdLabel}</span>
      </div>
      <div className="mt-3">
        <StatusBadge status={order.status} secondsLeft={secondsLeft} />
      </div>

      <div className="my-4 h-px" style={{ background: 'var(--space-line)' }} aria-hidden="true" />

      {/* 商品清單（唯讀；v2.4.0 Wave 2：逐件出貨狀態／取消原因／員工更改 chip） */}
      <ul className="flex flex-col gap-2.5">
        {order.items.map((it, i) => {
          const cancelled = it.shipStatus === 'cancelled';
          return (
            <li key={`${it.productId}-${it.size ?? ''}-${i}`} className="text-[14px]">
              <div className="flex items-baseline gap-2">
                <span className={`min-w-0 flex-1 truncate ${cancelled ? 'text-txt-3 line-through' : 'text-txt-1'}`}>
                  {it.productName}
                </span>
                {it.size && <span className="shrink-0 font-mono text-[12px] text-txt-3">{it.size}</span>}
                <span className="shrink-0 text-txt-3">×{it.quantity}</span>
                <span className={`shrink-0 font-mono tabular-nums ${cancelled ? 'text-txt-3 line-through' : 'text-txt-2'}`}>
                  {formatHKD(it.price * it.quantity)}
                </span>
              </div>
              <ItemShipChips
                item={it}
                showPending={order.status === 'approved' || order.status === 'shipped'}
                methodMap={shipMethodMap}
              />
            </li>
          );
        })}
      </ul>

      {/* 取貨方式 */}
      <p className="mt-3 text-[13px] text-txt-3">{deliveryText(order)}</p>

      {/* v2.4.0（Wave 2）：出貨批次（順豐單號＋追蹤連結＋2–10h 提示；面交/自取/儲貨文案） */}
      {order.shipments && order.shipments.length > 0 && (
        <ShipmentSection shipments={order.shipments} items={order.items} />
      )}

      {/* 總計 */}
      <div className="mt-4 flex items-baseline justify-between">
        <span className="font-serif-tc text-lg font-semibold text-txt-1">總計</span>
        <span className="font-mono text-2xl tabular-nums text-pink">{formatHKD(order.total)}</span>
      </div>

      {/* 未付款＋未過期：倒數＋立即付款 */}
      {isPending && !expired && (
        <div className="mt-5 flex flex-col gap-4">
          {countdownVariant === 'hero' ? (
            <div className="pt-1">
              <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-[0.28em] text-txt-3">
                留貨倒數
              </p>
              <GuestCountdown secondsLeft={secondsLeft} variant="hero" />
              <p className="mt-4 text-center text-[13px] text-txt-3">
                仲有留貨時間，過咗就要重新落單啦
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <GuestCountdown secondsLeft={secondsLeft} />
              <p className="text-[13px] text-txt-3">
                仲有留貨時間，過咗就要重新落單啦
              </p>
            </div>
          )}
          {order.canPay && guestToken ? (
            <>
              <button type="button" onClick={() => void pay()} disabled={paying} className="btn btn-primary w-full">
                {paying ? '開緊付款頁…' : `立即付款 ${formatHKD(order.total)} →`}
              </button>
              {paying && <MeteorProgressBar text="開緊付款頁，唔好閂…" />}
              <p className="text-center text-[12px] text-txt-3">
                以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準。
              </p>
            </>
          ) : (
            /* 付款未配置（canPay=false）：粉紅邊提示＋WhatsApp（訪客單唔准有上傳單據入口） */
            <div
              className="rounded-xl border p-4 text-center"
              style={{ borderColor: 'rgba(255,0,84,0.45)', background: 'rgba(255,0,84,0.06)' }}
            >
              <p className="text-[13.5px] text-pink-soft">即時付款暫時未能使用，唔使急——</p>
              <a
                href={`${WHATSAPP_URL}?text=${encodeURIComponent(`你好，我嘅訪客訂單 ${order.orderNo} 想付款，但網上付款開唔到。`)}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-whatsapp mt-3 w-full"
              >
                WhatsApp 我哋幫你人手處理 →
              </a>
            </div>
          )}
          {payError && (
            <p role="alert" className="text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
              {payError}
            </p>
          )}
        </div>
      )}

      {/* 已逾時：耷低頭 Glo（靜態）＋重新落單 */}
      {expired && (
        <div className="mt-5 flex flex-col items-center gap-3 text-center">
          <img src="/guest/glo-expired.png" alt="" className="w-20" loading="lazy" />
          <p className="font-serif-tc text-lg font-semibold text-txt-1">呢張單過咗付款時間，庫存已經放返出嚟</p>
          <p className="text-[13.5px] text-txt-2">唔緊要，貨通常仲喺度——重新落單一次就搞掂。</p>
          <button
            type="button"
            onClick={restock}
            disabled={restocked}
            className="w-full rounded-full py-3 font-serif-tc text-[15.5px] font-bold tracking-[0.12em] disabled:opacity-50"
            style={{
              background: 'linear-gradient(160deg, #F7D774 0%, #F5C518 55%, #C99B0F 100%)',
              color: '#241505',
              boxShadow: '0 6px 26px rgba(245,197,24,0.35)',
            }}
          >
            {restocked ? '倒返緊入購物車…' : '重新落單'}
          </button>
          <a
            href={`${WHATSAPP_URL}?text=${encodeURIComponent(`你好，我嘅訪客訂單 ${order.orderNo} 過咗付款時間，想問下重複落單嘅安排。`)}`}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] text-txt-3 underline underline-offset-4 transition-colors hover:text-txt-1"
          >
            WhatsApp 問下先
          </a>
        </div>
      )}

      {/* 已付款確認行 */}
      {!isPending && order.status !== 'cancelled' && (
        <p className="mt-4 text-center text-[13px] text-txt-3">
          確認信已經寄咗去你 email，出貨進度隨時返嚟呢度查。
        </p>
      )}
      {order.status === 'cancelled' && (
        <p className="mt-4 text-center text-[13px] text-txt-3">
          呢張單已經取消咗。有疑問 WhatsApp 我哋。
        </p>
      )}

      {/* 移入會員訂單（2026-10-09）：有 token 即已核實身份，可以認領呢張訪客單 */}
      {guestToken && (
        <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--space-line)' }}>
          <button
            type="button"
            onClick={onClaimClick}
            className="w-full rounded-full border py-2.5 text-[13.5px] font-medium transition-colors"
            style={{
              color: 'var(--gold)',
              borderColor: 'rgba(245,197,24,0.4)',
              background: 'rgba(245,197,24,0.05)',
            }}
          >
            呢張係你嘅單？移入會員訂單 →
          </button>
          <p className="mt-2 text-center text-[12px] text-txt-3">
            移入後喺「我的訂單」睇晒進度，寄送方式同地址維持不變
          </p>
        </div>
      )}

      {claimOpen && user && guestToken && (
        <ClaimGuestOrderModal
          orderNo={order.orderNo}
          guestToken={guestToken}
          onClose={() => setClaimOpen(false)}
          onClaimed={() => {
            setClaimOpen(false);
            onClaimed?.();
          }}
        />
      )}
    </div>
  );
}
