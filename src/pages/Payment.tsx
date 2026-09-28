import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  Landmark,
  Lock,
  LogIn,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useReveal } from '@/hooks/useReveal';
import { getToken } from '@/lib/auth';
import WishingStar from '@/components/shop/WishingStar';
import PaymentDropzone from '@/components/cart/PaymentDropzone';
import { WishStarSpinner } from '@/components/cart/WishingStar';
import { formatHKD } from '@/components/cart/format';
import { ORDER_STATUS_META } from '@/components/admin/statusMeta';
import PaymentHeroCard from '../components/payment/PaymentHeroCard';
import { trpc } from '@/providers/trpc';
import {
  DEFAULT_PAYMENT_METHODS,
  PAYMENT_METHODS_SETTING_KEY,
  parsePaymentMethods,
} from '@contracts/paymentMethods';

/**
 * 付款方式 /payment（會員限定；可帶 ?orderId=X 針對單一訂單付款）
 *
 * 原有功能（全部保留）：
 * - 登入會員先睇到 RedCode 收款資料：中銀／PayMe／Alipay／FPS 識別碼，每項一撳複製
 * - 收款資料由 siteSettings「payment_methods」讀（後台業務分析 → 收款方式，管理員限定），
 *   同結帳頁同一來源全網同步；冇設定就用 contracts 入面嘅預設值
 * - 底部提示付款後上傳收據或截圖
 *
 * 2026-09 F5（Airwallex 網上付款 + 英倫風訂單卡）：
 * - URL 帶 orderId（結帳後／會員中心入嚟，或 Airwallex 回跳 /#/payment?orderId=X&ap=done）
 *   → 頂部顯示 <PaymentHeroCard /> 英倫風訂單卡（A5 提供，契約見 SPEC §3.5）
 * - 「網上付款」區做主角（喺手動過數區之前）：trpc.airwallex.createPayment →
 *   { enabled:true, url } 跳去 Airwallex Hosted Payment Page；{ enabled:false }（未配置）
 *   → 成個區收起，淨返手動過數，個站唔會爛
 * - 回跳 ap=done → refetch 訂單：已轉 payment_review 顯示「已收到款項，同事確認中」；
 *   仲係 pending_payment 顯示「付款處理中，請稍候刷新」（自動每 5 秒 poll 一次）
 * - orderId 單仲係 pending_payment／rejected → 頁內直接上傳付款截圖
 *   （fetch /api/upload → orders.attachPaymentProof，同結帳步驟②同一条流程）
 * - 訂單狀態 label 跟全站 statusMeta 口徑（待付款／審核中／已確認／進行出貨…）
 */

/** 4 個固定 id 嘅 icon＋色映射（資料可以改，icon 款式跟 id） */
const ICON_MAP: Record<string, { icon: React.ReactNode; color: string }> = {
  boc: { icon: <Landmark size={22} aria-hidden="true" />, color: 'var(--gold)' },
  payme: { icon: <Smartphone size={22} aria-hidden="true" />, color: 'var(--pink-soft)' },
  alipay: { icon: <Zap size={22} aria-hidden="true" />, color: 'var(--lavender)' },
  fps: { icon: <Receipt size={22} aria-hidden="true" />, color: 'var(--success)' },
};

/** 網上付款支援方式 badges（細粒 pill，夜色 boutique 風） */
const ONLINE_PAYMENT_BADGES = ['VISA', 'Mastercard', 'AlipayHK', 'FPS 轉數快', 'PayMe', 'Apple Pay'] as const;

/** 上傳／attach 錯誤翻譯（同結帳頁 Checkout.tsx 同一套口徑） */
function friendlyUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  if (raw.includes('Only jpg/png/webp')) return '只支援 JPG / PNG / WebP 圖片';
  if (raw.includes('File too large')) return '檔案大過 10MB，請壓縮細啲再試';
  if (raw === 'Unauthorized' || raw.includes('401')) return '登入已過期，請重新登入後再試';
  if (raw.includes('唔可以上傳付款證明') || raw.includes('訂單不存在')) return raw;
  if (raw === 'Failed to fetch' || raw.includes('NetworkError')) return '網絡唔穩定，請再試一次';
  return raw || '上傳失敗，請再試一次';
}

