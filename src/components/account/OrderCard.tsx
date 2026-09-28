import { useState } from 'react';
import { Link } from 'react-router';
import { Receipt, Ticket } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import StatusBadge from './StatusBadge';
import OrderTimeline from './OrderTimeline';
import PaymentProofDropzone from './PaymentProofDropzone';
import { formatHKD, formatOrderDate } from './types';
import type { MyOrder, MyOrderItem } from './types';

/**
 * 會員中心訂單卡（§P8）
 * 玻璃列：DM Mono 單號 + 日期 + 狀態 badge + 商品明細（圖/名/貨號/size/數量/價）
 * + 總計 + 取貨方式（順豐站/智能櫃）+ 金星狀態時間線；待付款／被拒絕訂單附付款資料提示卡 + 截圖上傳 dropzone。
 * 2026-09 F7：待付款單加「💳 即時網上支付」（Airwallex HPP，寫法跟 Payment.tsx）；
 * 退款狀態 badge（審批中／已退款／人手退款／失敗），已退款／人手退款嘅卡整體灰化。
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
 * 「💳 即時網上支付」（F7）：trpc.airwallex.createPayment →
 * { enabled:true, url } 跳去 Airwallex Hosted Payment Page；
 * { enabled:false }（未配置）→ 成個區收起，淨返手動過數（寫法跟 Payment.tsx）。
 */
function OnlinePaySection({ orderId, total }: { orderId: number; total: number }) {
  const createPayment = trpc.airwallex.createPayment.useMutation();
  const [airwallexUnavailable, setAirwallexUnavailable] = useState(false);
  const [payOnlineError, setPayOnlineError] = useState<string | null>(null);

  if (airwallexUnavailable) return null;

  const onPayOnline = async () => {
    setPayOnlineError(null);
    try {
      // A1 契約：{ enabled:true, url } → 跳 HPP；{ enabled:false } → 收區
      const result = (await createPayment.mutateAsync({ orderId })) as {
        enabled: boolean;
        url?: string;
      };
      if (result.enabled && result.url) {
        window.location.href = result.url;
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
        {createPayment.isPending ? '正在開啟安全付款頁…' : `💳 即時網上支付 ${formatHKD(total)}`}
      </button>
      {payOnlineError && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-pink-soft">
          {payOnlineError}
        </p>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-txt-3">{ONLINE_PAYMENT_FEE_NOTE}</p>
    </div>
  );
}

function ItemRow({ item, image }: { item: MyOrderItem; image?: string }) {
  return (
    <li className="flex items-center gap-3 border-t border-space-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      {image ? (
        <span className="duotone block h-16 w-14 shrink-0 overflow-hidden rounded-lg border border-space-line">
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
        <span className="block truncate text-[15px] font-medium text-txt-1">{item.productName}</span>
        <span className="block font-mono text-[12px] text-txt-3">
          {item.sku}
          {item.size ? ` · ${item.size}` : ''} · ×{item.quantity}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[15px] text-pink">{formatHKD(item.price * item.quantity)}</span>
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

  return (
    <article
      className="rounded-2xl border p-5 md:p-6"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
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
          <StatusBadge status={order.status} />
        </span>
      </div>

      {/* 商品明細 */}
      <ul className="mt-4">
        {order.items.map((item) => (
          <ItemRow key={item.id} item={item} image={productImages[item.productId]} />
        ))}
      </ul>

      {/* 優惠碼折扣行（有用碼先顯示，金額帶負號 + code 名） */}
      {order.discountAmount > 0 && (
        <div className="mt-4 flex items-center justify-between border-t border-space-line pt-4 text-[13px]">
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
          order.discountAmount > 0
            ? 'mt-3 flex items-baseline justify-between'
            : 'mt-4 flex items-baseline justify-between border-t border-space-line pt-4'
        }
      >
        <span className="text-sm text-txt-2">總計</span>
        <span className="font-mono text-xl font-medium text-pink">{formatHKD(order.total)}</span>
      </div>

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
            <OnlinePaySection orderId={order.id} total={order.total} />
          )}
          <div className="rounded-xl border border-space-line bg-space-3 px-4 py-3 text-[13px] leading-relaxed text-txt-2">
            <p className="font-medium text-txt-1">付款資料</p>
            <p className="mt-1">
              請用 FPS 轉數快 / PayMe / AlipayHK 過數{' '}
              <span className="font-mono text-pink">{formatHKD(order.total)}</span>
              ，然後上傳付款截圖，Glo Glo 團隊對完數就會確認訂單。
            </p>
          </div>
          <PaymentProofDropzone orderId={order.id} reupload={order.status === 'rejected'} />
        </div>
      )}
    </article>
  );
}
