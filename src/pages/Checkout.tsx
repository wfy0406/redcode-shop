import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData } from '@tanstack/react-query';
import { CreditCard, MapPin, MessageCircle, TicketPercent, Truck, Wallet, X } from 'lucide-react';
import DuotoneImage from '@/components/DuotoneImage';
import RegionStationPicker from '@/components/shop/RegionStationPicker';
import LoginPrompt from '@/components/cart/LoginPrompt';
import PaymentDropzone from '@/components/cart/PaymentDropzone';
import { StarGlyph, WishStarBurst, WishStarSpinner } from '@/components/cart/WishingStar';
import { CopyButton, DotsLoader, MeteorProgressBar, PROMO_STYLES, StrokeCheck } from '@/components/shop/form-bits';
import { formatHKD } from '@/components/cart/format';
import { cartSubtotal, lineTotal, unitPrice } from '@/components/cart/types';
import type { CartLine, CreatedOrder } from '@/components/cart/types';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { getToken } from '@/lib/auth';
import { redirectToAirwallexCheckout } from '@/lib/airwallexCheckout';
import { normalizeVipTier } from '@/components/VipBadge';
import VipTierBand from '@/components/VipTierBand';
import { PAYMENT_METHODS_SETTING_KEY, parsePaymentMethods } from '@contracts/paymentMethods';

/**
 * RedCode 結帳（design-system.md §P7，含付款截圖上傳）
 * 三步玻璃進度條（步驟點 = 四角星，完成步驟填金）：
 * ① 確認訂單：cart 項目 + 優惠碼 + 總計；收貨地址 textarea（預填 user.address）+ 備註
 *    ＋預設取貨方式（2026-08-08 Glo 要求：會員設咗順豐站/智能櫃就自動帶入，客人照樣可以改）
 * ② 付款：orders.create → 網上即時付款（Airwallex HPP，未配置成區收起）
 *    → 手動過數收款資料卡（2026-08-08 起由 siteSettings「payment_methods」讀，
 *    同 /payment 頁同一來源；後台業務分析 → 收款方式改一次全網同步）
 *    + dropzone 上傳付款截圖（fetch POST /api/upload，Bearer token）→ orders.attachPaymentProof
 * ③ 完成：許願星著燈 + 訂單編號 + 「職員審核中」+ 去會員中心 CTA
 * 未登入：玻璃卡提示（同 Cart）
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';

const STEP_LABELS = ['確認訂單', '付款', '完成'] as const;

/** 網上付款支援方式 badges（細粒 pill，同 /payment 頁同一套） */
const ONLINE_PAYMENT_BADGES = ['VISA', 'Mastercard', 'AlipayHK', 'FPS 轉數快', 'PayMe', 'Apple Pay'] as const;

/** 網上付款手續費提示（全網支付位統一口徑，逐字唔好改） */
const ONLINE_PAYMENT_FEE_NOTE =
  '以信用卡或電子錢包付款，支付平台將按所選支付方式收取手續費，最終金額以支付頁顯示為準。';

/** 上傳／attach 錯誤翻譯（api/boot.ts / ordersRouter 嘅英文訊息 → 中文提示） */
function friendlyUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  if (raw.includes('Only jpg/png/webp')) return '只支援 JPG / PNG / WebP 圖片';
  if (raw.includes('File too large')) return '檔案大過 10MB，請壓縮細啲再試';
  if (raw === 'Unauthorized' || raw.includes('401')) return '登入已過期，請重新登入後再試';
  if (raw.includes('唔可以上傳付款證明') || raw.includes('訂單不存在')) return raw;
  if (raw === 'Failed to fetch' || raw.includes('NetworkError')) return '網絡唔穩定，請再試一次';
  return raw || '上傳失敗，請再試一次';
}

/** 付款比率 bps → 中文折頭（9200 →「92 折」、9000 →「9 折」）：v=bps/100，v 整除 10 就除多一個 0 */
function bpsToDiscountLabel(bps: number): string {
  const v = bps / 100;
  return v % 10 === 0 ? `${v / 10} 折` : `${v} 折`;
}

