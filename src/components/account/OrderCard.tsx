import { useState } from 'react';
import { Link } from 'react-router';
import { Receipt, Ticket } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { redirectToAirwallexCheckout } from '@/lib/airwallexCheckout';
import { normalizeVipTier } from '@/components/VipBadge';
import { vipTierTheme } from '@/lib/vipTheme';
import StatusBadge from './StatusBadge';
import OrderTimeline from './OrderTimeline';
import PaymentProofDropzone from './PaymentProofDropzone';
import ShipmentSection, { ItemShipChips, batchMethodMap } from '@/components/orders/ShipmentInfo';
import { formatHKD, formatOrderDate } from './types';
import type { MyOrder, MyOrderItem } from './types';

/**
 * 會員中心訂單卡（§P8）
 * 玻璃列：DM Mono 單號 + 日期 + 狀態 badge + 商品明細（圖/名/貨號/size/數量/價）
 * + 總計 + 取貨方式（順豐站/智能櫃）+ 金星狀態時間線；待付款／被拒絕訂單附付款資料提示卡 + 截圖上傳 dropzone。
 * 2026-09 F7：待付款單加「💳 即時網上支付」（Airwallex HPP，寫法跟 Payment.tsx）；
 * 退款狀態 badge（審批中／已退款／人手退款／失敗），已退款／人手退款嘅卡整體灰化。
 * v2.1.0（VIP+免運，2026-09-29；Glo：所有單據都要睇到折扣同會員級別）：
 * 狀態 badge 隔籬加 VIP 級別 badge（落單當刻級別 vipTierAtPurchase，普通會員唔出）；
 * 優惠碼折扣行上面加 VIP 折扣行（先 VIP 後 coupon）；取貨位加 免運 ✓／順豐到付 標記。
 */

interface OrderCardProps {
  order: MyOrder;
  /** productId → 商品圖 URL（orderItems 無快照圖，經 products.list 對照） */
  productImages: Record<number, string>;
}

/** 全網統一手續費提示（F7 §1.8 逐字，唔准改） */
const ONLINE_PAYMENT_FEE_NOTE =
  '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準。';

/**
 * 退款狀態 badge（客人側口徑）：'none'／'rejected' 唔顯示；
 * refunded／manual 連同成張卡灰化（同 WMS 灰卡做法呼應）。
 */
const REFUND_BADGES: Record<string, { text: string; className: string }> = {
  pending: { text: '⏳ 退款審批中', className: 'border-gold/70 text-gold' },
  refunded: { text: '❌ 已取消 · 已退款', className: 'border-space-line text-txt-3' },
  manual: { text: '❌ 已取消 · 人手退款處理中', className: 'border-space-line text-txt-3' },
  failed: { text: '⚠️ 退款失敗 · 請聯絡客服', className: 'border-pink/70 text-pink-soft' },
};

/**
 * 「💳 即時網上支付」（F7；2026-09-29 hotfix 改官方 SDK 契約）：trpc.airwallex.createPayment →
 * { enabled:true, intentId, clientSecret, env, currency, returnUrl } → redirectToAirwallexCheckout
 * 跳去 Airwallex Hosted Payment Page；{ enabled:false }（未配置）→ 成個區收起（寫法跟 Payment.tsx）。
 */
