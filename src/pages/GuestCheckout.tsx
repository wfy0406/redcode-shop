/**
 * 訪客快速結帳 /guest-checkout（2026-10-09 訪客購買）
 * 設計：/mnt/agents/output/design/guest-checkout.md（單頁三段：① 聯絡資料 ② 取貨方式 ③ 確認＋付款）
 * 契約：api-contract.md §1 —— createGuest 成功後即轉 /guest-payment?orderNo=…&token=…（付款倒數態喺嗰邊）
 *
 * 鐵律：
 * - 訪客單冇優惠碼、冇 VIP 折扣；金流只有 Airwallex 即時付款（唔准手動上傳單據）
 * - 填表階段完全唔出倒數（撳「確認落單」嗰下先鎖庫存開始 30 分鐘）
 * - 價錢永遠 server 計；呢度嘅金額只係顯示用（products.list 對照 localStorage 車）
 * - 錯誤 persist 喺欄位下面（唔准 toast），全部 role="alert"
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import { getGuestCart, clearGuestCart, type GuestCartItem } from '@/lib/guestCart';
import RegionStationPicker from '@/components/shop/RegionStationPicker';
import GloCutout from '@/components/GloCutout';
import { StrokeCheck, PROMO_STYLES, BlurThumb } from '@/components/shop/form-bits';
import { WishStarSpinner } from '@/components/cart/WishingStar';
import { formatHKD } from '@/components/cart/format';

const WHATSAPP_URL = 'https://wa.me/85254835368';

/** 支付平台手續費提示（全網統一口徑，逐字唔准改） */
const FEE_NOTE = '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準。';

type DeliveryMode = 'address' | 'sf';

interface FieldErrors {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  station?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 香港電話檢查（同 server normalizeGuestPhone 同款規則：8 位，可帶 852 前綴） */
function validHkPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('852') ? digits.slice(3) : digits;
  return /^\d{8}$/.test(local);
}

/** 提交時顯示錯誤（BAD_REQUEST 列明邊件唔夠貨 → 逐行標記） */
interface StockIssue {
  productId: number;
  message: string;
}