/* ---------- 三步玻璃進度條（步驟點 = 四角星，完成填金） ---------- */
function StepBar({ step }: { step: number }) {
  return (
    <ol
      className="mt-8 flex items-center gap-2 rounded-2xl border px-4 py-4 md:gap-3 md:px-6"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
      aria-label="結帳進度"
    >
      {STEP_LABELS.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none md:gap-3">
            <span
              className="flex shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              <StarGlyph
                size={current ? 22 : 18}
                color={done ? 'var(--gold)' : current ? 'var(--pink)' : 'var(--space-4)'}
              />
            </span>
            <span
              className={`truncate text-sm md:text-[15px] ${
                done ? 'text-gold' : current ? 'font-medium text-txt-1' : 'text-txt-3'
              }`}
              aria-current={current ? 'step' : undefined}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <span
                className="mx-1 h-px min-w-4 flex-1 md:mx-2"
                style={{ background: done ? 'var(--gold)' : 'var(--space-line)' }}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- ① 確認訂單 ---------- */
interface ConfirmStepProps {
  items: CartLine[];
  onCreated: (order: CreatedOrder) => void;
}

type Region = 'HK' | 'MO' | 'OVERSEAS';

const REGION_OPTIONS: readonly [Region, string][] = [
  ['HK', '香港'],
  ['MO', '澳門'],
  ['OVERSEAS', '國外'],
];

function ConfirmStep({ items, onCreated }: ConfirmStepProps) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const createOrder = trpc.orders.create.useMutation();
  const promoValidate = trpc.promo.validate.useMutation();

  // v2.1.0：useAuth 嘅 AuthUser 型別未加 VIP 新欄（主線整合時補型別）；runtime auth.me 已經有返
  const vipUser = user as (typeof user & {
    defaultRegion?: Region | null;
    defaultStationId?: string | null;
  }) | null;

  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  // 收件地區（v2.1.0 VIP+免運）：香港（預設）／澳門／國外；國外只可以送貨上門（不包郵）
  const [region, setRegion] = useState<Region>('HK');
  // 取貨方式：address 送貨上門（預設）／sf_station 順豐站／sf_locker 智能櫃
  const [deliveryMethod, setDeliveryMethod] = useState<'address' | 'sf_station' | 'sf_locker'>('address');
  // 自取站點（v2.1.0）：由 RegionStationPicker 揀，必揀先落得單（唔再自由填字）；
  // 站名唔使傳——server 落單時會用 stationId 攞站名做快照
  const [stationId, setStationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // v2.5.0（購物金）：結帳用購物金扣數開關——server 報價會預覽扣幾多／尾數幾多，
  // 落單時 server 同事務實扣（conditional update 防超扣）；餘額 0 唔會出開關
  const [useWallet, setUseWallet] = useState(false);

  // 國外單只支援送貨上門——任何計數／落單都用呢個正規化後嘅方式
  const effectiveMethod = region === 'OVERSEAS' ? 'address' : deliveryMethod;

  // F5 優惠碼：收起（文字連結）→ 展開 input → 成功後 morph 做 code chip
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoSuccess, setPromoSuccess] = useState(false); // 剔號緊（morph 做 chip 前嘅確認幀）
  const [appliedPromo, setAppliedPromo] = useState<{
    code: string;
    discountAmount: number;
    finalTotal: number;
  } | null>(null);

  // 預填會員地址（唔覆蓋用戶已改嘅內容）
  useEffect(() => {
    const saved = user?.address;
    if (saved) setAddress((prev) => (prev.trim() ? prev : saved));
  }, [user?.address]);

  // 預設收件地區（v2.1.0）：會員喺註冊／會員中心設咗澳門／國外就自動帶入
  // （客人撳過就唔好再覆蓋——effect 只喺會員資料載入時跑一次）
  useEffect(() => {
    const r = vipUser?.defaultRegion;
    if (r === 'MO' || r === 'OVERSEAS') setRegion((prev) => (prev !== 'HK' ? prev : r));
  }, [vipUser?.defaultRegion]);

  // 預設取貨方式（2026-08-08 Glo 要求）：會員設咗順豐站/智能櫃就自動帶入（連站點 ID）；
  // 預設地區係國外就唔帶自取（國外只可以送貨上門）；客人撳過其他方式就唔好再覆蓋
  // v2.2.27（老闆指令「結帳可以唔用預設，用客人果次想要嘅地址，下一次就會轉翻預設」）：
  // 客人一撳過方式制（包括撳送貨上門），就永久停止帶入——auth.me 再更新都唔准翻兜；
  // 預設本身唔會被改寫，下次入嚟照舊帶入
  const methodTouchedRef = useRef(false);
  useEffect(() => {
    if (methodTouchedRef.current) return;
    const m = user?.deliveryMethod;
    if (m === 'sf_station' || m === 'sf_locker') {
      if (vipUser?.defaultRegion === 'OVERSEAS') return;
      setDeliveryMethod((prev) => (prev !== 'address' ? prev : m));
      const sid = vipUser?.defaultStationId;
      if (sid) setStationId((prev) => prev ?? sid);
    }
  }, [user?.deliveryMethod, vipUser?.defaultRegion, vipUser?.defaultStationId]);

  // v2.2.7（老闆指令「結帳頁仲係見唔到預設」）：預設站 ID 喺可用清單搵唔到嘅保險——
  // 用會員存低嘅站名快照（pickupPoint）喺清單度認親（含異體字變體），
  // 認到就即場帶入，順手靜音修返會員 profile 嘅 defaultStationId（下次唔使再認）。
  // 觸發條件：自取模式＋未揀到站＋（有預設 ID 或站名快照）；每個 地區×方式 只試一次。
  const repairTriedRef = useRef<string | null>(null);
  const repairProfile = trpc.auth.updateProfile.useMutation();
  // 唔傳 type：服務點（SERVICE_POINT）都係順豐站方式嘅合法預設（v2.2.7）
  const repairListQuery = trpc.vip.listStations.useQuery(
    { region: region === 'MO' ? 'MO' : 'HK' },
    {
      enabled:
        !!user &&
        region !== 'OVERSEAS' &&
        effectiveMethod !== 'address' &&
        !stationId &&
        !!(vipUser?.defaultStationId || user?.pickupPoint?.trim()),
      retry: false,
    },
  );
  useEffect(() => {
    if (stationId) return;
    const list = repairListQuery.data;
    if (!list || !user) return;
    const key = `${user.id}:${region}:${effectiveMethod}`;
    if (repairTriedRef.current === key) return;
    repairTriedRef.current = key;

    const variantsOf = (n: string) => {
      const v = new Set<string>([n]);
      v.add(n.replaceAll('湧', '涌'));
      v.add(n.replaceAll('後', '后'));
      v.add(n.replaceAll('裏', '里'));
      v.add(n.replaceAll('湧', '涌').replaceAll('後', '后').replaceAll('裏', '里'));
      return v;
    };
    const sameName = (a: string, b: string) => {
      const vs = variantsOf(a);
      for (const x of variantsOf(b)) if (vs.has(x)) return true;
      return false;
    };

    const allowTypes =
      effectiveMethod === 'sf_locker' ? ['SF_LOCKER'] : ['SF_STATION', 'SERVICE_POINT'];
    const pool = list.filter((s) => allowTypes.includes(s.type));
    const wantId = vipUser?.defaultStationId ?? null;
    const wantName = user.pickupPoint?.trim() ?? '';
    const hit =
      (wantId ? pool.find((s) => s.id === wantId) : undefined) ??
      (wantName ? pool.find((s) => sameName(s.name, wantName)) : undefined);
    if (!hit) return;

    setStationId(hit.id);
    // 靜音修復 profile（fire-and-forget）：ID 唔同先修；失敗唔影響今次落單
    if (wantId !== hit.id) {
      void repairProfile
        .mutateAsync({ stationId: hit.id })
        .then(() => utils.auth.me.invalidate())
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairListQuery.data, stationId, region, effectiveMethod, user, vipUser?.defaultStationId]);

  const onRegionChange = (r: Region) => {
    setRegion(r);
    // 轉地區 → 舊站點唔啱用，要重新揀
    setStationId(undefined);
    if (r === 'OVERSEAS') setDeliveryMethod('address');
  };

  const onMethodChange = (m: 'address' | 'sf_station' | 'sf_locker') => {
    // v2.2.27（老闆指令「結帳可以唔用預設，下一次轉翻預設」）：
    // 客人一撳過取貨方式，預設帶入即刻收工，唔准再覆蓋客人今次嘅選擇
    methodTouchedRef.current = true;
    setDeliveryMethod(m);
    setStationId(undefined);
  };

  // 會員已填嘅地址（註冊或會員中心填嘅）：埋單時可以一撳用返
  const savedAddress = user?.address?.trim() ?? '';

  const subtotal = cartSubtotal(items);

  // 即時報價（v2.1.0 VIP+免運）：region／取貨方式／站點／優惠碼一變就由 server 重算
  // VIP 折扣＋優惠碼＋免運判定；keepPreviousData 避免金額區閃爍。
  // 報價失敗（例如站點啱啱被停用）就 fallback 返客戶端小計，唔會擋住落單——server 落單時會再驗。
  const quoteQuery = trpc.vip.checkoutQuote.useQuery(
    {
      region,
      deliveryMethod: effectiveMethod,
      stationId: effectiveMethod !== 'address' ? stationId : undefined,
      couponCode: appliedPromo?.code,
      // v2.5.0（購物金）：開關一撳 server 就重算預覽（walletApplied／cashDue）
      useWallet,
    },
    {
      enabled: !!user && items.length > 0,
      placeholderData: keepPreviousData,
      retry: false,
    },
  );
  const quote = quoteQuery.data;
  // v2.5.0（購物金）：餘額冧到 0（例如另一個分頁使咗）就自動收開關，唔會扣住舊數
  const walletBalance = quote?.walletBalance ?? 0;
  useEffect(() => {
    if (quote && walletBalance <= 0 && useWallet) setUseWallet(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, walletBalance]);

  // 金額全部整數港元顯示（quote 回 cents，÷100；VIP 折扣 server 已四捨五入到港元個位）
  const displaySubtotal = quote ? quote.subtotalCents / 100 : subtotal;
  const vipDiscount = quote ? quote.vipDiscountCents / 100 : 0;
  const couponDiscount = quote
    ? quote.couponDiscountCents / 100
    : (appliedPromo?.discountAmount ?? 0);
  // v2.2.0 門檻凍結：VIP 折扣字由後台規則 derive（bps/100 整除 10 →「9 折」款，否則「92 折」款）；
  // config 未返嚟之前淨顯示級別名，唔閃舊折扣數
  const vipConfigQuery = trpc.vip.getPublicVipConfig.useQuery(undefined, {
    staleTime: 60_000,
    retry: 1,
  });
  const vipCfg = vipConfigQuery.data ?? null;
  const vipLabel =
    quote?.vipTier === 'GOLD'
      ? `VIP金會員${vipCfg ? ` ${bpsToDiscountLabel(vipCfg.goldDiscountBps)}` : ''}`
      : quote?.vipTier === 'SILVER'
        ? `VIP銀會員${vipCfg ? ` ${bpsToDiscountLabel(vipCfg.silverDiscountBps)}` : ''}`
        : '';
  // 客戶端折扣只係顯示用途；落單時 server 會用 promoCode 重算，以 server 為準
  const displayTotal = quote
    ? quote.totalCents / 100
    : appliedPromo
      ? appliedPromo.finalTotal
      : subtotal;

  const onApplyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code || promoValidate.isPending || promoSuccess) return;
    setPromoError(null);
    try {
      const res = await promoValidate.mutateAsync({ code, subtotal });
      // choreography：剔號（0.3s 畫完 + 停一停）→ 輸入區 morph 做 chip
      setPromoSuccess(true);
      window.setTimeout(() => {
        setAppliedPromo({
          code: res.code,
          discountAmount: res.discountAmount,
          finalTotal: res.finalTotal,
        });
        setPromoSuccess(false);
        setPromoInput('');
      }, 450);
    } catch (err) {
      // BAD_REQUEST 中文訊息直接 persist 顯示喺 input 下面（唔好用 toast）
      setPromoError(err instanceof Error ? err.message : '優惠碼用唔到，請再試一次');
    }
  };

  const onRemovePromo = () => {
    // 移除優惠碼可逆、無損失，唔使兩步確認
    setAppliedPromo(null);
    setPromoError(null);
    setPromoInput('');
  };

  const onCreate = async () => {
    setError(null);
    // 自取必揀站點（v2.1.0）：唔再接受自由文字站點
    if (effectiveMethod !== 'address' && !stationId) {
      setError(
        '請先揀返自取站點（順豐站／自提點／智能櫃）先好落單',
      );
      return;
    }
    try {
      const created = await createOrder.mutateAsync({
        address: address.trim() || undefined,
        note: note.trim() || undefined,
        // 有先用嘅優惠碼先傳；server 會重算折扣
        promoCode: appliedPromo?.code,
        deliveryMethod: effectiveMethod,
        // v2.1.0：收件地區＋站點 ID（server 會攞站名做快照寫落 stationName／pickupPoint）
        region,
        stationId: effectiveMethod !== 'address' ? stationId : undefined,
        // v2.5.0（購物金）：有剔先用嘅開關先傳；server 同事務實扣，唔信前端金額
        useWallet: useWallet || undefined,
      });
      // 後端已清車，invalidate 令購物車頁 / badge 同步
      void utils.cart.list.invalidate();
      // v2.5.0：購物金有郁過 → 會員中心購物金卡／充值頁餘額即時更新
      if ((created as CreatedOrder).walletUsed) void utils.wallet.myWallet.invalidate();
      onCreated(created as CreatedOrder);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立訂單失敗，請再試一次');
    }
  };

  if (items.length === 0) {
    return (
      <div className="mt-14 flex flex-col items-center pb-8 text-center">
        <img src="/empty-cart.svg" alt="" className="w-52 max-w-full md:w-64" />
        <p className="mt-6 font-serif-tc text-2xl font-semibold text-txt-1">購物車係空嘅</p>
        <p className="mt-2 max-w-sm text-[15px] text-txt-2">
          未有嘢好結帳喎，去揀件衫先啦。
        </p>
        <Link to="/products" className="btn btn-secondary mt-8">
          去逛逛
        </Link>
      </div>
    );
  }

  return (
    /* mobile 單欄要 minmax(0,1fr)：auto track 會用 max-content，長檔名/mono 字串會撐爆 */
    <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* 左：訂單項目 */}
      <div>
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">訂單內容</h2>
        <ul className="mt-4 divide-y" style={{ borderColor: 'var(--space-line)' }}>
          {items.map((line) => {
            const unit = unitPrice(line);
            return (
              <li key={line.id} className="flex items-center gap-4 py-4">
                <DuotoneImage
                  src={line.product.image}
                  alt={line.product.name}
                  wrapperClassName="h-16 w-16 shrink-0 rounded-lg border"
                  className="h-full w-full object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-txt-1">{line.product.name}</p>
                  <p className="mt-0.5 font-mono text-[13px] text-txt-3">
                    {line.product.sku}
                    {line.size ? ` · 尺寸 ${line.size}` : ''}
                  </p>
                  <p className="mt-1 font-mono text-sm text-txt-2">
                    {line.quantity} × {formatHKD(unit)}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-base text-txt-1">
                  {formatHKD(lineTotal(line))}
                </p>
              </li>
            );
          })}
        </ul>
        {/* F5 優惠碼（放總計區上方）：預設收起做文字連結，唔好一入結帳就大輸入框 */}
        {appliedPromo ? (
          /* 成功後：輸入區 morph 做 gold 邊 code chip（× 可移除，唔使 confirm） */
          <div className="mt-4" style={{ animation: 'promo-fade-in .2s ease both' }}>
            <span
              className="inline-flex h-11 items-center gap-2.5 rounded-full border px-4 font-mono text-sm uppercase tracking-wider text-gold"
              style={{ borderColor: 'var(--gold)', background: 'rgba(247, 215, 116, 0.08)' }}
            >
              <TicketPercent size={15} aria-hidden="true" />
              {appliedPromo.code}
              <span className="text-gold-soft">−{formatHKD(couponDiscount)}</span>
              <button
                type="button"
                onClick={onRemovePromo}
                aria-label={`移除優惠碼 ${appliedPromo.code}`}
                className="-mr-1 flex min-h-8 min-w-8 items-center justify-center rounded-full text-gold transition-colors duration-150 hover:text-gold-soft"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          </div>
        ) : promoOpen ? (
          <div className="mt-4" style={{ animation: 'promo-fade-in .2s ease both' }}>
            <div className="flex gap-2">
              <input
                value={promoInput}
                onChange={(e) => {
                  setPromoInput(e.target.value.toUpperCase());
                  if (promoError) setPromoError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void onApplyPromo();
                  }
                }}
                placeholder="輸入優惠碼"
                aria-label="優惠碼"
                aria-invalid={!!promoError}
                autoFocus
                className="h-11 min-w-0 flex-1 rounded-xl border bg-space-2 px-4 font-mono text-[15px] uppercase tracking-wider text-txt-1 placeholder:normal-case placeholder:tracking-normal placeholder:text-txt-disabled focus:border-pink"
                style={{ borderColor: promoError ? 'var(--pink)' : 'var(--space-line)' }}
              />
              {/* 「使用」掣同 input 高度逐 px 對齊（h-11 對 h-11） */}
              <button
                type="button"
                onClick={() => void onApplyPromo()}
                disabled={promoValidate.isPending || promoSuccess || !promoInput.trim()}
                className="btn btn-secondary h-11 shrink-0 !px-6 !py-0 disabled:opacity-50"
              >
                {promoValidate.isPending ? (
                  <DotsLoader />
                ) : promoSuccess ? (
                  <span className="text-gold">
                    <StrokeCheck />
                  </span>
                ) : (
                  '使用'
                )}
              </button>
            </div>
            {/* 錯誤 persist 喺 input 下面，留到用戶改正（唔好用 toast） */}
            {promoError && (
              <p
                role="alert"
                className="mt-2 text-[13px] text-pink-soft"
                style={{ animation: 'promo-fade-in .2s ease both' }}
              >
                {promoError}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPromoOpen(true)}
            className="mt-4 inline-flex items-center gap-2 text-sm text-gold underline decoration-gold underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
          >
            <TicketPercent size={15} aria-hidden="true" />
            有優惠碼？
          </button>
        )}

        {/* 價格明細（v2.1.0）：商品小計 / VIP 折扣（有先顯示）/ 優惠碼 / 運費 / 總計，
            金額以 server 報價為準（未載到就先睇客戶端小計），靠字重分層唔靠色 */}
        <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--space-line)' }}>
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] text-txt-2">商品小計</span>
            <span className="font-mono text-base tabular-nums text-txt-1">
              {formatHKD(displaySubtotal)}
            </span>
          </div>
          {vipDiscount > 0 && (
            <div
              className="mt-2.5 flex items-baseline justify-between"
              style={{ animation: 'promo-fade-in .2s ease both' }}
            >
              <span className="inline-flex items-center gap-1.5 text-[15px] text-gold">
                <StarGlyph size={13} color="var(--gold)" />
                {vipLabel}
              </span>
              <span className="font-mono text-base tabular-nums text-gold">
                −{formatHKD(vipDiscount)}
              </span>
            </div>
          )}
          {appliedPromo && (
            <div
              className="mt-2.5 flex items-baseline justify-between"
              style={{ animation: 'promo-fade-in .2s ease both' }}
            >
              <span className="inline-flex items-center gap-1.5 text-[15px] text-gold">
                <TicketPercent size={14} aria-hidden="true" />
                優惠碼{' '}
                <span className="font-mono uppercase tracking-wider">{appliedPromo.code}</span>
              </span>
              <span className="font-mono text-base tabular-nums text-gold">
                −{formatHKD(couponDiscount)}
              </span>
            </div>
          )}
          {/* 運費行：免運金色；到付／不包郵灰色（順豐到付，金額收貨時先畀） */}
          {quote && (
            <div
              className="mt-2.5 flex items-baseline justify-between"
              style={{ animation: 'promo-fade-in .2s ease both' }}
            >
              <span className="inline-flex items-center gap-1.5 text-[15px] text-txt-2">
                <Truck size={14} aria-hidden="true" />
                運費
              </span>
              <span
                className={`font-mono text-base tabular-nums ${
                  quote.shippingFree ? 'font-medium text-gold' : 'text-txt-3'
                }`}
              >
                {quote.shippingFree ? '免運' : quote.shippingLabel}
              </span>
            </div>
          )}
          {/* v2.5.0（購物金）：有餘額先出開關——剔咗 server 報價會預覽扣幾多／尾數幾多 */}
          {quote && walletBalance > 0 && (
            <div
              className="mt-3 rounded-xl border px-4 py-3"
              style={{
                borderColor: useWallet ? 'var(--gold)' : 'var(--space-line)',
                background: 'var(--space-2)',
                animation: 'promo-fade-in .2s ease both',
              }}
            >
              <button
                type="button"
                role="switch"
                aria-checked={useWallet}
                onClick={() => setUseWallet((v) => !v)}
                className="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
              >
                <span className="inline-flex items-center gap-2 text-[14px] font-medium text-txt-1">
                  <Wallet size={15} aria-hidden="true" className="text-gold" />
                  用購物金找數
                  <span className="font-mono text-[12px] text-txt-3">
                    餘額 {formatHKD(walletBalance)}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
                    useWallet ? 'bg-gold' : 'bg-space-3'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-starlight shadow transition-transform duration-200 ${
                      useWallet ? 'translate-x-[22px]' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </button>
              {useWallet && (
                <p className="mt-2 text-[12px] leading-relaxed text-txt-3">
                  購物金不設退款；只限官網商品，直播商品唔用得。
                  {quote.walletApplied > 0 && quote.cashDue <= 0
                    ? '今單購物金全數找埋，落單後唔使再俾錢 ✦'
                    : '唔夠找嘅尾數，落單後用網上付款或過數找尾數。'}
                </p>
              )}
            </div>
          )}
          {/* v2.5.0（購物金）：剔咗用購物金 → 顯示扣減行（金） */}
          {quote && useWallet && quote.walletApplied > 0 && (
            <div
              className="mt-2.5 flex items-baseline justify-between"
              style={{ animation: 'promo-fade-in .2s ease both' }}
            >
              <span className="inline-flex items-center gap-1.5 text-[15px] text-txt-2">
                <Wallet size={14} aria-hidden="true" />
                購物金扣減
              </span>
              <span className="font-mono text-base tabular-nums text-gold">
                −{formatHKD(quote.walletApplied)}
              </span>
            </div>
          )}
          {/* key 綁金額：總額變更時 re-mount 觸發 slide 更新，唔會「啪」一聲跳 */}
          <div
            key={displayTotal}
            className="mt-3 flex items-baseline justify-between"
            style={{ animation: 'promo-total-in .18s ease both' }}
          >
            <span className="font-serif-tc text-lg font-semibold text-txt-1">
              {vipDiscount > 0 || (appliedPromo && couponDiscount > 0) ? '折後總計' : '總計'}
            </span>
            <span className="font-mono text-2xl tabular-nums text-pink">
              {formatHKD(displayTotal)}
            </span>
          </div>
          {/* v2.5.0（購物金）：有扣減 → 應付尾數做主行（pink 大字），全數找埋就 HK$0 */}
          {quote && useWallet && quote.walletApplied > 0 && (
            <div
              className="mt-2 flex items-baseline justify-between rounded-xl border px-4 py-3"
              style={{
                borderColor: 'var(--gold)',
                background: 'rgba(171,140,82,.08)',
                animation: 'promo-fade-in .2s ease both',
              }}
            >
              <span className="font-serif-tc text-lg font-semibold text-txt-1">
                {quote.cashDue > 0 ? '應付尾數' : '應付尾數（購物金全數找埋 ✦）'}
              </span>
              <span className="font-mono text-2xl tabular-nums text-gold">
                {formatHKD(quote.cashDue)}
              </span>
            </div>
          )}
          {/* server 備註（澳門單・不包郵・順豐到付／VIP金會員全年免運…）：細字提示 */}
          {quote && quote.remarks.length > 0 && (
            <p className="mt-2.5 text-[13px] leading-relaxed text-txt-3">
              {quote.remarks.join('；')}
            </p>
          )}
        </div>
        <style>{PROMO_STYLES}</style>
      </div>

      {/* 右：收貨資料（§4.6 表單） */}
      <div
        className="h-fit rounded-2xl border p-6"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">收貨資料</h2>

        {/* 收件地區（v2.1.0）：香港（預設）／澳門／國外——影響免運判定同可取貨方式 */}
        <div className="mt-5">
          <span className="text-sm text-txt-2">收件地區</span>
          <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label="收件地區">
            {REGION_OPTIONS.map(([value, label]) => {
              const active = region === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onRegionChange(value)}
                  aria-pressed={active}
                  className="h-11 rounded-xl border text-[13px] transition-colors"
                  style={
                    active
                      ? {
                          borderColor: 'var(--pink)',
                          background: 'var(--pink-haze)',
                          color: 'var(--txt-1)',
                          fontWeight: 600,
                        }
                      : {
                          borderColor: 'var(--space-line)',
                          background: 'var(--space-2)',
                          color: 'var(--text-3)',
                        }
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* 地區提示：澳門／國外不包郵（同 server 備註同一口徑） */}
          {region === 'MO' && (
            <p className="mt-2 text-[13px] leading-relaxed text-txt-3">
              澳門單・不包郵・順豐到付
            </p>
          )}
          {region === 'OVERSEAS' && (
            <p
              className="mt-2 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed"
              style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
            >
              海外訂單・不包郵——只支援送貨上門，運費到付
            </p>
          )}
        </div>

        {/* 取貨方式（順豐站／智能櫃自取要去下面揀站點；國外單只可以送貨上門） */}
        <div className="mt-5">
          <span className="text-sm text-txt-2">取貨方式</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                ['address', '送貨上門'],
                ['sf_station', '順豐站／自提點／智能櫃'],
              ] as const
            ).map(([value, label]) => {
              // v2.2.27（老闆指令「一個按鈕搞掂」）：自取一粒制——揀站時自動歸類；
              // 自取制亮起條件＝非送貨上門（揀咗智能櫃自動轉 sf_locker 都照樣亮）
              const active =
                value === 'address'
                  ? deliveryMethod === 'address'
                  : deliveryMethod !== 'address';
              const disabled = region === 'OVERSEAS' && value !== 'address';
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    if (!disabled && !active) onMethodChange(value);
                  }}
                  disabled={disabled}
                  aria-pressed={active}
                  className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border px-2 text-center text-[13px] leading-[1.25] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  style={
                    active
                      ? {
                          borderColor: 'var(--pink)',
                          background: 'var(--pink-haze)',
                          color: 'var(--txt-1)',
                          fontWeight: 600,
                        }
                      : {
                          borderColor: 'var(--space-line)',
                          background: 'var(--space-2)',
                          color: 'var(--text-3)',
                        }
                  }
                >
                  {/* 選中提示點（radar-node 式發光環，靜態 box-shadow 唔會觸發動畫限制） */}
                  {active && value !== 'address' && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: 'var(--pink)',
                        boxShadow: '0 0 0 3px rgba(254,1,126,0.22)',
                      }}
                      aria-hidden="true"
                    />
                  )}
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 自取站點（v2.1.0）：地區分組下拉揀站（必揀），唔再自由填字 */}
        {effectiveMethod !== 'address' && (
          <div className="mt-4">
            <RegionStationPicker
              region={region === 'MO' ? 'MO' : 'HK'}
              method={effectiveMethod}
              value={stationId}
              onChange={(id, _name, type) => {
                setStationId(id);
                if (error) setError(null);
                // v2.2.25：附近清單揀咗邊型，類別自動跟（順豐站／自提點→sf_station；智能櫃→sf_locker）
                if (type === 'SF_LOCKER') setDeliveryMethod('sf_locker');
                else if (type === 'SF_STATION' || type === 'SERVICE_POINT') setDeliveryMethod('sf_station');
              }}
            />
            <p className="mt-2 text-[13px] text-txt-3">落單前一定要揀返個站點</p>
          </div>
        )}

        {deliveryMethod === 'address' && savedAddress && (
          <div className="mt-4">
            <span className="text-sm text-txt-2">會員地址</span>
            <button
              type="button"
              onClick={() => setAddress(savedAddress)}
              aria-pressed={address.trim() === savedAddress}
              className="mt-2 flex w-full items-start gap-2.5 rounded-xl border p-3.5 text-left transition-colors"
              style={
                address.trim() === savedAddress
                  ? { borderColor: 'var(--pink)', background: 'var(--pink-haze)' }
                  : { borderColor: 'var(--space-line)', background: 'var(--space-2)' }
              }
            >
              <MapPin size={16} className="mt-0.5 shrink-0 text-pink" aria-hidden="true" />
              <span>
                <span className="block text-[13px] font-bold text-txt-1">
                  {address.trim() === savedAddress ? '已用會員地址 ✓' : '一撳用返會員地址'}
                </span>
                <span className="mt-0.5 block whitespace-pre-wrap text-[13px] leading-relaxed text-txt-3">
                  {savedAddress}
                </span>
              </span>
            </button>
          </div>
        )}

        <div className="mt-4">
          <label htmlFor="checkout-address" className="text-sm text-txt-2">
            收貨地址（選填）
          </label>
          <textarea
            id="checkout-address"
            rows={3}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="住宅地址 / 順豐站 / 智能櫃 / 自取點…"
            className="mt-2 w-full rounded-xl border bg-space-2 p-4 text-[15px] leading-relaxed text-txt-1 placeholder:text-txt-disabled focus:border-pink"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </div>

        <div className="mt-4">
          <label htmlFor="checkout-note" className="text-sm text-txt-2">
            備註（選填）
          </label>
          <textarea
            id="checkout-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：想邊日收貨、直播講過嘅要求…"
            className="mt-2 w-full rounded-xl border bg-space-2 p-4 text-[15px] leading-relaxed text-txt-1 placeholder:text-txt-disabled focus:border-pink"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </div>

        {error && (
          <p role="alert" className="mt-4 flex items-center gap-2 text-[13px] text-pink-soft">
            <StarGlyph size={12} className="shrink-0" />
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={createOrder.isPending}
          className="btn btn-primary mt-6 w-full disabled:opacity-70"
        >
          {createOrder.isPending ? <WishStarSpinner /> : '建立訂單，去付款'}
        </button>
        <p className="mt-3 text-center text-[13px] text-txt-3">
          建立訂單後先好過數，購物車會即時清空
        </p>
      </div>
    </div>
  );
}

