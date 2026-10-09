import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  BadgeCheck,
  Check,
  Copy,
  Hourglass,
  Sparkles,
  Upload,
  Wallet,
  XCircle,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useReveal } from '@/hooks/useReveal';
import { getToken } from '@/lib/auth';
import { redirectToAirwallexCheckout } from '@/lib/airwallexCheckout';
import { trpc } from '@/providers/trpc';
import GloCutout from '@/components/GloCutout';
import WishingStar from '@/components/account/WishingStar';
import WalletLedgerList from '@/components/account/WalletLedgerList';
import PaymentDropzone from '@/components/cart/PaymentDropzone';
import { formatHKD } from '@/components/cart/format';
import {
  DEFAULT_PAYMENT_METHODS,
  PAYMENT_METHODS_SETTING_KEY,
  parsePaymentMethods,
} from '@contracts/paymentMethods';

/**
 * v2.5.0（會員購物金充值 /wallet-topup，2026-10-09 老闆指令）
 *
 * ─ 導覽入口「會員購物金充值」（登入先入到；未登入 → 請先登入卡）
 * ─ 高度美化：hero 星空金箔底圖（/wallet/wallet-hero-bg.jpg）＋真・透明動畫
 *   Glo Glo（/wallet/glo-wallet-* 三層 GloCutout，同首頁 fairy-clap 一套做法）＋
 *   金色 shimmer 套票卡＋reveal 入場
 * ─ 條款硬規定（老闆原話，一字唔准改）：
 *   「購物金不設退款」＋「本頁購物金使用只限購物官網所銷售之商品，直播商品並不適用。」
 * ─ 流程：揀套票 → wallet.createTopup（30 分鐘付款期）→
 *   ① 網上即時付款（airwallex.createTopupPayment → HPP 跳轉；回跳 /#/wallet-topup?paid=1）
 *   ② 手動過數（收款資料同 /payment 同一來源 siteSettings）＋上傳截圖
 *   → 兩條路都係「待批核」：官網後台／WMS 批准先入帳（approveTopupCore 冪等）
 * ─ 會員睇返自己：餘額、充值紀錄（狀態 chip＋到期時間）、購物金流水賬
 * ─ Airwallex 回跳 ?paid=1：橫額提示＋每 5 秒 poll 一次（webhook 未必即刻到）
 */

/** 充值單狀態 chip 配色（同後台 statusMeta 嘅口吻） */
const TOPUP_STATUS_META: Record<string, { label: string; className: string }> = {
  pending_payment: {
    label: '待付款',
    className: 'border-[color:var(--gold)] text-gold',
  },
  payment_review: {
    label: '待批核',
    className: 'border-[color:var(--lavender)] text-lavender',
  },
  approved: {
    label: '已入帳 ✦',
    className: 'border-[color:var(--success)] text-success',
  },
  rejected: {
    label: '已拒絕',
    className: 'border-[color:var(--pink-soft)] text-pink-soft',
  },
  cancelled: {
    label: '已取消',
    className: 'border-[color:var(--space-line)] text-txt-3',
  },
};



function fmtDateTimeHK(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-HK', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Hong_Kong',
  });
}

/** 一撳複製按鈕（同 Payment.tsx 嘅 CopyButton 同款） */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="btn btn-secondary !px-3.5 !py-1.5 text-[12px]"
      aria-label={`複製${label}`}
    >
      {copied ? (
        <>
          <Check size={13} aria-hidden="true" className="text-success" />
          已複製
        </>
      ) : (
        <>
          <Copy size={13} aria-hidden="true" />
          複製
        </>
      )}
    </button>
  );
}