interface CopyButtonProps {
  value: string;
  label: string;
}

function CopyButton({ value, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard API 唔 work（舊瀏覽器/非 https）就用 fallback
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="btn btn-secondary !px-4 !py-2 text-[13px]"
      aria-label={`複製${label}`}
    >
      {copied ? (
        <>
          <Check size={14} aria-hidden="true" className="text-success" />
          已複製
        </>
      ) : (
        <>
          <Copy size={14} aria-hidden="true" />
          複製
        </>
      )}
    </button>
  );
}

interface MethodCardProps {
  icon: React.ReactNode;
  iconColor: string;
  title: string;
  subtitle: string;
  rows: { label: string; value: string; copyable?: boolean }[];
  delay: number;
}

function MethodCard({ icon, iconColor, title, subtitle, rows, delay }: MethodCardProps) {
  return (
    <div
      className="reveal rounded-[24px] border p-6 backdrop-blur-xl md:p-8"
      style={{
        borderColor: 'var(--glass-border)',
        background: 'var(--glass-bg)',
        transitionDelay: `${delay}ms`,
      }}
    >
      <div className="flex items-center gap-4">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
          style={{ borderColor: iconColor, color: iconColor }}
        >
          {icon}
        </span>
        <div>
          <h2 className="font-serif-tc text-xl font-bold leading-[1.3] text-txt-1">{title}</h2>
          <p className="text-sm text-txt-3">{subtitle}</p>
        </div>
      </div>
      <div className="mt-6 space-y-4">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border px-5 py-4"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            <div className="min-w-0">
              <p className="text-[12px] tracking-wide text-txt-3">{row.label}</p>
              <p className="mt-1 break-all font-mono text-lg font-medium leading-[1.2] text-starlight md:text-xl">
                {row.value}
              </p>
            </div>
            {row.copyable !== false && <CopyButton value={row.value} label={row.label} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 網上付款 badges row：VISA · Mastercard · AlipayHK · FPS 轉數快 · PayMe · Apple Pay */
function PaymentBadges() {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-2" aria-label="支援嘅網上付款方式">
      {ONLINE_PAYMENT_BADGES.map((badge) => (
        <li
          key={badge}
          className="rounded-full border px-3 py-1 font-mono text-[11px] leading-none tracking-[0.08em] text-txt-2"
          style={{ borderColor: 'var(--glass-border)', background: 'rgba(255,255,255,.03)' }}
        >
          {badge}
        </li>
      ))}
    </ul>
  );
}

/* ---------- 上傳中流星進度條（同結帳頁 §3.7 同款） ---------- */
const METEOR_STYLES = `
@keyframes meteor-run { from { transform: translateX(-110%); } to { transform: translateX(260%); } }
.meteor-segment { animation: meteor-run 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .meteor-segment { animation: none; transform: translateX(60%); } }
`;

function MeteorProgressBar() {
  return (
    <div className="mt-5" role="status" aria-label="上傳中">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-space-4">
        <span
          className="meteor-segment absolute inset-y-0 left-0 w-2/5 rounded-full"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--gold))',
          }}
        />
      </div>
      <p className="mt-2.5 flex items-center justify-center gap-2 text-[13px] text-txt-3">
        <WishStarSpinner size={14} />
        上傳緊，唔好閂頁面…
      </p>
      <style>{METEOR_STYLES}</style>
    </div>
  );
}