/* ---------- ② 付款（網上即時付款 + 手動過數收款資料 + 截圖上傳） ---------- */
interface PaymentStepProps {
  order: CreatedOrder;
  onDone: () => void;
}

function PaymentStep({ order, onDone }: PaymentStepProps) {
  const utils = trpc.useUtils();
  const attachProof = trpc.orders.attachPaymentProof.useMutation();
  // 收款方式（2026-08-08 Glo 要求）：全網統一來源 siteSettings，後台改咗即時同步；冇設定用預設
  const methodsQuery = trpc.settings.get.useQuery({ key: PAYMENT_METHODS_SETTING_KEY });
  const methodsEntry = methodsQuery.data as { key: string; value: string } | null | undefined;
  const paymentMethods = parsePaymentMethods(methodsEntry?.value);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ---------- 網上即時付款（Airwallex HPP）：mutation 話未配置（enabled:false）就成區收起 ---------- */
  const createPayment = trpc.airwallex.createPayment.useMutation();
  const [airwallexUnavailable, setAirwallexUnavailable] = useState(false);
  const [payOnlineError, setPayOnlineError] = useState<string | null>(null);

  const onPayOnline = async () => {
    setPayOnlineError(null);
    try {
      // 契約（2026-09-29 hotfix）：{ enabled:true, intentId, clientSecret, env, currency, returnUrl }
      // → 官方 SDK redirectToCheckout 跳 HPP；{ enabled:false } → 收區
      const result = (await createPayment.mutateAsync({ orderId: order.id })) as {
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
      // 後端會擲中文 TRPCError，照原樣顯示（同 /payment 頁 payOnlineError 做法）
      setPayOnlineError(err instanceof Error ? err.message : '未能開啟網上付款，請稍後再試');
    }
  };

  // preview object URL 要記得 revoke
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onSelect = (selected: File) => {
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  };

  const onUpload = async () => {
    if (!file) {
      setError('請先揀返張付款截圖');
      return;
    }
    setError(null);
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

      // 2) 將 path 掛上訂單（狀態轉 payment_review）
      await attachProof.mutateAsync({ orderId: order.id, imagePath: data.path });
      void utils.orders.myOrders.invalidate();
      onDone();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(friendlyUploadError(err));
      setUploading(false);
    }
  };

  return (
    <>
      {/* 網上即時付款（主角，喺手動過數之前；Airwallex 未配置 → 成區唔 render） */}
      {!airwallexUnavailable && (
        <div
          className="mx-auto mt-10 max-w-2xl rounded-2xl border p-6 text-center md:p-8"
          style={{
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderColor: 'var(--gold)',
            boxShadow: '0 0 48px color-mix(in srgb, var(--gold) 12%, transparent)',
          }}
        >
          <span
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
          >
            <CreditCard size={22} aria-hidden="true" />
          </span>
          <h2 className="mt-4 font-serif-tc text-xl font-semibold leading-[1.3] text-txt-1">
            網上即時付款
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[14px] leading-[1.75] text-txt-2">
            信用卡 / AlipayHK / FPS / PayMe，由 Airwallex 安全處理
          </p>
          <ul
            className="mt-4 flex flex-wrap items-center justify-center gap-2"
            aria-label="支援嘅網上付款方式"
          >
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

          {payOnlineError && (
            <p role="alert" className="mt-4 text-[13px] leading-relaxed text-pink-soft">
              {payOnlineError}
            </p>
          )}

          <button
            type="button"
            onClick={() => void onPayOnline()}
            disabled={createPayment.isPending}
            className="btn btn-primary mt-6 w-full disabled:opacity-70"
          >
            {createPayment.isPending ? (
              <>
                <WishStarSpinner size={16} />
                正在開啟安全付款頁…
              </>
            ) : (
              // v2.5.0（購物金）：網上付款淨收尾數（購物金部分落單時已扣）
              <>💳 網上即時付款 {formatHKD(order.total - (order.walletUsed ?? 0))}</>
            )}
          </button>
          <p className="mt-3 text-[12px] leading-relaxed text-txt-3">
            {ONLINE_PAYMENT_FEE_NOTE}
          </p>
        </div>
      )}

      {/* 「或」分隔線（網上付款區收咗就唔使分隔） */}
      {!airwallexUnavailable && (
        <div className="mt-10 flex items-center gap-4" aria-hidden="true">
          <span className="h-px min-w-4 flex-1" style={{ background: 'var(--space-line)' }} />
          <span className="font-mono text-xs tracking-[0.2em] text-txt-3">或</span>
          <span className="h-px min-w-4 flex-1" style={{ background: 'var(--space-line)' }} />
        </div>
      )}

      {/* mobile 單欄要 minmax(0,1fr)：auto track 會用 max-content，長檔名/mono 字串會撐爆 */}
      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* 左：手動過數收款資料卡 */}
      <div
        className="h-fit rounded-2xl border p-6"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">
          手動過數（FPS／PayMe／AlipayHK）
        </h2>
        <p className="mt-4 text-sm text-txt-2">
          {/* v2.5.0（購物金）：用咗購物金嘅單，呢度淨係找尾數 */}
          {(order.walletUsed ?? 0) > 0 ? '應付尾數（購物金已扣減）' : '應付金額'}
        </p>
        <p className="mt-1 font-mono text-[32px] leading-[1.2] text-pink">
          {formatHKD(order.total - (order.walletUsed ?? 0))}
        </p>
        {(order.walletUsed ?? 0) > 0 && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-gold">
            <Wallet size={13} aria-hidden="true" />
            購物金已扣 {formatHKD(order.walletUsed ?? 0)}（訂單總額 {formatHKD(order.total)}）
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm text-txt-3">訂單編號</span>
          <span className="font-mono text-sm text-txt-1">{order.orderNo}</span>
          <CopyButton text={order.orderNo} />
        </div>

        <ul className="mt-6 space-y-3">
          {paymentMethods.map((method) => (
            <li
              key={method.id}
              className="flex items-center justify-between gap-4 rounded-xl border p-4"
              style={{
                borderColor: 'var(--glass-border)',
                background: 'rgba(255,255,255,.03)',
              }}
            >
              <div className="min-w-0">
                <p className="font-medium text-txt-1">{method.label}</p>
                {/* mono 長帳號字串：break-all 等佢可以斷行，唔會撐爆手機闊度 */}
                <p className="mt-1 break-all font-mono text-sm text-lavender">{method.account}</p>
                <p className="mt-0.5 text-[13px] text-txt-3">
                  {method.extraLabel && method.extraValue
                    ? `${method.extraLabel}：${method.extraValue}`
                    : method.subtitle}
                </p>
              </div>
              <CopyButton text={method.account} />
            </li>
          ))}
        </ul>

        <p className="mt-5 text-[13px] leading-relaxed text-txt-3">
          過數嗰陣喺備註寫返訂單編號，對數會快啲。過完數喺右邊上傳截圖。
        </p>
      </div>

      {/* 右：付款截圖上傳 */}
      <div
        className="h-fit rounded-2xl border p-6"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">上傳付款截圖</h2>
        <div className="mt-4">
          <PaymentDropzone
            file={file}
            previewUrl={previewUrl}
            disabled={uploading}
            onSelect={onSelect}
          />
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-txt-3">
          上傳後 Glo Glo 團隊會盡快對數，當審核完成，訂單將安排同事出貨 💫
        </p>
        {/* 2026-07-30 落單規則：48 小時內要傳截圖，否則訂單自動取消（2026-08-04 起收緊做 48 小時） */}
        <p
          className="mt-3 rounded-xl border px-4 py-3 text-[13px] leading-relaxed"
          style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
        >
          ⏳ 請於落單後 <strong>48 小時內</strong>上傳付款截圖，逾期待付款訂單會自動取消，貨品唔會留貨。
        </p>

        {error && (
          <p role="alert" className="mt-3 flex items-center gap-2 text-[13px] text-pink-soft">
            <StarGlyph size={12} className="shrink-0" />
            {error}
          </p>
        )}

        {uploading ? (
          <MeteorProgressBar />
        ) : (
          <button
            type="button"
            onClick={() => void onUpload()}
            disabled={!file || attachProof.isPending}
            className="btn btn-primary mt-5 w-full disabled:opacity-50"
          >
            上傳付款截圖
          </button>
        )}
      </div>
      </div>
    </>
  );
}