export default function WalletTopup() {
  const { user, isLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const paidBack = searchParams.get('paid') === '1';

  const utils = trpc.useUtils();
  const packagesQuery = trpc.wallet.packages.useQuery(undefined, { enabled: !!user });
  const myWalletQuery = trpc.wallet.myWallet.useQuery(undefined, {
    enabled: !!user,
    // Airwallex 回跳後 webhook 未必即刻到：有待付款單就每 5 秒 poll，轉咗就停
    refetchInterval: (query) =>
      paidBack &&
      query.state.data?.topups.some((t) => t.status === 'pending_payment')
        ? 5000
        : false,
  });
  // 收款資料（全網統一來源，同 /payment 一樣：siteSettings → 冇就用預設）
  const methodsQuery = trpc.settings.get.useQuery(
    { key: PAYMENT_METHODS_SETTING_KEY },
    { enabled: !!user },
  );
  const methodsEntry = methodsQuery.data as { key: string; value: string } | null | undefined;
  const methods = methodsEntry?.value
    ? parsePaymentMethods(methodsEntry.value)
    : DEFAULT_PAYMENT_METHODS;

  const createTopup = trpc.wallet.createTopup.useMutation();
  const attachProof = trpc.wallet.attachTopupProof.useMutation();
  const createTopupPayment = trpc.airwallex.createTopupPayment.useMutation();

  /* ---------- 揀套票 → 開單 → 付款面板 ---------- */
  const [selectedPackage, setSelectedPackage] = useState<number | null>(null);
  const [activeTopupId, setActiveTopupId] = useState<number | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /* ---------- 上傳截圖 ---------- */
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /* ---------- 網上即時付款 ---------- */
  const [payOnlineError, setPayOnlineError] = useState<string | null>(null);
  const [payingOnline, setPayingOnline] = useState(false);
  const [airwallexUnavailable, setAirwallexUnavailable] = useState(false);

  // preview object URL 要記得 revoke
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Airwallex 回跳：即刻 refetch 一次（webhook 可能已經到咗）
  useEffect(() => {
    if (paidBack && user) void myWalletQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidBack, user]);

  const heroRef = useRef<HTMLDivElement>(null);
  const gridRef = useReveal<HTMLDivElement>();
  const listRef = useReveal<HTMLDivElement>();
  const ledgerRef = useReveal<HTMLDivElement>();
  // blur-to-sharp 入場（musepool 靈感）：hero 載入後由 8px blur 收斂
  const [heroReady, setHeroReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setHeroReady(true), 60);
    return () => window.clearTimeout(t);
  }, []);

  const wallet = myWalletQuery.data ?? null;
  const topups = useMemo(() => wallet?.topups ?? [], [wallet]);
  const packages = packagesQuery.data ?? [];
  const activeTopup = topups.find((t) => t.id === activeTopupId) ?? null;

  const onCreateTopup = async () => {
    if (selectedPackage === null || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const t = await createTopup.mutateAsync({ packageId: selectedPackage });
      setActiveTopupId(t.id);
      setFile(null);
      setPreviewUrl(null);
      setUploadError(null);
      setPayOnlineError(null);
      await utils.wallet.myWallet.invalidate();
      // 捲落付款區（開單成功即刻見到點俾錢）
      window.setTimeout(() => {
        document.getElementById('wallet-pay-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    } catch (err) {
      setCreateError(err instanceof Error && err.message ? err.message : '開充值單失敗，請稍後再試');
    } finally {
      setCreating(false);
    }
  };

  const onSelectProof = (selected: File) => {
    setUploadError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  };

  const onUploadProof = async (topupId: number) => {
    if (!file) {
      setUploadError('請先揀返張付款截圖');
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      // 1) 上傳圖片去 /api/upload（multipart form-data，欄位名 file，Bearer JWT）
      const form = new FormData();
      form.append('file', file);
      const token = getToken();
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? '上傳失敗，請稍後再試');
      }
      const { path } = (await res.json()) as { path: string };
      // 2) 綁落充值單 → 轉待批核
      await attachProof.mutateAsync({ topupId, imagePath: path });
      setFile(null);
      setPreviewUrl(null);
      setActiveTopupId(null);
      await utils.wallet.myWallet.invalidate();
    } catch (err) {
      setUploadError(err instanceof Error && err.message ? err.message : '上傳失敗，請稍後再試');
    } finally {
      setUploading(false);
    }
  };

  const onPayOnline = async (topupId: number) => {
    setPayOnlineError(null);
    setPayingOnline(true);
    try {
      const result = await createTopupPayment.mutateAsync({ topupId });
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
          env: result.env as 'demo' | 'prod',
          currency: result.currency,
          returnUrl: result.returnUrl,
        });
        return; // 跳轉緊
      }
      setAirwallexUnavailable(true);
    } catch (err) {
      setPayOnlineError(err instanceof Error && err.message ? err.message : '未能開啟網上付款，請稍後再試');
    } finally {
      setPayingOnline(false);
    }
  };

  /* ---------- 驗證會員 session ---------- */
  if (isLoading) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24 md:min-h-[calc(100dvh-72px)] md:px-8 xl:px-12">
        <WishingStar size={32} spinning />
      </section>
    );
  }

  if (!user) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24 md:min-h-[calc(100dvh-72px)] md:px-8 xl:px-12">
        <div
          className="flex w-full max-w-[420px] flex-col items-center gap-6 rounded-2xl border p-10 text-center"
          style={{
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderColor: 'var(--glass-border)',
          }}
        >
          <WishingStar size={36} />
          <div>
            <h1 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1">請先登入</h1>
            <p className="mt-2 text-[15px] text-txt-2">購物金充值係會員專屬，登入後就可以增值。</p>
          </div>
          <Link to="/login" state={{ from: '/wallet-topup' }} className="btn btn-primary w-full">
            去登入
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 pb-24 pt-10 md:px-8 md:pt-14 xl:px-12">
      {/* ───────── HERO：金箔星空底圖＋真・透明動畫 Glo Glo＋餘額卡 ───────── */}
      <header
        ref={heroRef}
        className="relative overflow-hidden rounded-[28px] border"
        style={{
          borderColor: 'var(--glass-border)',
          // blur-to-sharp reveal（musepool）：載入嗰刻 10px blur → 收斂清晰
          filter: heroReady ? 'blur(0px)' : 'blur(10px)',
          opacity: heroReady ? 1 : 0.4,
          transition: 'filter 900ms ease, opacity 900ms ease',
        }}
      >
        <img
          src="/wallet/wallet-hero-bg.jpg"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
          onLoad={() => setHeroReady(true)}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(100deg, rgba(10,6,20,.95) 0%, rgba(10,6,20,.82) 46%, rgba(10,6,20,.45) 74%, rgba(10,6,20,.6) 100%)',
          }}
        />
        <div className="relative grid items-center gap-8 px-6 py-12 md:grid-cols-[1.4fr_1fr] md:px-12 md:py-16">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">
              RedCode Wallet
            </p>
            <p className="script mt-4 text-3xl text-pink-soft">top up with love ✦</p>
            <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[42px]">
              會員購物金充值
            </h1>
            <p className="mt-4 max-w-md text-[15px] leading-[1.75] text-txt-2">
              增值購物金，結帳一撳就扣，唔使逐次過數。
              充值經同事批核後即時入帳，買嘢快人一步 ♡
            </p>
            {/* 餘額卡（hero 入面嘅玻璃金框卡） */}
            <div
              className="mt-8 inline-flex flex-col rounded-2xl border px-7 py-5"
              style={{
                borderColor: 'var(--gold)',
                background: 'rgba(10,6,20,.55)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 0 36px rgba(171,140,82,.22)',
              }}
            >
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.24em] text-gold">
                <Wallet size={13} aria-hidden="true" />
                我嘅購物金餘額
              </span>
              <span className="mt-2 font-serif-tc text-4xl font-bold leading-none text-starlight md:text-5xl">
                {wallet ? formatHKD(wallet.balance) : '—'}
              </span>
            </div>
          </div>
          {/* 真・透明動畫 Glo Glo 抱金幣（WebM alpha → 動畫 WebP → poster 三層） */}
          <div className="mx-auto w-48 md:w-64">
            <GloCutout
              videoSrc="/wallet/glo-wallet-alpha.webm"
              animSrc="/wallet/glo-wallet-anim.webp"
              poster="/wallet/glo-wallet-poster.webp"
              alt="Glo Glo 抱緊金幣同你打招呼"
              animClass="glo-sway"
              posterW={512}
              posterH={512}
              eager
            />
          </div>
        </div>
      </header>

      {/* ───────── 條款（老闆指定字句，逐字唔准改） ───────── */}
      <div
        role="note"
        className="mt-8 rounded-2xl border px-6 py-5 text-[13.5px] leading-[1.8]"
        style={{
          borderColor: 'var(--gold)',
          background: 'rgba(171,140,82,.08)',
          color: 'var(--txt-2)',
        }}
      >
        <p className="flex items-start gap-2">
          <Sparkles size={15} aria-hidden="true" className="mt-1 shrink-0 text-gold" />
          <span>
            <b className="text-txt-1">購物金不設退款</b>；本頁購物金使用只限購物官網所銷售之商品，
            直播商品（官網所有直播上架之商品，均不受影響）<b className="text-txt-1">並不適用</b>。
            每張充值單付款有效期為 <b className="text-txt-1">30 分鐘</b>，逾時未付款會自動取消；
            充值後即時入帳，如手動上傳付款截圖則需待後台同事確認後入帳，成功入帳後會收到確認電郵。
          </span>
        </p>
      </div>

      {/* Airwallex 回跳橫額（?paid=1）：免審即時入帳——webhook 到咗即刻轉「已入帳」，未到就 poll 緊 */}
      {paidBack && (
        <div
          role="status"
          className="mt-6 rounded-2xl border px-6 py-4 text-[14px] leading-relaxed"
          style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)', color: 'var(--txt-1)' }}
        >
          {wallet?.topups.some((t) => t.status === 'pending_payment')
            ? '已收到你嘅網上付款 ✦ 購物金即時入帳中（呢頁會自動更新）…'
            : '你嘅購物金已經即時入帳 ✦ 可以去「購物金紀錄」睇返，確認電郵亦會寄去你嘅信箱。'}
        </div>
      )}

      {/* ───────── ① 揀套票（金色 shimmer 卡） ───────── */}
      <div className="mt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">Step 1 · Choose</p>
        <h2 className="mt-3 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">
          揀返個充值套票
        </h2>
        {packagesQuery.isLoading ? (
          <div className="flex justify-center py-16">
            <WishingStar size={28} spinning />
          </div>
        ) : packages.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-space-line bg-space-2 px-6 py-10 text-center text-[14px] text-txt-3">
            而家未有上架中嘅套票，遲啲再嚟睇睇 ♡
          </p>
        ) : (
          <div ref={gridRef} className="reveal mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((p, i) => {
              const selected = selectedPackage === p.id;
              const save = p.creditAmount - p.price;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPackage(p.id)}
                  aria-pressed={selected}
                  className="wallet-package-card group relative overflow-hidden rounded-[24px] border p-6 text-left transition-transform duration-200 hover:-translate-y-1 md:p-7"
                  style={{
                    transitionDelay: `${i * 60}ms`,
                    borderColor: selected ? 'var(--gold)' : 'var(--glass-border)',
                    background: selected
                      ? 'linear-gradient(135deg, rgba(171,140,82,.22) 0%, rgba(23,16,38,.9) 58%)'
                      : 'var(--glass-bg)',
                    boxShadow: selected ? '0 0 40px rgba(171,140,82,.28)' : undefined,
                  }}
                >
                  {/* shimmer 掃光（揀中嘅卡先著；純 transform/opacity，唔焗背景） */}
                  {selected && (
                    <span
                      aria-hidden="true"
                      className="wallet-shimmer pointer-events-none absolute inset-0"
                    />
                  )}
                  <span className="relative flex items-start justify-between gap-3">
                    <span>
                      <span className="block font-serif-tc text-lg font-bold text-txt-1">
                        {p.label}
                      </span>
                      <span className="mt-1 block font-mono text-[11px] uppercase tracking-[0.2em] text-gold">
                        面額 {formatHKD(p.creditAmount)}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                        selected ? 'border-gold bg-gold text-space-0' : 'border-space-line text-transparent'
                      }`}
                    >
                      <Check size={13} strokeWidth={3} />
                    </span>
                  </span>
                  <span className="relative mt-5 block">
                    <span className="font-serif-tc text-3xl font-bold text-starlight">
                      {formatHKD(p.price)}
                    </span>
                    {save > 0 && (
                      <span className="ml-2 rounded-full border border-gold px-2.5 py-0.5 font-mono text-[11px] text-gold">
                        慳 {formatHKD(save)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {createError && (
          <p role="alert" className="mt-4 text-[13px] text-pink-soft">
            {createError}
          </p>
        )}
        <div className="mt-7 flex justify-center">
          <button
            type="button"
            onClick={() => void onCreateTopup()}
            disabled={selectedPackage === null || creating}
            className="btn btn-primary px-10 py-3.5 text-[15px]"
          >
            {creating ? '開緊單，許願中…' : '開充值單（30 分鐘內付款）'}
          </button>
        </div>
      </div>

      {/* ───────── ② 付款面板（開咗單先出現） ───────── */}
      {activeTopup && activeTopup.status === 'pending_payment' && (
        <div
          id="wallet-pay-panel"
          className="mt-14 rounded-[28px] border p-6 backdrop-blur-xl md:p-10"
          style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">
                Step 2 · Pay
              </p>
              <h2 className="mt-2 font-serif-tc text-2xl font-bold text-txt-1">
                充值單 {activeTopup.topupNo}
              </h2>
              <p className="mt-1 text-[14px] text-txt-2">
                「{activeTopup.label}」應付{' '}
                <b className="text-starlight">{formatHKD(activeTopup.price)}</b>
                （入帳 {formatHKD(activeTopup.creditAmount)}）
              </p>
            </div>
            <p className="flex items-center gap-2 rounded-full border border-space-line px-4 py-2 font-mono text-[12px] text-txt-3">
              <Hourglass size={13} aria-hidden="true" className="text-gold" />
              付款期限 {fmtDateTimeHK(activeTopup.expiresAt)}
            </p>
          </div>

          {/* 網上即時付款（主角；Airwallex 未配置 → 收埋） */}
          {!airwallexUnavailable && (
            <div
              className="mt-8 rounded-2xl border p-6"
              style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
            >
              <h3 className="font-serif-tc text-lg font-bold text-txt-1">網上即時付款</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-txt-3">
                信用卡 / AlipayHK / FPS / PayMe，由 Airwallex 安全處理；
                付款成功後充值單自動轉「待批核」，唔使上傳截圖。
              </p>
              {payOnlineError && (
                <p role="alert" className="mt-3 text-[13px] text-pink-soft">
                  {payOnlineError}
                </p>
              )}
              <button
                type="button"
                onClick={() => void onPayOnline(activeTopup.id)}
                disabled={payingOnline}
                className="btn btn-primary mt-4 w-full md:w-auto"
              >
                {payingOnline ? '開啟緊付款頁…' : `即時付款 ${formatHKD(activeTopup.price)}`}
              </button>
            </div>
          )}

          <p className="mt-8 text-center font-mono text-xs tracking-[0.2em] text-txt-3">
            或者手動過數
          </p>

          {/* 收款資料（同 /payment 同一來源）＋上傳截圖 */}
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {methods.map((m) => (
              <div
                key={m.id}
                className="rounded-2xl border p-5"
                style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
              >
                <p className="font-serif-tc text-[15px] font-bold text-txt-1">{m.label}</p>
                <p className="text-[12px] text-txt-3">{m.subtitle}</p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0">
                    <p className="text-[11px] tracking-wide text-txt-3">{m.accountLabel}</p>
                    <p className="break-all font-mono text-[15px] font-medium text-starlight">
                      {m.account}
                    </p>
                    {m.extraLabel && m.extraValue && (
                      <p className="mt-1 text-[12px] text-txt-3">
                        {m.extraLabel}：{m.extraValue}
                      </p>
                    )}
                  </div>
                  <CopyButton value={m.account} label={m.accountLabel} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-txt-3">
            過數嗰陣喺備註寫返充值單編號
            <span className="mx-1 font-mono text-txt-1">{activeTopup.topupNo}</span>
            ，對數會快啲。過數後上傳截圖，充值單會轉「待批核」。
          </p>
          <div className="mt-4">
            <PaymentDropzone
              file={file}
              previewUrl={previewUrl}
              disabled={uploading}
              onSelect={onSelectProof}
            />
          </div>
          {uploadError && (
            <p role="alert" className="mt-3 text-[13px] text-pink-soft">
              {uploadError}
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void onUploadProof(activeTopup.id)}
              disabled={!file || uploading}
              className="btn btn-secondary"
            >
              <Upload size={15} aria-hidden="true" />
              {uploading ? '上傳緊…' : '上傳付款截圖'}
            </button>
          </div>
        </div>
      )}

      {/* ───────── ③ 我嘅充值紀錄 ───────── */}
      <div className="mt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">Records</p>
        <div className="mt-3 flex items-center gap-5">
          <h2 className="shrink-0 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">
            充值紀錄
          </h2>
          <span aria-hidden="true" className="h-px flex-1 opacity-30" style={{ background: 'var(--gold)' }} />
        </div>
        <div ref={listRef} className="reveal mt-6">
          {topups.length === 0 ? (
            <div className="flex flex-col items-center gap-5 rounded-2xl border border-space-line bg-space-2 px-6 py-14 text-center">
              <div className="w-36">
                <GloCutout
                  videoSrc="/wallet/glo-piggy-alpha.webm"
                  animSrc="/wallet/glo-piggy-anim.webp"
                  poster="/wallet/glo-piggy-poster.webp"
                  alt="Glo Glo 舉起豬仔錢罌"
                  posterW={512}
                  posterH={512}
                />
              </div>
              <p className="max-w-sm text-[14px] leading-relaxed text-txt-2">
                你仲未有充值紀錄。揀個套票開始第一次增值啦 ♡
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {topups.map((t) => {
                const meta = TOPUP_STATUS_META[t.status] ?? {
                  label: t.status,
                  className: 'border-[color:var(--space-line)] text-txt-3',
                };
                const openForPay = t.status === 'pending_payment';
                return (
                  <div
                    key={t.id}
                    className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
                    style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-3">
                          <span className="font-mono text-[14px] font-bold text-txt-1">{t.topupNo}</span>
                          <span
                            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${meta.className}`}
                          >
                            {meta.label}
                          </span>
                        </p>
                        <p className="mt-1.5 text-[13px] text-txt-3">
                          {t.label} · 入帳 {formatHKD(t.creditAmount)} · 實付 {formatHKD(t.price)} ·{' '}
                          {fmtDateTimeHK(t.createdAt)}
                        </p>
                        {openForPay && (
                          <p className="mt-1 text-[12px] text-gold">
                            付款期限 {fmtDateTimeHK(t.expiresAt)}（逾時自動取消）
                          </p>
                        )}
                        {t.status === 'rejected' && t.reviewNote && (
                          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-pink-soft">
                            <XCircle size={12} aria-hidden="true" />
                            原因：{t.reviewNote}
                          </p>
                        )}
                        {t.status === 'approved' && t.approvedAt && (
                          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-success">
                            <BadgeCheck size={12} aria-hidden="true" />
                            {fmtDateTimeHK(t.approvedAt)} 已入帳
                          </p>
                        )}
                      </div>
                      {openForPay && (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTopupId(t.id);
                            window.setTimeout(() => {
                              document
                                .getElementById('wallet-pay-panel')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }, 120);
                          }}
                          className="btn btn-secondary !px-5 !py-2.5 text-[13px]"
                        >
                          繼續付款
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ───────── ④ 購物金流水賬 ───────── */}
      <div className="mt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">Ledger</p>
        <div className="mt-3 flex items-center gap-5">
          <h2 className="shrink-0 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">
            購物金紀錄
          </h2>
          <span aria-hidden="true" className="h-px flex-1 opacity-30" style={{ background: 'var(--gold)' }} />
        </div>
        <div ref={ledgerRef} className="reveal mt-6">
          {/* v2.5.1：共享分頁流水列表（每頁 15 筆；存入有付款方式、使用/返還有訂單連結） */}
          <div
            className="rounded-2xl border p-5 md:p-6"
            style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
          >
            <WalletLedgerList emptyText="仲未有購物金出入紀錄。" />
          </div>
        </div>
        <p className="mt-6 text-center text-[12.5px] leading-relaxed text-txt-3">
          購物金不設退款；只限購物官網所銷售之商品，直播商品（官網所有直播上架之商品，均不受影響）並不適用。
          如有疑問歡迎聯絡我哋客服 ♡
        </p>
      </div>
    </section>
  );
}
