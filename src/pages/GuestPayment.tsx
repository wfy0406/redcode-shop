/**
 * 訪客付款／狀態頁 /guest-payment（2026-10-09 訪客購買）
 * 入口：
 *  ① 落單成功由 /guest-checkout 轉嚟（orderNo+token）→ 倒數＋立即付款
 *  ② email 魔法連結（同款 URL）
 *  ③ Airwallex 付款回跳（多個 ap=done）→ 輪詢等 webhook 轉態，成功即彈煙花賀卡
 * 契約：api-contract.md §4 —— orders.guestByToken（token 唔中 → 統一 NOT_FOUND 訊息）
 * 設計：guest-checkout.md §6-7／order-lookup.md §4（token 永遠唔顯示喺 UI）
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { createPortal } from 'react-dom';
import { trpc } from '@/providers/trpc';
import GuestOrderCard, { type GuestOrderPayload } from '@/components/shop/GuestOrderCard';
import GloCutout from '@/components/GloCutout';
import { CopyButton } from '@/components/shop/form-bits';
import { useFireworks } from '@/components/shop/useFireworks';
import { WishStarSpinner } from '@/components/cart/WishingStar';

/** 付款成功賀卡（沿用 PrizeWinModal 慶祝語言：煙花三連爆＋fairy-clap Glo 企卡頂＋金卡入場） */
function PaidCelebrationModal({ orderNo, token }: { orderNo: string; token: string }) {
  const [reducedMotion] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const fireworksRef = useFireworks(!reducedMotion);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto p-4">
      <div className="absolute inset-0" style={{ background: 'rgba(4,2,10,0.86)' }} aria-hidden="true" />
      <canvas ref={fireworksRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />

      <div className="relative my-auto w-full max-w-md">
        {/* fairy-clap Glo 企卡頂（普通流 overlap，同 PrizeWinModal 結構） */}
        <div
          aria-hidden="true"
          className="pointer-events-none relative z-10 mx-auto w-[120px]"
          style={{
            margin: '0 auto -56px',
            animation: reducedMotion ? undefined : 'fairyFlyIn 1400ms cubic-bezier(0.2,1.1,0.3,1) 200ms both',
          }}
        >
          <GloCutout
            videoSrc="/fairy-clap-alpha.webm"
            animSrc="/fairy-clap-anim.webp"
            poster="/fairy-clap-poster.webp"
            alt=""
            posterW={480}
            posterH={480}
            eager
          />
        </div>

        <div
          role="dialog"
          aria-modal="true"
          aria-label="付款成功"
          className="relative w-full overflow-hidden rounded-3xl border"
          style={{
            borderColor: 'rgba(245,197,24,0.55)',
            background: 'linear-gradient(180deg, #1B0E33 0%, #120C24 60%)',
            boxShadow: '0 0 80px rgba(245,197,24,0.22)',
            animation: reducedMotion ? undefined : 'prizeCardIn 500ms cubic-bezier(0.2,1.3,0.4,1)',
          }}
        >
          {/* 星雨慶典底圖（AI 星空＋金粉紙屑）＋暗化漸變保文字 */}
          <img
            src="/guest/payment-success-bg.jpg"
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
            style={{ background: 'linear-gradient(180deg, rgba(27,14,51,0.38) 0%, rgba(18,12,36,0.72) 55%, rgba(18,12,36,0.88) 100%)' }}
          />
          <div className="relative px-6 pb-6 pt-7 text-center">
            {/* mt-9 留位俾企喺卡頂嘅小精靈 */}
            <p className="script mt-9 text-3xl text-gold">Paid &amp; sealed ✦</p>
            <h2 className="mt-1 font-serif-tc text-[24px] font-bold leading-[1.3] text-txt-1">
              搞掂！多謝寶寶 ♥
            </h2>
            <p className="mt-3 text-[13.5px] leading-[1.8] text-txt-2">
              訂單 <span className="font-mono font-bold text-gold">{orderNo}</span> 已確認收訖，
              確認信飛緊去你 email。出貨進度隨時喺「我的訂單 → 查詢訂單」輸入單號＋電話睇到。
            </p>
            <div className="mt-3 flex justify-center">
              <CopyButton text={orderNo} label="複製訂單編號" />
            </div>

            <div className="mt-5 flex flex-col gap-2.5">
              <Link
                to={`/orders?guest=${encodeURIComponent(orderNo)}&token=${encodeURIComponent(token)}`}
                className="w-full rounded-full py-3 text-center font-serif-tc text-[15.5px] font-bold tracking-[0.12em]"
                style={{
                  background: 'linear-gradient(160deg, #F7D774 0%, #F5C518 55%, #C99B0F 100%)',
                  color: '#241505',
                  boxShadow: '0 6px 26px rgba(245,197,24,0.35)',
                }}
              >
                去查詢訂單睇進度
              </Link>
              <Link
                to="/products"
                className="w-full rounded-full border py-2.5 text-center text-[13.5px] text-txt-2 transition-colors hover:text-txt-1"
                style={{ borderColor: 'var(--space-line)' }}
              >
                繼續睇衫
              </Link>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes prizeCardIn { 0% { transform: scale(0.82) translateY(24px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
        @keyframes fairyFlyIn { 0% { transform: translate(-40px, 30px) scale(0.6); opacity: 0; } 100% { transform: none; opacity: 1; } }
      `}</style>
    </div>,
    document.body,
  );
}

export default function GuestPayment() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const orderNo = params.get('orderNo') ?? '';
  const token = params.get('token') ?? '';
  const apDone = params.get('ap') === 'done';

  const utils = trpc.useUtils();
  const [order, setOrder] = useState<GuestOrderPayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [paid, setPaid] = useState(false);
  /** 回跳後輪詢緊 webhook 轉態（最多 ~30 秒） */
  const [confirming, setConfirming] = useState(apDone);
  /** 輪詢完都仲係 pending → 當付款未成功，出粉紅提示條 */
  const [payFailedHint, setPayFailedHint] = useState(false);
  const pollCount = useRef(0);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // 初次載入（token 直入，唔使電話）
  useEffect(() => {
    if (!orderNo || !token) return;
    let cancelled = false;
    utils.orders.guestByToken
      .fetch({ orderNo, token })
      .then((data) => {
        if (cancelled) return;
        setOrder(data as GuestOrderPayload);
        if (data.status !== 'pending_payment') {
          setPaid(true);
          setConfirming(false);
        }
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderNo, token]);

  // Airwallex 回跳：pending 狀態下每 3 秒輪詢（webhook 轉態有少少 lag），10 次都未轉就停
  useEffect(() => {
    if (!apDone || !order || order.status !== 'pending_payment' || paid) return;
    if (!confirming) return;
    const t = window.setInterval(() => {
      pollCount.current += 1;
      utils.orders.guestByToken
        .fetch({ orderNo, token })
        .then((data) => {
          const fresh = data as GuestOrderPayload;
          setOrder(fresh);
          if (fresh.status !== 'pending_payment') {
            setPaid(true);
            setConfirming(false);
            window.clearInterval(t);
          } else if (pollCount.current >= 10) {
            setConfirming(false);
            setPayFailedHint(true);
            window.clearInterval(t);
          }
        })
        .catch(() => {
          // 網絡閃爍唔好即刻判死，下次再試
          if (pollCount.current >= 10) {
            setConfirming(false);
            setPayFailedHint(true);
            window.clearInterval(t);
          }
        });
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apDone, order?.status, paid, confirming, orderNo, token]);

  /** 倒數到 0：refetch 確認後端已取消先轉態（契約 §Sweeper） */
  const onExpire = () => {
    utils.orders.guestByToken
      .fetch({ orderNo, token })
      .then((data) => setOrder(data as GuestOrderPayload))
      .catch(() => {});
  };

  // 魔法連結自動帶入：結果卡 focus 落去（screen reader 直接落喺結果）
  useEffect(() => {
    if (order && resultRef.current) resultRef.current.focus();
  }, [order?.orderNo]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 缺參數 ---------- */
  if (!orderNo || !token) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[420px] flex-col items-center justify-center gap-5 px-5 py-24 text-center">
        <img src="/guest/glo-expired.png" alt="" className="w-20" loading="lazy" />
        <h1 className="font-serif-tc text-2xl font-semibold text-txt-1">連結唔完整</h1>
        <p className="text-[15px] text-txt-2">呢條連結缺少訂單資料。用訂單編號＋電話去「我的訂單」查返啦。</p>
        <Link to="/orders" className="btn btn-primary w-full">
          去查詢訂單
        </Link>
      </section>
    );
  }

  /* ---------- 載入中 ---------- */
  if (!order && !notFound) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24">
        <WishStarSpinner size={32} />
      </section>
    );
  }

  /* ---------- 查唔到（統一訊息，防枚舉） ---------- */
  if (notFound) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[420px] flex-col items-center justify-center gap-5 px-5 py-24 text-center">
        <img src="/guest/glo-expired.png" alt="" className="w-20" loading="lazy" />
        <h1 className="font-serif-tc text-2xl font-semibold text-txt-1">搵唔到呢張訂單</h1>
        <p className="text-[15px] text-txt-2">連結可能已失效。用訂單編號＋落單電話去「我的訂單」查返，一樣睇到。</p>
        <Link to="/orders" className="btn btn-primary w-full">
          去查詢訂單
        </Link>
      </section>
    );
  }

  // 行到呢度 order 一定有（上面 !order && !notFound ／ notFound 兩個分支都 return 咗）
  if (!order) return null;

  return (
    <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[560px] flex-col justify-center px-5 py-12">
      <p className="script text-center text-3xl">Hold for you ✦</p>
      <h1 className="mt-2 text-center font-serif-tc text-3xl font-bold text-txt-1">
        {order.status === 'pending_payment' ? '幫你留住咗啲貨！' : '訂單狀態'}
      </h1>
      {order.status === 'pending_payment' && (
        <p className="mt-2 text-center text-[15px] text-txt-2">
          喺倒數完之前過數就搞掂，過咗時間庫存會放返畀其他寶寶
        </p>
      )}

      {/* 付款失敗／取消返嚟：粉紅邊提示條（倒數卡照樣喺度） */}
      {payFailedHint && order.status === 'pending_payment' && (
        <p
          role="alert"
          className="mt-4 rounded-xl border px-4 py-3 text-[13.5px] text-pink-soft"
          style={{ borderColor: 'rgba(255,0,84,0.45)', background: 'rgba(255,0,84,0.06)' }}
        >
          啱啱付款未成功，唔使急，貨仲幫你留緊——試多次啦。
        </p>
      )}
      {/* 回跳後確認緊 */}
      {confirming && !paid && (
        <p className="mt-4 flex items-center justify-center gap-2 text-[13px] text-gold">
          <WishStarSpinner size={14} /> 確認緊付款結果，唔好閂頁面…
        </p>
      )}

      <div className="mt-6 flex items-start gap-3">
        {/* 趕時間沙漏 Glo（付款中先出） */}
        {order.status === 'pending_payment' && (
          <img
            src="/guest/glo-hourglass.png"
            alt=""
            className="glo-sway mt-4 hidden w-[72px] shrink-0 sm:block"
            loading="lazy"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <GuestOrderCard
            order={order}
            guestToken={token}
            onExpire={onExpire}
            focusRef={resultRef}
            countdownVariant="hero"
            autoOpenClaim={params.get('claim') === '1'}
            onClaimed={() => void navigate('/orders')}
            claimPhone={order.guestPhone ?? ''}
          />
        </div>
      </div>

      {paid && <PaidCelebrationModal orderNo={order.orderNo} token={token} />}
    </section>
  );
}