export default function GuestCheckout() {
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  // 訪客購物車（localStorage）＋商品資料對照
  const [cartItems] = useState<GuestCartItem[]>(() => getGuestCart());
  const productsQuery = trpc.products.list.useQuery();
  const rulesQuery = trpc.vip.getPublicVipConfig.useQuery(undefined, { staleTime: 60_000 });

  const lines = useMemo(() => {
    const products = productsQuery.data ?? [];
    const byId = new Map(products.map((p) => [p.id, p]));
    return cartItems.map((it) => {
      const p = byId.get(it.productId);
      const unit = p ? (p.discountPrice ?? p.price) : 0;
      return {
        ...it,
        name: p?.name ?? `商品 #${it.productId}`,
        image: p?.image ?? null,
        unitPrice: unit,
        lineTotal: unit * it.quantity,
        missing: !p,
      };
    });
  }, [cartItems, productsQuery.data]);

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const freeThreshold = (rulesQuery.data?.freeThresholdCents ?? 35000) / 100;

  // ── 表單 state ──
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<DeliveryMode>('sf');
  const [stationId, setStationId] = useState<string | undefined>(undefined);
  const [stationName, setStationName] = useState<string | undefined>(undefined);
  const [stationType, setStationType] = useState<string | undefined>(undefined);
  const [address, setAddress] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [emailOk, setEmailOk] = useState(false);

  // ── 提交 state ──
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stockIssues, setStockIssues] = useState<StockIssue[]>([]);
  const [paymentDown, setPaymentDown] = useState(false);
  const createGuest = trpc.orders.createGuest.useMutation();

  const inputCls =
    'mt-2 h-11 w-full rounded-xl border bg-space-2 px-4 text-[15px] text-txt-1 placeholder:text-txt-disabled transition-colors focus:border-pink';
  const inputStyle = (hasErr?: string) => ({ borderColor: hasErr ? 'var(--pink)' : 'var(--space-line)' });

  const setFieldError = (k: keyof FieldErrors, msg?: string) =>
    setErrors((prev) => ({ ...prev, [k]: msg }));

  const validate = (): boolean => {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = '唔該填返個稱呼';
    if (!validHkPhone(phone)) next.phone = '電話號碼好似唔啱喎，香港 8 位數字';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Email 格式唔啱喎——訂單確認信寄呢度，要準喎';
    if (mode === 'address' && !address.trim()) next.address = '上門收貨要填返個地址喎';
    if (mode === 'sf' && !stationId) next.station = '先揀返個自取站點先好落單呀';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (createGuest.isPending) return;
    setSubmitError(null);
    setStockIssues([]);
    if (!validate()) return;

    // deliveryMethod：sf 模式跟站點類型歸類（揀智能櫃就 sf_locker）
    const deliveryMethod =
      mode === 'address' ? 'address' : stationType === 'SF_LOCKER' ? 'sf_locker' : 'sf_station';

    try {
      const result = await createGuest.mutateAsync({
        items: cartItems.map((it) => ({
          productId: it.productId,
          size: it.size ?? undefined,
          quantity: it.quantity,
        })),
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        deliveryMethod,
        address: mode === 'address' ? address.trim() : undefined,
        stationId: mode === 'sf' ? stationId : undefined,
        note: note.trim() || undefined,
      });
      // 落單成功：清訪客車 → 去付款狀態頁（倒數＋立即付款喺嗰邊）
      clearGuestCart();
      void navigate(`/guest-payment?orderNo=${encodeURIComponent(result.orderNo)}&token=${encodeURIComponent(result.guestToken)}`);
    } catch (e) {
      const err = e as { data?: { code?: string }; message?: string };
      const code = err.data?.code;
      const msg = err.message ?? '';
      if (code === 'PRECONDITION_FAILED') {
        setPaymentDown(true);
        return;
      }
      if (code === 'TOO_MANY_REQUESTS') {
        setSubmitError('太快手啦，唞一陣再試（10 分鐘內最多 5 張訪客單）');
        return;
      }
      if (code === 'BAD_REQUEST' && /唔夠貨|賣晒|庫存/.test(msg)) {
        // server 訊息列明邊件：逐行標記（盡量對 productId；對唔到都照顯示成條訊息）
        const issues: StockIssue[] = [];
        for (const it of cartItems) {
          const line = lines.find((l) => l.productId === it.productId);
          if (line && msg.includes(line.name)) issues.push({ productId: it.productId, message: '呢件唔夠貨' });
        }
        setStockIssues(issues);
        setSubmitError(msg);
        return;
      }
      setSubmitError(msg || '網絡唔穩定，請再試一次');
    }
  };

  /* ---------- 載入中 ---------- */
  if (authLoading || productsQuery.isLoading) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24">
        <WishStarSpinner size={32} />
      </section>
    );
  }

  /* ---------- 空購物車 ---------- */
  if (cartItems.length === 0) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] flex-col items-center justify-center gap-5 px-5 py-24 text-center">
        <img src="/empty-cart.svg" alt="" className="w-52 max-w-full md:w-64" />
        <h1 className="font-serif-tc text-2xl font-semibold text-txt-1">購物車係空嘅</h1>
        <p className="max-w-sm text-[15px] text-txt-2">去揀件啱心水嘅衫先，入咗購物車就可以喺呢度快速結帳。</p>
        <Link to="/products" className="btn btn-secondary">
          去逛逛
        </Link>
      </section>
    );
  }

  const glassCard = {
    background: 'var(--glass-bg-strong)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderColor: 'var(--glass-border)',
  } as const;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 py-12 md:px-8 xl:px-12">
      <style>{PROMO_STYLES}</style>

      {/* 頁首：星空絲帶橫幅（AI 星野底圖）＋描邊 script 水印＋比心 Glo */}
      <header
        className="relative overflow-hidden rounded-3xl border"
        style={{
          borderColor: 'var(--glass-border)',
          background: 'linear-gradient(90deg, #0E0A1F 0%, #1B0E33 100%)',
        }}
      >
        <img
          src="/guest/checkout-header-bg.jpg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        />
        {/* 左暗漸變：保住標題可讀 */}
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{ background: 'linear-gradient(90deg, rgba(10,7,22,0.84) 0%, rgba(10,7,22,0.52) 48%, rgba(10,7,22,0.10) 100%)' }}
        />
        {/* 超大描邊水印（editorial 層次，只作裝飾） */}
        <span
          aria-hidden="true"
          className="script pointer-events-none absolute -bottom-8 right-0 hidden select-none leading-none sm:block"
          style={{
            fontSize: 'clamp(96px, 14vw, 168px)',
            color: 'transparent',
            WebkitTextStroke: '1px rgba(255,143,191,0.30)',
          }}
        >
          checkout
        </span>

        <div className="relative flex items-start justify-between gap-4 px-6 py-9 md:px-10 md:py-12">
          <div className="min-w-0">
            <p className="script text-3xl">Quick checkout ✦</p>
            <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
              訪客快速結帳
            </h1>
            <p className="mt-3 max-w-xl text-[15px] text-txt-2">
              唔使開帳號，填名、電話、email 就落得單。撳「確認落單」之後幫你留貨 30 分鐘，即場網上過數搞掂。
            </p>
          </div>
          {/* 比心 Glo（lg 以上先放，慳手機位） */}
          <div className="hidden w-24 shrink-0 lg:block" aria-hidden="true">
            <GloCutout
              videoSrc="/home/glo-heart-alpha.webm"
              animSrc="/home/glo-heart-anim.webp"
              poster="/home/glo-heart-poster.webp"
              alt=""
              animClass="glo-sway"
              posterW={360}
              posterH={640}
            />
          </div>
        </div>
      </header>

      {/* 已登入提示（唔強制趕走） */}
      {user && (
        <p className="mt-4 rounded-xl border px-4 py-2.5 text-[13px] text-gold" style={{ borderColor: 'rgba(245,197,24,0.35)', background: 'rgba(245,197,24,0.06)' }}>
          你登入咗做會員喎——去返<Link to="/checkout" className="font-semibold underline underline-offset-4">會員結帳</Link>有 VIP 折扣。
        </p>
      )}

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[3fr_2fr]">
        {/* ── 左欄：訂單內容（唯讀）＋金額明細 ── */}
        <div className="rounded-2xl border p-6" style={glassCard}>
          <h2 className="font-serif-tc text-xl font-semibold text-txt-1">訂單內容</h2>
          <ul className="mt-4 flex flex-col gap-4">
            {lines.map((l) => {
              const issue = stockIssues.find((i) => i.productId === l.productId);
              return (
                <li
                  key={`${l.productId}-${l.size ?? ''}`}
                  className="rounded-xl border p-3"
                  style={{ borderColor: issue ? 'var(--pink)' : 'transparent' }}
                >
                  <div className="flex items-center gap-3">
                    {l.image && <BlurThumb src={l.image} />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] text-txt-1">{l.name}</p>
                      <p className="mt-0.5 text-[13px] text-txt-3">
                        {l.size ? `尺寸 ${l.size} · ` : ''}×{l.quantity}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono tabular-nums text-txt-1">{formatHKD(l.lineTotal)}</span>
                  </div>
                  {issue && (
                    <p role="alert" className="mt-2 text-[13px] text-pink-soft">
                      {issue.message}——返購物車調整吓
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {/* 金額明細 */}
          <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--space-line)' }}>
            <div className="flex items-baseline justify-between text-[15px]">
              <span className="text-txt-2">商品小計</span>
              <span className="font-mono tabular-nums text-txt-1">{formatHKD(subtotal)}</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between text-[15px]">
              <span className="text-txt-2">運費</span>
              {mode === 'sf' ? (
                subtotal >= freeThreshold ? (
                  <span className="font-medium text-gold">免運</span>
                ) : (
                  <span className="text-[13px] text-txt-3">順豐到付（滿 {formatHKD(freeThreshold)} 免運）</span>
                )
              ) : (
                <span className="text-[13px] text-txt-3">順豐到付（運費收貨時畀）</span>
              )}
            </div>
            {mode === 'sf' && subtotal >= freeThreshold && (
              <p className="mt-1 text-right text-[12px] text-gold">全網訂單包郵（順豐站／自提點／智能櫃自取）</p>
            )}
            <div className="mt-4 flex items-baseline justify-between">
              <span className="font-serif-tc text-lg font-semibold text-txt-1">總計</span>
              <span key={subtotal} className="font-mono text-2xl tabular-nums text-pink" style={{ animation: 'promo-total-in .18s ease-out' }}>
                {formatHKD(subtotal)}
              </span>
            </div>
            <p className="mt-3 text-[13px] text-txt-3">網上付款由 Airwallex 安全處理 · 本站不儲存信用卡資料</p>
          </div>
        </div>

        {/* ── 右欄：① 聯絡資料 → ② 取貨方式 → ③ CTA ── */}
        <div className="flex flex-col gap-6">
          {/* ① 聯絡資料 */}
          <div className="rounded-2xl border p-6" style={glassCard}>
            <h2 className="font-serif-tc text-xl font-semibold text-txt-1">聯絡資料</h2>

            <div className="mt-4">
              <label htmlFor="gc-name" className="text-sm text-txt-2">
                姓名 <span className="text-pink-soft">*</span>
              </label>
              <input
                id="gc-name"
                type="text"
                autoComplete="name"
                value={name}
                disabled={createGuest.isPending}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setFieldError('name', name.trim() ? undefined : '唔該填返個稱呼')}
                className={inputCls}
                style={inputStyle(errors.name)}
                placeholder="點稱呼你好？"
              />
              {errors.name && (
                <p role="alert" className="mt-1.5 text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                  {errors.name}
                </p>
              )}
            </div>

            <div className="mt-4">
              <label htmlFor="gc-phone" className="text-sm text-txt-2">
                電話 <span className="text-pink-soft">*</span>
              </label>
              <input
                id="gc-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                disabled={createGuest.isPending}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={() => setFieldError('phone', validHkPhone(phone) ? undefined : phone ? '電話號碼好似唔啱喎，香港 8 位數字' : undefined)}
                className={inputCls}
                style={inputStyle(errors.phone)}
                placeholder="9123 4567"
              />
              {errors.phone && (
                <p role="alert" className="mt-1.5 text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                  {errors.phone}
                </p>
              )}
            </div>

            <div className="mt-4">
              <label htmlFor="gc-email" className="text-sm text-txt-2">
                Email <span className="text-pink-soft">*</span>
              </label>
              <div className="relative">
                <input
                  id="gc-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  disabled={createGuest.isPending}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailOk(EMAIL_RE.test(e.target.value.trim()));
                  }}
                  onBlur={() => setFieldError('email', EMAIL_RE.test(email.trim()) ? undefined : email ? 'Email 格式唔啱喎——訂單確認信寄呢度，要準喎' : undefined)}
                  className={inputCls}
                  style={inputStyle(errors.email)}
                  placeholder="you@example.com"
                />
                {emailOk && !errors.email && (
                  <span className="absolute right-3 top-1/2 mt-1 -translate-y-1/2" style={{ color: 'var(--success)' }} aria-hidden="true">
                    <StrokeCheck />
                  </span>
                )}
              </div>
              {errors.email ? (
                <p role="alert" className="mt-1.5 text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                  {errors.email}
                </p>
              ) : (
                <p className="mt-1.5 text-[13px] text-txt-3">一定要真㗎！訂單編號同付款連結會即刻寄去呢個 email，查單都靠佢。</p>
              )}
            </div>

            <div className="mt-4">
              <label htmlFor="gc-note" className="text-sm text-txt-2">
                備註（選填）
              </label>
              <textarea
                id="gc-note"
                rows={2}
                maxLength={500}
                value={note}
                disabled={createGuest.isPending}
                onChange={(e) => setNote(e.target.value)}
                className="mt-2 w-full rounded-xl border bg-space-2 p-4 text-[15px] text-txt-1 placeholder:text-txt-disabled transition-colors focus:border-pink"
                style={{ borderColor: 'var(--space-line)' }}
                placeholder="有咩特別要求可以寫低"
              />
            </div>
          </div>

          {/* ② 取貨方式 */}
          <div className="rounded-2xl border p-6" style={glassCard}>
            <h2 className="font-serif-tc text-xl font-semibold text-txt-1">取貨方式</h2>

            <div className="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="取貨方式">
              {(
                [
                  ['address', '送貨上門'],
                  ['sf', '順豐站／自提點／智能櫃'],
                ] as const
              ).map(([value, label]) => {
                const active = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={createGuest.isPending}
                    onClick={() => setMode(value)}
                    className={`h-11 rounded-xl border text-[14px] transition-colors ${active ? 'font-semibold text-txt-1' : 'text-txt-2'}`}
                    style={{
                      borderColor: active ? 'var(--pink)' : 'var(--space-line)',
                      background: active ? 'var(--pink-haze)' : 'var(--space-2)',
                      boxShadow: active && value === 'sf' ? '0 0 0 3px rgba(254,1,126,.22)' : undefined,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* 包郵提示（跟選項變色） */}
            {mode === 'sf' ? (
              <p className="mt-2 text-[13px] text-gold">✦ 包郵！自取點收件滿 {formatHKD(freeThreshold)} 全單免運費</p>
            ) : (
              <p className="mt-2 text-[13px] text-txt-3">上門係順豐到付，運費收貨嗰陣畀返速遞哥哥</p>
            )}

            {/* 自取展開區 */}
            {mode === 'sf' && (
              <div className="mt-4" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <RegionStationPicker
                      region="HK"
                      method="sf_station"
                      value={stationId}
                      onChange={(id, nm, type) => {
                        setStationId(id);
                        setStationName(nm);
                        setStationType(type);
                        if (id) setFieldError('station', undefined);
                      }}
                    />
                  </div>
                  {/* 順豐箱 Glo（手機唔迫，sm 起先出） */}
                  <img
                    src="/guest/glo-sfbox.png"
                    alt=""
                    className="glo-sway hidden w-[72px] shrink-0 sm:block"
                    loading="lazy"
                    aria-hidden="true"
                  />
                </div>
                {errors.station && (
                  <p role="alert" className="mt-2 text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                    {errors.station}
                  </p>
                )}
                {stationName && (
                  <p className="mt-2 text-[13px] text-txt-3">已揀：{stationName}</p>
                )}
              </div>
            )}

            {/* 上門展開區 */}
            {mode === 'address' && (
              <div className="mt-4" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                <label htmlFor="gc-address" className="text-sm text-txt-2">
                  收件地址 <span className="text-pink-soft">*</span>
                </label>
                <textarea
                  id="gc-address"
                  rows={3}
                  value={address}
                  disabled={createGuest.isPending}
                  onChange={(e) => setAddress(e.target.value)}
                  onBlur={() => setFieldError('address', address.trim() ? undefined : mode === 'address' && address ? '上門收貨要填返個地址喎' : undefined)}
                  className="mt-2 w-full rounded-xl border bg-space-2 p-4 text-[15px] text-txt-1 placeholder:text-txt-disabled transition-colors focus:border-pink"
                  style={inputStyle(errors.address)}
                  placeholder="大廈／屋苑、座數、樓層、單位"
                />
                {errors.address && (
                  <p role="alert" className="mt-1.5 text-[13px] text-pink-soft" style={{ animation: 'promo-fade-in .2s ease-out' }}>
                    {errors.address}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ③ CTA 區 */}
          {paymentDown ? (
            <div
              className="rounded-2xl border p-6 text-center"
              style={{ borderColor: 'rgba(255,0,84,0.45)', background: 'rgba(255,0,84,0.06)' }}
              role="alert"
            >
              <p className="text-[15px] text-pink-soft">即時付款暫時未能使用，唔使急——</p>
              <a
                href={`${WHATSAPP_URL}?text=${encodeURIComponent('你好，我想用訪客結帳買嘢，但即時付款開唔到，可以幫我人手處理嗎？')}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-whatsapp mt-3 w-full"
              >
                WhatsApp 我哋幫你人手處理 →
              </a>
            </div>
          ) : (
            <div>
              {submitError && (
                <p role="alert" className="mb-3 rounded-xl border px-4 py-3 text-[13.5px] text-pink-soft" style={{ borderColor: 'rgba(255,0,84,0.45)', background: 'rgba(255,0,84,0.06)' }}>
                  {submitError}
                </p>
              )}
              {stockIssues.length > 0 && (
                <Link to="/cart" className="btn btn-secondary mb-3 w-full">
                  返回購物車調整
                </Link>
              )}
              <p className="mb-3 text-[12px] text-txt-3">{FEE_NOTE}</p>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={createGuest.isPending}
                className="btn btn-primary w-full"
              >
                {createGuest.isPending ? <WishStarSpinner /> : '確認落單，去過數 →'}
              </button>
              <p className="mt-3 text-center text-[13px] text-txt-3">
                撳咗即幫你留貨 30 分鐘，過晒時庫存會放返出嚟
              </p>
              {/* 支援方式 badge */}
              <p className="mt-3 flex flex-wrap justify-center gap-1.5" aria-label="支援嘅付款方式">
                {['VISA', 'Mastercard', 'AlipayHK', 'FPS 轉數快', 'PayMe', 'Apple Pay'].map((m) => (
                  <span key={m} className="rounded-full border px-2 py-0.5 text-[11px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
                    {m}
                  </span>
                ))}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 手機底部 sticky 欄（總計＋CTA） */}
      {!paymentDown && (
        <div
          className="sticky bottom-0 z-40 mt-6 flex items-center gap-4 rounded-2xl border px-4 py-3 lg:hidden"
          style={{
            ...glassCard,
            paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
          }}
        >
          <div className="min-w-0">
            <p className="text-[11px] text-txt-3">總計</p>
            <p className="font-mono text-lg tabular-nums text-pink">{formatHKD(subtotal)}</p>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={createGuest.isPending}
            className="btn btn-primary !py-3 ml-auto"
          >
            {createGuest.isPending ? <WishStarSpinner /> : '確認落單，去過數 →'}
          </button>
        </div>
      )}
    </section>
  );
}