function OnlinePaySection({ orderId, total, walletUsed = 0 }: { orderId: number; total: number; walletUsed?: number }) {
  const createPayment = trpc.airwallex.createPayment.useMutation();
  const [airwallexUnavailable, setAirwallexUnavailable] = useState(false);
  const [payOnlineError, setPayOnlineError] = useState<string | null>(null);
  // v2.5.5 第8版（老闆實測 2026-10-11 購物金單顯示全額）：用咗購物金嘅單淨收尾數——
  // 後端 Airwallex 一直都係收 total−walletUsed，呢度係顯示漏咗（顯示全額 → 老闆以為購物金冇扣到）
  const cashDue = Math.max(0, total - walletUsed);

  if (airwallexUnavailable) return null;

  const onPayOnline = async () => {
    setPayOnlineError(null);
    try {
      const result = (await createPayment.mutateAsync({ orderId })) as {
        enabled: boolean;
        intentId?: string;
        clientSecret?: string;
        env?: 'demo' | 'prod';
        currency?: string;
        returnUrl?: string;
      };
      if (
        result.enabled &&
        result.intentId &&
        result.clientSecret &&
        result.env &&
        result.currency &&
        result.returnUrl
      ) {
        await redirectToAirwallexCheckout({
          intentId: result.intentId,
          clientSecret: result.clientSecret,
          env: result.env,
          currency: result.currency,
          returnUrl: result.returnUrl,
        });
        return;
      }
      setAirwallexUnavailable(true);
    } catch (err) {
      // 後端會擲中文 TRPCError（唔係自己嘅單／唔係 pending_payment 等），照原樣顯示
      setPayOnlineError(err instanceof Error ? err.message : '未能開啟網上付款，請稍後再試');
    }
  };

  return (
    <div
      className="rounded-xl border px-4 py-4"
      style={{ borderColor: 'var(--gold)', background: 'var(--space-2)' }}
    >
      <button
        type="button"
        onClick={() => void onPayOnline()}
        disabled={createPayment.isPending}
        className="btn btn-primary w-full disabled:opacity-70"
      >
        {createPayment.isPending ? '正在開啟安全付款頁…' : `💳 即時網上支付 ${formatHKD(cashDue)}`}
      </button>
      {walletUsed > 0 && (
        <p className="mt-2 text-[12.5px] font-medium text-gold">
          購物金已扣 {formatHKD(walletUsed)}（訂單總額 {formatHKD(total)}），而家淨係找尾數
        </p>
      )}
      {payOnlineError && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-pink-soft">
          {payOnlineError}
        </p>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-txt-3">{ONLINE_PAYMENT_FEE_NOTE}</p>
    </div>
  );
}

function ItemRow({
  item,
  image,
  showPending,
  methodMap,
}: {
  item: MyOrderItem;
  image?: string;
  /** v2.4.0（Wave 2）：訂單已確認後先出「待寄出」chip（未確認單唔出噪音） */
  showPending: boolean;
  methodMap: Map<number, string>;
}) {
  const cancelled = item.shipStatus === 'cancelled';
  return (
    <li className="flex items-center gap-3 border-t border-space-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      {image ? (
        <span className={`duotone block h-16 w-14 shrink-0 overflow-hidden rounded-lg border border-space-line ${cancelled ? 'opacity-40 grayscale' : ''}`}>
          <img src={image} alt={item.productName} className="h-full w-full object-cover" loading="lazy" />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="flex h-16 w-14 shrink-0 items-center justify-center rounded-lg border border-space-line bg-space-3"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
              fill="var(--space-line)"
            />
          </svg>
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] font-medium ${cancelled ? 'text-txt-3 line-through' : 'text-txt-1'}`}>
          {item.productName}
        </span>
        <span className="block font-mono text-[12px] text-txt-3">
          {item.sku}
          {item.size ? ` · ${item.size}` : ''} · ×{item.quantity}
        </span>
        {/* v2.5.5 第9版（老闆指示「全網都要寫翻原價同優惠價」）：有折扣 → 優惠價＋原價劃線 */}
        {(item.originalPrice ?? 0) > item.price && (
          <span className="block text-[11.5px] text-txt-3">
            優惠價 <span className="text-pink">{formatHKD(item.price)}</span>
            　<s>原價 {formatHKD(item.originalPrice ?? item.price)}</s>
          </span>
        )}
        {/* v2.4.0（Wave 2）：逐件出貨狀態／取消原因／員工更改 chip */}
        <ItemShipChips item={item} showPending={showPending} methodMap={methodMap} />
      </span>
      <span className={`shrink-0 font-mono text-[15px] ${cancelled ? 'text-txt-3 line-through' : 'text-pink'}`}>
        {formatHKD(item.price * item.quantity)}
      </span>
    </li>
  );
}

export default function OrderCard({ order, productImages }: OrderCardProps) {
  const needsPayment = order.status === 'pending_payment' || order.status === 'rejected';
  const latestRejectedProof =
    order.status === 'rejected'
      ? [...order.proofs].reverse().find((p) => p.status === 'rejected')
      : undefined;
  const latestProof = order.proofs.length > 0 ? order.proofs[order.proofs.length - 1] : undefined;

  // F7 退款：badge（'none'／'rejected' 唔顯示）；refunded／manual 成張卡灰化（同 WMS 灰卡呼應）
  const refundBadge = REFUND_BADGES[order.refundStatus];
  const refundGrayed = order.refundStatus === 'refunded' || order.refundStatus === 'manual';

  // v2.1.0：落單當刻嘅 VIP 級別（舊單冇呢個欄 → 當普通會員，唔出 badge）
  const vipTier = normalizeVipTier(order.vipTierAtPurchase);
  // v2.2.0 級別格調：seal chip＋卡邊 accent tint 一律由 vipTheme.ts 出
  const vipTheme = vipTierTheme(vipTier);
  // VIP 折扣（DB 存整數仙 → 顯示港元）；0 就唔顯示
  const vipDiscount = Math.round((order.vipDiscountCents ?? 0) / 100);
  // 運費標記：免運 ✓（金）；澳門／國外非免運 → 灰「順豐到付」；香港到付同舊單唔加，保持卡面簡潔
  const shippingLabel = order.shippingFree
    ? 'free'
    : order.region === 'MO' || order.region === 'OVERSEAS'
      ? 'cod'
      : null;

  // v2.4.0（Wave 2 出貨同步）：出貨批次＋逐件狀態（已作廢批次唔顯示）
  const shipments = (order.shipments ?? []).filter((s) => s.reversedAt == null);
  const shipMethodMap = batchMethodMap(shipments);
  const showShipChips = order.status === 'approved' || order.status === 'shipped';
  // 部分出貨 headline：已確認而且寄咗部分 → 「部分寄出 x/y」
  const liveItems = order.items.filter((it) => it.shipStatus !== 'cancelled');
  const shippedCount = order.items.filter((it) => it.shipStatus === 'shipped').length;
  const partialShip =
    order.status === 'approved' && shippedCount > 0 && shippedCount < liveItems.length;
  // v2.5.5（老闆指示）：同款多件部分取消嘅件數 — 全寄出嗰陣要寫明「取消咗 N 件，已寄出晒（已取消商品除外）」
  const cancelledQtySum = order.items.reduce((s, it) => s + (it.cancelledQty ?? 0), 0);

  return (
    <article
      className="rounded-2xl border p-5 md:p-6"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        // v2.2.0：VIP 單卡邊用級別 accent（55% 透明度，克制唔搶戲）；普通會員維持玻璃邊
        borderColor: vipTheme.isVip ? `${vipTheme.accent}8c` : 'var(--glass-border)',
        ...(refundGrayed ? { opacity: 0.6, filter: 'grayscale(0.5)' } : {}),
      }}
      aria-label={`訂單 ${order.orderNo}`}
    >
      {/* 頂行：單號 + 日期 + 狀態 badge */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-sm text-txt-2">{order.orderNo}</span>
        <span className="text-[13px] text-txt-3">{formatOrderDate(order.createdAt)}</span>
        {refundBadge && (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12px] ${refundBadge.className}`}
          >
            {refundBadge.text}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <Link
            to={`/receipt/${order.id}`}
            className="flex items-center gap-1 text-[12px] text-lavender underline underline-offset-4 transition-colors hover:text-txt-1"
          >
            <Receipt size={13} aria-hidden="true" />
            單據
          </Link>
          {/* v2.2.0：落單當刻 VIP 級別 seal chip（vipTheme chipClass；普通會員唔出，唔逼版面） */}
          {vipTheme.isVip && (
            <span className={vipTheme.chipClass} title={`落單級別：${vipTheme.label}`}>
              {vipTheme.seal} {vipTheme.shortLabel}
            </span>
          )}
          <StatusBadge status={order.status} />
        </span>
      </div>

      {/* v2.4.0（Wave 2）：部分出貨 headline（全寄咗 StatusBadge 會出「已寄出」） */}
      {partialShip && (
        <p className="mt-2 text-right text-[12.5px] font-medium" style={{ color: 'var(--success)' }}>
          部分寄出：已寄 {shippedCount}／共 {liveItems.length} 件
          {cancelledQtySum > 0 ? `（另有 ${cancelledQtySum} 件已取消）` : ''}
        </p>
      )}

      {/* v2.5.5（老闆指示）：全寄出但有取消件 → 講清楚件數＋「已取消商品除外」 */}
      {order.status === 'shipped' && cancelledQtySum > 0 && (
        <p className="mt-2 text-right text-[12.5px] font-medium" style={{ color: 'var(--success)' }}>
          取消咗 {cancelledQtySum} 件，其餘已寄出晒（已取消商品除外）
        </p>
      )}

      {/* v2.2.46（直播抽獎）：中獎框——金框＋獎品圖＋「中獎商品」標記，
          訂單日期本身就係抽獎日（server 落單時 createdAt=抽獎時間） */}
      {order.prize && (
        <div
          className="mt-4 flex items-center gap-3 rounded-2xl border p-3.5"
          style={{
            borderColor: 'rgba(245,197,24,0.55)',
            background: 'linear-gradient(120deg, rgba(245,197,24,0.14), rgba(255,143,191,0.08))',
            boxShadow: '0 0 30px rgba(245,197,24,0.12)',
          }}
        >
          <img
            src={order.prize.imagePath ?? undefined}
            alt={order.prize.name ?? ''}
            className="h-14 w-14 shrink-0 rounded-xl border object-cover"
            style={{ borderColor: 'rgba(245,197,24,0.45)' }}
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[12px] font-bold tracking-[0.14em] text-gold">
              ✦ 直播抽獎・中獎商品 ✦
            </p>
            <p className="mt-0.5 truncate text-[14px] font-semibold text-txt-1">
              {order.prize.name}
            </p>
            <p className="mt-0.5 font-mono text-[11.5px] text-txt-3">
              中獎日 {order.prize.drawDate ? `${order.prize.drawDate.slice(0, 4)}-${order.prize.drawDate.slice(4, 6)}-${order.prize.drawDate.slice(6, 8)}` : '—'}
              ・0 元包郵
            </p>
          </div>
        </div>
      )}

      {/* 商品明細 */}
      <ul className="mt-4">
        {order.items.map((item) => (
          // v2.2.46：中獎商品係隱藏商品（products.list 唔包）→ 用中獎框嘅獎品圖兜底
          <ItemRow
            key={item.id}
            item={item}
            image={productImages[item.productId] ?? order.prize?.imagePath}
            showPending={showShipChips}
            methodMap={shipMethodMap}
          />
        ))}
      </ul>

      {/* v2.4.0（Wave 2）：出貨批次區（順豐單號＋追蹤連結＋寄出時間；面交/自取/儲貨各自文案） */}
      {shipments.length > 0 && <ShipmentSection shipments={shipments} items={order.items} />}

      {/* VIP 折扣行（v2.1.0：落單次序先 VIP 後 coupon，所以排優惠碼行上面） */}
      {vipDiscount > 0 && (
        <div className="mt-4 flex items-center justify-between border-t border-space-line pt-4 text-[13px]">
          <span className="flex items-center gap-1.5 text-txt-3">
            VIP 折扣
            {vipTier !== 'NONE' && (
              <span className="text-gold">
                （{vipTier === 'GOLD' ? 'VIP金會員' : 'VIP銀會員'}）
              </span>
            )}
          </span>
          <span className="font-mono text-gold">−{formatHKD(vipDiscount)}</span>
        </div>
      )}

      {/* 優惠碼折扣行（有用碼先顯示，金額帶負號 + code 名） */}
      {order.discountAmount > 0 && (
        <div
          className={
            vipDiscount > 0
              ? 'mt-2 flex items-center justify-between text-[13px]'
              : 'mt-4 flex items-center justify-between border-t border-space-line pt-4 text-[13px]'
          }
        >
          <span className="flex items-center gap-1.5 text-txt-3">
            <Ticket size={13} aria-hidden="true" className="text-gold" />
            優惠碼{' '}
            <span className="font-mono uppercase tracking-wider text-gold">{order.promoCode}</span>
          </span>
          <span className="font-mono text-gold">−{formatHKD(order.discountAmount)}</span>
        </div>
      )}

      {/* 總計（DB total 已係折後價） */}
      <div
        className={
          vipDiscount > 0 || order.discountAmount > 0
            ? 'mt-3 flex items-baseline justify-between'
            : 'mt-4 flex items-baseline justify-between border-t border-space-line pt-4'
        }
      >
        <span className="text-sm text-txt-2">總計</span>
        <span className="font-mono text-xl font-medium text-pink">{formatHKD(order.total)}</span>
      </div>

      {/* v2.5.5 第8版（購物金）：用咗購物金嘅單——扣減行＋應付尾數行（金框）。
          老闆實測 2026-10-11：購物金扣咗但全網顯示全額；付款要以尾數為準 */}
      {(order.walletUsed ?? 0) > 0 && (
        <>
          <div className="mt-2 flex items-baseline justify-between text-[13px]">
            <span className="text-txt-3">購物金扣減</span>
            <span className="font-mono text-gold">−{formatHKD(order.walletUsed ?? 0)}</span>
          </div>
          <div
            className="mt-2 flex items-baseline justify-between rounded-xl border px-3.5 py-2.5"
            style={{ borderColor: 'var(--gold)', background: 'rgba(171,140,82,.08)' }}
          >
            <span className="text-sm font-medium text-txt-1">
              {order.total - (order.walletUsed ?? 0) > 0 ? '應付尾數' : '應付尾數（購物金全數找埋 ✦）'}
            </span>
            <span className="font-mono text-xl font-bold text-gold">
              {formatHKD(Math.max(0, order.total - (order.walletUsed ?? 0)))}
            </span>
          </div>
        </>
      )}

      {/* 取貨方式（順豐站／智能櫃自取；揀咗有填站點就一齊顯示） */}
      {order.deliveryMethod && order.deliveryMethod !== 'address' && (
        <p className="mt-3 text-[13px] text-txt-3">
          取貨方式：
          <span className="text-txt-2">
            {order.deliveryMethod === 'sf_station' ? '順豐站自取' : '順豐智能櫃自取'}
            {order.pickupPoint ? `：${order.pickupPoint}` : ''}
          </span>
        </p>
      )}

      {/* 運費（v2.1.0）：免運 ✓ 金字；澳門／國外非免運 → 灰「順豐到付」提示不包郵 */}
      {shippingLabel === 'free' && (
        <p className="mt-2 text-[13px] font-medium text-gold">免運 ✓</p>
      )}
      {shippingLabel === 'cod' && (
        <p className="mt-2 text-[13px] text-txt-3">
          順豐到付（{order.region === 'MO' ? '澳門單・不包郵' : '國外單・不包郵'}）
        </p>
      )}

      {/* 拒絕原因 */}
      {latestRejectedProof?.reviewNote && (
        <p className="mt-4 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft" role="alert">
          拒絕原因：{latestRejectedProof.reviewNote}
        </p>
      )}

      {/* 狀態時間線 */}
      <div className="mt-5">
        <OrderTimeline status={order.status} />
      </div>

      {/* 已上傳付款截圖 */}
      {latestProof && (
        <div className="mt-5 flex items-center gap-3">
          <a
            href={latestProof.imagePath}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="睇已上傳付款截圖原圖"
          >
            <img
              src={latestProof.imagePath}
              alt="已上傳付款截圖"
              className="h-14 w-14 rounded-lg border border-space-line object-cover"
              loading="lazy"
            />
          </a>
          <span className="text-[13px] text-txt-3">
            已上傳付款截圖
            {latestProof.status === 'pending' && '（對數中）'}
            {latestProof.status === 'approved' && '（已確認）'}
            {latestProof.status === 'rejected' && '（被拒絕，請重新上傳）'}
          </span>
        </div>
      )}

      {/* 待付款／被拒絕：即時網上支付（待付款先有，喺上傳截圖區上面）+ 付款資料提示 + 上傳 */}
      {needsPayment && (
        <div className="mt-5 flex flex-col gap-4 border-t border-space-line pt-5">
          {order.status === 'pending_payment' && (
            <OnlinePaySection orderId={order.id} total={order.total} walletUsed={order.walletUsed ?? 0} />
          )}
          <div className="rounded-xl border border-space-line bg-space-3 px-4 py-3 text-[13px] leading-relaxed text-txt-2">
            <p className="font-medium text-txt-1">付款資料</p>
            {/* v2.5.5 第8版（購物金）：手動過數金額＝尾數（total−walletUsed），唔係全額——
                之前寫全額，客人照住過數會過多咗（購物金落單時已扣） */}
            <p className="mt-1">
              請用 FPS 轉數快 / PayMe / AlipayHK 過數{' '}
              <span className="font-mono text-pink">
                {formatHKD(Math.max(0, order.total - (order.walletUsed ?? 0)))}
              </span>
              {(order.walletUsed ?? 0) > 0 && (
                <span className="text-gold">
                  （購物金已扣 {formatHKD(order.walletUsed ?? 0)}，淨找尾數）
                </span>
              )}
              ，然後上傳付款截圖，Glo Glo 團隊對完數就會確認訂單。
            </p>
          </div>
          <PaymentProofDropzone orderId={order.id} reupload={order.status === 'rejected'} />
        </div>
      )}
    </article>
  );
}