/* ---------- ③ 完成 ---------- */
function SuccessStep({ order }: { order: CreatedOrder }) {
  const whatsappTrack = `${WHATSAPP_URL}?text=${encodeURIComponent(
    `你好，想查詢訂單 ${order.orderNo} 嘅狀態`,
  )}`;
  // v2.5.0（購物金）：全額購物金單冇截圖呢回事——成功頁講返係購物金找晒
  const walletFullyPaid =
    order.status === 'payment_review' &&
    (order.walletUsed ?? 0) > 0 &&
    order.total - (order.walletUsed ?? 0) <= 0;

  return (
    <div className="mt-14 flex flex-col items-center pb-8 text-center">
      <WishStarBurst />
      <p className="script mt-8 text-4xl md:text-5xl">Thank you, wish granted!</p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <span className="text-sm text-txt-3">訂單編號</span>
        <span className="font-mono text-xl text-txt-1 md:text-2xl">{order.orderNo}</span>
        <CopyButton text={order.orderNo} label="複製訂單編號" />
      </div>

      {walletFullyPaid ? (
        <p className="mt-5 max-w-md text-[15px] leading-relaxed text-txt-2">
          已全數用購物金支付（{formatHKD(order.walletUsed ?? 0)}），而家
          <span className="font-medium text-gold">職員審核中</span>。
          當審核完成，訂單將安排同事出貨。
          你可以隨時去會員中心睇訂單狀態。
        </p>
      ) : (
        <p className="mt-5 max-w-md text-[15px] leading-relaxed text-txt-2">
          付款截圖已收到，而家<span className="font-medium text-gold">職員審核中</span>。
          當審核完成，訂單將安排同事出貨。
          你可以隨時去會員中心睇訂單狀態。
        </p>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-4">
        <Link to="/account" className="btn btn-primary">
          去會員中心睇訂單
        </Link>
        <a
          href={whatsappTrack}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-whatsapp"
        >
          <MessageCircle size={16} aria-hidden="true" />
          WhatsApp 追蹤訂單
        </a>
      </div>
    </div>
  );
}

/* ---------- 頁面 ---------- */
export default function Checkout() {
  const { user, isLoading: authLoading } = useAuth();

  const cartQuery = trpc.cart.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  // v2.2.0 級別格調帶：同 Navbar 同一來源 vip.getMyVip；載入緊唔顯示
  const myVipQuery = trpc.vip.getMyVip.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const vipTier = myVipQuery.data ? normalizeVipTier(myVipQuery.data.tier) : null;

  const [step, setStep] = useState(0);
  const [order, setOrder] = useState<CreatedOrder | null>(null);

  // refresh 還原（2026-09-29 hotfix）：建立訂單後 orderId 會寫落 URL query；
  // 如果客人喺付款步驟 refresh，頁面 state 冇咗、購物車又已清空——與其顯示
  // 「購物車係空嘅」令客人迷失，直接送佢去付款頁（/#/payment?orderId=）繼續畀錢
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const resumeOrderId = Number(searchParams.get('orderId') || 0);

  useEffect(() => {
    if (authLoading || !user || order || !(resumeOrderId > 0)) return;
    navigate(`/payment?orderId=${resumeOrderId}`, { replace: true });
  }, [authLoading, user, order, resumeOrderId, navigate]);

  const items = (cartQuery.data ?? []) as CartLine[];

  const renderStep = () => {
    if (step === 2 && order) return <SuccessStep order={order} />;
    if (step === 1 && order) {
      return <PaymentStep order={order} onDone={() => setStep(2)} />;
    }
    if (cartQuery.isLoading) {
      return (
        <div className="mt-10 space-y-4" aria-label="訂單載入中">
          {[0, 1].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-space-2" />
          ))}
        </div>
      );
    }
    if (cartQuery.isError) {
      return (
        <div
          className="mx-auto mt-12 max-w-[420px] rounded-3xl border p-8 text-center"
          style={{ background: 'var(--glass-bg-strong)', borderColor: 'var(--glass-border)' }}
        >
          <p role="alert" className="text-[15px] text-pink-soft">
            購物車載入失敗：{cartQuery.error.message}
          </p>
          <button
            type="button"
            className="btn btn-secondary mt-6"
            onClick={() => void cartQuery.refetch()}
          >
            再試一次
          </button>
        </div>
      );
    }
    return (
      <ConfirmStep
        items={items}
        onCreated={(created) => {
          setOrder(created);
          // v2.5.0（購物金）：全額購物金單一落單即轉待審批（server 已將 status 轉
          // payment_review），唔使經付款步驟，直去成功頁；尾數 > 0 先落入付款步驟
          const cashDue = created.total - (created.walletUsed ?? 0);
          const walletFullyPaid = created.status === 'payment_review' && cashDue <= 0;
          setStep(walletFullyPaid ? 2 : 1);
          if (walletFullyPaid) return; // 唔使寫 orderId 落 URL——冇付款步驟要還原
          // 寫低 orderId 落 URL——refresh 之後上面個 effect 會送客人返去付款頁繼續
          setSearchParams({ orderId: String(created.id) }, { replace: true });
        }}
      />
    );
  };

  return (
    <section className="mx-auto max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      <p className="script text-3xl">Checkout</p>
      <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
        結帳
      </h1>

      {/* v2.2.0 級別格調帶：VIP 出 hairline 金線＋淡底＋專屬短句；普通會員低調升級提示 */}
      {user && vipTier && <VipTierBand tier={vipTier} />}

      {authLoading ? (
        <div className="mt-10 h-24 animate-pulse rounded-2xl bg-space-2" aria-label="載入中" />
      ) : !user ? (
        <LoginPrompt message="登入會員之後，先可以結帳同上傳付款截圖。" />
      ) : (
        <>
          <StepBar step={step} />
          {renderStep()}
        </>
      )}
    </section>
  );
}