export default function Payment() {
  const { user, isLoading } = useAuth();
  const gridRef = useReveal<HTMLDivElement>();
  const utils = trpc.useUtils();

  /* ---------- URL 參數（HashRouter：#/payment?orderId=X&ap=done，useSearchParams 讀 hash 入面嘅 query） ---------- */
  const [searchParams] = useSearchParams();
  const orderIdRaw = Number(searchParams.get('orderId'));
  const orderId = Number.isInteger(orderIdRaw) && orderIdRaw > 0 ? orderIdRaw : null;
  const apDone = searchParams.get('ap') === 'done';

  /* ---------- 收款方式（全網統一來源）：後台改咗呢度同結帳頁一齊更新；冇設定用預設 ---------- */
  const methodsQuery = trpc.settings.get.useQuery({ key: PAYMENT_METHODS_SETTING_KEY });
  const methodsEntry = methodsQuery.data as { key: string; value: string } | null | undefined;
  const methods = methodsEntry?.value ? parsePaymentMethods(methodsEntry.value) : DEFAULT_PAYMENT_METHODS;

  /* ---------- 指定訂單（有 orderId 先查；只攞到自己嘅單，人哋嘅單後端會 NOT_FOUND） ---------- */
  const orderQuery = trpc.orders.myOrderById.useQuery(
    { id: orderId ?? 0 },
    {
      enabled: !!user && orderId !== null,
      retry: false,
      // Airwallex 回跳後 webhook 未必即刻到：仲係 pending_payment 就每 5 秒 poll 一次，轉咗就停
      refetchInterval: (query) =>
        apDone && query.state.data?.status === 'pending_payment' ? 5000 : false,
    },
  );
  const order = orderQuery.data ?? null;

  // Airwallex 回跳 ap=done：一入頁即刻 refetch 一次，攞 webhook 更新後嘅最新狀態
  useEffect(() => {
    if (apDone && orderId !== null && user) {
      void orderQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apDone, orderId, user]);

  /* ---------- 網上付款（Airwallex HPP）：mutation 話未配置（enabled:false）就成區收起 ---------- */
  const createPayment = trpc.airwallex.createPayment.useMutation();
  const [airwallexUnavailable, setAirwallexUnavailable] = useState(false);
  const [payOnlineError, setPayOnlineError] = useState<string | null>(null);

  const onPayOnline = async () => {
    if (orderId === null) return;
    setPayOnlineError(null);
    try {
      // A1 契約（SPEC §3.2）：{ enabled:true, url } → 跳 HPP；{ enabled:false } → 收區
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

  /* ---------- 上傳付款截圖（同結帳步驟②同一条流程） ---------- */
  const attachProof = trpc.orders.attachPaymentProof.useMutation();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // preview object URL 要記得 revoke
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onSelectProof = (selected: File) => {
    setUploadError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  };

  const onUploadProof = async () => {
    if (orderId === null) return;
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
      const data = (await res.json().catch(() => null)) as {
        path?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.path) {
        throw new Error(data?.error ?? `上傳失敗（HTTP ${res.status}）`);
      }

      // 2) 將 path 掛上訂單（狀態轉 payment_review），再刷新頁面嘅訂單資料
      await attachProof.mutateAsync({ orderId, imagePath: data.path });
      void utils.orders.myOrders.invalidate();
      await orderQuery.refetch();
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setUploading(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setUploadError(friendlyUploadError(err));
      setUploading(false);
    }
  };

  /* ---------- 衍生顯示資料 ---------- */
  const statusLabel = useMemo(() => {
    if (!order) return '';
    // Airwallex 回跳 + webhook 已確認收款：客人角度講返「已收到款項，同事確認中」
    if (apDone && order.status === 'payment_review') return '已收到款項，同事確認中';
    // 全站統一口徑（src/components/admin/statusMeta.ts）
    return ORDER_STATUS_META[order.status]?.label ?? String(order.status);
  }, [apDone, order]);

  const heroItems = useMemo(() => {
    if (!order?.items || order.items.length === 0) return undefined;
    return order.items.map((it) => ({
      name: it.size ? `${it.productName}（${it.size}）` : it.productName,
      quantity: it.quantity,
      price: it.price,
    }));
  }, [order]);

  const deliveryLabel = useMemo(() => {
    if (!order) return undefined;
    // 口徑同 Receipt.tsx 一致
    if (order.deliveryMethod === 'sf_station') {
      return `順豐站自取${order.pickupPoint ? `：${order.pickupPoint}` : ''}`;
    }
    if (order.deliveryMethod === 'sf_locker') {
      return `順豐智能櫃自取${order.pickupPoint ? `：${order.pickupPoint}` : ''}`;
    }
    return '送貨上門';
  }, [order]);

  const canPayOnline = order?.status === 'pending_payment';
  const canUploadProof = order?.status === 'pending_payment' || order?.status === 'rejected';

  /* ---------- Loading：核實緊會員身份 ---------- */
  if (isLoading) {
    return (
      <section className="flex min-h-[60dvh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <WishingStar size={32} />
          <p className="text-[14px] text-txt-3">核實緊會員身份…</p>
        </div>
      </section>
    );
  }

  /* ---------- 未登入：擋住，提示登入 ---------- */
  if (!user) {
    return (
      <section className="mx-auto flex max-w-[1280px] justify-center px-5 py-24 md:px-8">
        <div
          className="w-full max-w-[420px] rounded-3xl border p-8 text-center backdrop-blur-xl"
          style={{ background: 'var(--glass-bg-strong)', borderColor: 'var(--glass-border)' }}
        >
          <span
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
          >
            <Lock size={20} aria-hidden="true" />
          </span>
          <p className="script mt-4 text-3xl">members only ✦</p>
          <h1 className="mt-2 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">
            付款方式只限會員睇
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-txt-2">
            為咗保障收款資料安全，請先登入會員，登入後即刻睇到全部付款方法。
          </p>
          <div className="mt-6">
            <Link
              to="/login"
              state={{ from: orderId !== null ? `/payment?orderId=${orderId}` : '/payment' }}
              className="btn btn-primary w-full"
            >
              <LogIn size={16} aria-hidden="true" />
              登入會員
            </Link>
          </div>
        </div>
      </section>
    );
  }

  /* ---------- 已登入：訂單卡 + 網上付款 + 手動過數 + 上傳截圖 ---------- */
  return (
    <section className="mx-auto max-w-[1280px] px-5 py-16 md:px-8 md:py-24 xl:px-12">
      <header className="text-center">
        <p className="script text-3xl md:text-4xl">pay with love ✦</p>
        <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
          付款方式
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-[1.75] text-txt-2">
          {order
            ? '揀你最方便嘅方法付款：網上付款即時確認，或者手動過數後上傳截圖。'
            : '以下係 RedCode 官方收款資料，揀你最方便嘅方法付款就得。記得核對清楚戶名先好過數 ♡'}
        </p>
      </header>

      {/* 英倫風訂單卡（A5 PaymentHeroCard，契約見 SPEC §3.5；冇 items 就唔傳） */}
      {order && (
        <div className="mx-auto mt-12 max-w-2xl">
          <PaymentHeroCard
            orderNo={order.orderNo}
            createdAt={order.createdAt}
            statusLabel={statusLabel}
            total={order.total}
            {...(order.discountAmount > 0 ? { discountAmount: order.discountAmount } : {})}
            {...(heroItems ? { items: heroItems } : {})}
            {...(deliveryLabel ? { deliveryLabel } : {})}
          />
        </div>
      )}

      {/* orderId 喺 URL 但搵唔到單（唔係自己嘅／已唔存在）：靜靜哋提示，唔阻住睇收款資料 */}
      {orderId !== null && orderQuery.isError && (
        <p
          role="alert"
          className="mx-auto mt-10 max-w-2xl rounded-2xl border px-5 py-4 text-center text-[13px] leading-relaxed"
          style={{ borderColor: 'var(--pink-soft)', color: 'var(--pink-soft)' }}
        >
          搵唔到呢張訂單（可能唔屬於你嘅帳號，或者已經唔存在）。你可以去「會員中心 → 我嘅訂單」核對。
        </p>
      )}

      {/* Airwallex 回跳狀態提示（ap=done） */}
      {apDone && order?.status === 'payment_review' && (
        <div
          role="status"
          className="mx-auto mt-10 flex max-w-2xl flex-col items-center gap-3 rounded-[24px] border px-6 py-7 text-center backdrop-blur-xl"
          style={{ borderColor: 'var(--success)', background: 'var(--glass-bg)' }}
        >
          <CheckCircle2 size={28} aria-hidden="true" className="text-success" />
          <p className="font-serif-tc text-xl font-semibold leading-[1.5] text-starlight">
            已收到款項，同事確認中
          </p>
          <p className="max-w-md text-[14px] leading-[1.75] text-txt-2">
            你嘅網上付款已經成功，我哋確認之後就會即刻安排發貨，確認完成會再有通知。
          </p>
          <Link to="/account" className="btn btn-secondary mt-1">
            去會員中心睇訂單
          </Link>
        </div>
      )}
      {apDone && order?.status === 'pending_payment' && (
        <div
          role="status"
          className="mx-auto mt-10 flex max-w-2xl flex-col items-center gap-3 rounded-[24px] border px-6 py-7 text-center backdrop-blur-xl"
          style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)' }}
        >
          <p className="font-serif-tc text-xl font-semibold leading-[1.5] text-starlight">
            付款處理中，請稍候刷新
          </p>
          <p className="max-w-md text-[14px] leading-[1.75] text-txt-2">
            如果你啱啱喺 Airwallex 完成咗付款，系統確認需要幾秒時間，呢頁會自動更新；
            如果你冇完成付款，可以喺下面再試一次或者揀手動過數。
          </p>
          <button
            type="button"
            onClick={() => void orderQuery.refetch()}
            disabled={orderQuery.isRefetching}
            className="btn btn-secondary mt-1 disabled:opacity-60"
          >
            <RefreshCw size={15} aria-hidden="true" />
            {orderQuery.isRefetching ? '刷新緊…' : '而家刷新'}
          </button>
        </div>
      )}

      {/* 網上付款（主角，喺手動過數之前；Airwallex 未配置 → 成區唔 render） */}
      {order && canPayOnline && !airwallexUnavailable && (
        <div
          className="mx-auto mt-12 max-w-2xl rounded-[24px] border p-6 text-center backdrop-blur-xl md:p-10"
          style={{
            borderColor: 'var(--gold)',
            background: 'var(--glass-bg-strong)',
            boxShadow: '0 0 48px color-mix(in srgb, var(--gold) 12%, transparent)',
          }}
        >
          <span
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
          >
            <CreditCard size={24} aria-hidden="true" />
          </span>
          <p className="mt-4 font-mono text-xs tracking-[0.2em] text-gold">PAY ONLINE</p>
          <h2 className="mt-2 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">
            網上付款（推介）
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-[1.75] text-txt-2">
            信用卡 / AlipayHK / FPS / PayMe，由 Airwallex 安全處理，
            本站唔會儲存你嘅卡資料。付款成功後訂單會自動確認收款，唔使再上傳截圖。
          </p>
          <div className="mt-5">
            <PaymentBadges />
          </div>

          {payOnlineError && (
            <p role="alert" className="mt-5 text-[13px] leading-relaxed text-pink-soft">
              {payOnlineError}
            </p>
          )}

          <button
            type="button"
            onClick={() => void onPayOnline()}
            disabled={createPayment.isPending}
            className="btn btn-primary mt-6 w-full disabled:opacity-70 md:w-auto md:min-w-[280px]"
          >
            {createPayment.isPending ? (
              <>
                <WishStarSpinner size={16} />
                正在開啟安全付款頁…
              </>
            ) : (
              <>
                <Lock size={15} aria-hidden="true" />
                網上付款 {formatHKD(order.total)}
              </>
            )}
          </button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-txt-3">
            <ShieldCheck size={13} aria-hidden="true" className="shrink-0" />
            全程經 Airwallex 加密處理，卡資料唔會經我哋伺服器
          </p>
        </div>
      )}

      {/* 手動過數區（原有收款方式 cards；有網上付款單嗰陣降格做備選） */}
      {order && canPayOnline && (
        <p className="mt-14 text-center font-mono text-xs tracking-[0.2em] text-txt-3">
          或者手動過數
        </p>
      )}
      <div ref={gridRef} className={`mx-auto grid max-w-4xl gap-6 md:grid-cols-2 ${order ? 'mt-6' : 'mt-12'}`}>
        {methods.map((m, i) => {
          const meta = ICON_MAP[m.id] ?? {
            icon: <Receipt size={22} aria-hidden="true" />,
            color: 'var(--gold)',
          };
          return (
            <MethodCard
              key={m.id}
              icon={meta.icon}
              iconColor={meta.color}
              title={`${m.label} 🌟`}
              subtitle={m.subtitle}
              delay={i * 80}
              rows={[
                { label: m.accountLabel, value: m.account },
                ...(m.extraLabel && m.extraValue
                  ? [{ label: m.extraLabel, value: m.extraValue, copyable: false }]
                  : []),
              ]}
            />
          );
        })}
      </div>

      {/* 上傳付款截圖（指定訂單仲待付款／被拒絕時，頁內直接傳，唔使繞去會員中心） */}
      {order && canUploadProof && (
        <div
          className="mx-auto mt-10 max-w-2xl rounded-[24px] border p-6 backdrop-blur-xl md:p-8"
          style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
        >
          <h2 className="font-serif-tc text-xl font-bold leading-[1.3] text-txt-1">
            上傳付款截圖
          </h2>
          {order.status === 'rejected' && (
            <p className="mt-2 text-[13px] leading-relaxed text-pink-soft">
              之前嘅付款證明未獲接納，請核對收款資料後重新上傳。
            </p>
          )}
          <p className="mt-2 text-[13px] leading-relaxed text-txt-3">
            過數嗰陣喺備註寫返訂單編號
            <span className="mx-1 font-mono text-txt-1">{order.orderNo}</span>
            ，對數會快啲。上傳後訂單會轉做「審核中」。
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
            <p role="alert" className="mt-3 text-[13px] leading-relaxed text-pink-soft">
              {uploadError}
            </p>
          )}

          {uploading ? (
            <MeteorProgressBar />
          ) : (
            <button
              type="button"
              onClick={() => void onUploadProof()}
              disabled={!file || attachProof.isPending}
              className="btn btn-primary mt-5 w-full disabled:opacity-50"
            >
              上傳付款截圖
            </button>
          )}
        </div>
      )}

      {/* 付款後提示 */}
      <div
        className="reveal mx-auto mt-10 max-w-4xl rounded-[24px] border px-6 py-8 text-center md:px-10"
        style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)' }}
      >
        <p className="font-mono text-xs tracking-[0.2em] text-gold">AFTER PAYMENT</p>
        <p className="mt-3 font-serif-tc text-xl font-semibold leading-[1.5] text-starlight md:text-2xl">
          付款後請留下收據或截圖 🧾
        </p>
        <p className="mx-auto mt-3 max-w-lg text-[14px] leading-[1.75] text-txt-2">
          過數後記得 cap 低入數紙或截圖，去「會員中心 → 我嘅訂單」上傳付款截圖，
          我哋確認後就會即刻安排發貨。
        </p>
        {/* 2026-07-30 落單規則：48 小時內要傳截圖，否則訂單自動取消（2026-08-04 起收緊做 48 小時） */}
        <p
          className="mx-auto mt-5 max-w-lg rounded-2xl border px-5 py-4 text-[13px] leading-[1.75]"
          style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
        >
          ⏳ 溫馨提示：許願後請於 <strong>48 小時內</strong>過數並上傳付款截圖。
          逾期待付款訂單會自動取消，心水貨品唔會留貨，記得趁早呀 ♡
        </p>
        <Link to="/account" className="btn btn-primary mt-6">
          去會員中心上傳截圖
        </Link>
      </div>
    </section>
  );
}
