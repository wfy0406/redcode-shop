import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BadgeCheck,
  Bell,
  Clapperboard,
  Facebook,
  MessageCircle,
  Play,
  ShoppingBag,
} from 'lucide-react';
import ProductCard from '@/components/ProductCard';
import DuotoneImage from '@/components/DuotoneImage';
import MovingPhoto from '@/components/MovingPhoto';
import FacebookPageEmbed from '@/components/FacebookPageEmbed';
import { PRODUCTS } from '@/data/products';
import type { Product } from '@/data/products';
import { useReveal } from '@/hooks/useReveal';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import LiveNowSection from '@/components/push/LiveNowSection';
import LiveTopBanner from '@/components/push/LiveTopBanner';
import PushPermissionGuide from '@/components/push/PushPermissionGuide';

/** DB 商品 row → ProductCard 用嘅 Product 形狀 */
function mapDbProduct(p: {
  id: number;
  name: string;
  sku: string;
  price: number;
  discountPrice: number | null;
  sizes: string | null;
  listedDate: Date;
  image: string;
  stock: number;
}): Product {
  return {
    id: String(p.id),
    name: p.name,
    sku: p.sku,
    price: p.price,
    discountPrice: p.discountPrice ?? undefined,
    sizes: p.sizes ? p.sizes.split(',').map((s) => s.trim()) : undefined,
    listedAt: p.listedDate.toISOString().slice(0, 10),
    image: p.image,
    soldOut: p.stock <= 0,
  };
}

/**
 * RedCode 首頁（design-system.md §P1 + §4.3 Hero 構圖）
 * 1. Hero：動態星空 + radial burst + 花體襯字 + 主標 + CTA + 散佈浮卡
 * 2. WhatsApp 群組 Banner（sticky，加入群組 CTA）
 * 3. 新品上架：最新 8 件（4 欄商品卡）+ scroll reveal stagger
 *    （v2.2.13 老闆指令：今晚精選成區刪走——同新品上架撞定位）
 * 4. Facebook 直播專區（page plugin + CTA panel）
 * 4.5 公司宣傳影片回顧（promo-1 橫片 + promo-2 直片）
 * 5. 品牌故事條 + Glo Glo 主播介紹
 * 6. 客戶打卡牆（IG 風格横 scroll）
 * 7. WhatsApp CTA 區塊
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
const FACEBOOK_URL = 'https://www.facebook.com/redcodexhk';

/* ---------- Hero CTA pointer spotlight（musepool 方向，GPU-only） ----------
   pointermove/pointerdown 將指針相對座標寫入 --mx/--my CSS 變數；
   光暈層用 transform: translate3d(calc(var(--mx)…)) 跟手，唔郁 layout 屬性。
   手機無 hover：pointerdown 嗰下光暈喺觸點閃一下（opacity 交俾 :active）。 */
function trackCtaSpotlight(e: ReactPointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
  el.style.setProperty('--my', `${e.clientY - rect.top}px`);
}

/* ---------- §4.3 Hero 浮卡（拍立得樣式 + scroll 視差） ---------- */
interface FloatCardProps {
  src: string;
  caption: string;
  rotate: number;
  parallax: number;
  className?: string;
  dim?: boolean;
  /** v2.2.31（老闆指令「首頁果2張相要動態」）：有 mp4 就用 MovingPhoto 播動態版 */
  videoSrc?: string;
}

function FloatCard({ src, caption, rotate, parallax, className, dim, videoSrc }: FloatCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.transform = `translateY(${window.scrollY * parallax * -0.15}px) rotate(${rotate}deg)`;
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [rotate, parallax]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`pointer-events-none absolute rounded-2xl border bg-space-2 p-2 pb-3 ${className ?? ''}`}
      style={{
        borderColor: 'var(--glass-border)',
        transform: `rotate(${rotate}deg)`,
        filter: dim ? 'brightness(.7) blur(1px)' : undefined,
      }}
    >
      {videoSrc ? (
        // v2.2.31：動態浮卡（揮手／抱抱，人樣唔郁）；reduced-motion／mp4 未就位 → 靜態相兜底
        <MovingPhoto
          eager
          videoSrc={videoSrc}
          poster={src}
          alt=""
          wrapperClassName="rounded-xl"
          imgClassName="h-full max-h-40 w-full object-cover"
        />
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full max-h-40 w-full rounded-xl object-cover"
        />
      )}
      <p className="script mt-1.5 text-center text-base leading-none">{caption}</p>
    </div>
  );
}

/* ---------- 宣傳影片（404 → 玻璃提示卡 fallback） ---------- */
function PromoVideo({ src, poster, className }: { src: string; poster: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center ${className ?? ''}`}
        style={{
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
        role="img"
        aria-label="影片即將上架"
      >
        <Clapperboard size={28} className="text-purple-text" aria-hidden="true" />
        <p className="script text-2xl leading-none text-pink-tint">影片即將上架 ♡</p>
        <p className="text-[13px] text-txt-3">宣傳影片準備中，敬請期待</p>
      </div>
    );
  }

  return (
    <video
      src={src}
      poster={poster}
      controls
      muted
      loop
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
      className={`h-full w-full object-cover ${className ?? ''}`}
    />
  );
}

/* ---------- Section 標題（v2.2.0 atelier：大寫闊字距 label＋serif 標題＋hairline 金線） ---------- */
function SectionHeading({ en, zh, center }: { en: string; zh: string; center?: boolean }) {
  return (
    <div className={center ? 'flex flex-col items-center text-center' : ''}>
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">{en}</p>
      <h2 className="mt-3 font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
        {zh}
      </h2>
      <span
        aria-hidden="true"
        className="mt-4 block h-px w-24 opacity-40"
        style={{ background: 'var(--gold)' }}
      />
    </div>
  );
}

/* ---------- Section 之間嘅 hairline 金線分隔（唔准卡叠卡，用線唔用影） ---------- */
function HairlineDivider() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto mt-10 max-w-[1280px] px-5 md:mt-14 md:px-8 xl:px-12"
    >
      <span
        className="block h-px w-full opacity-20"
        style={{ background: 'var(--gold)' }}
      />
    </div>
  );
}

/* ---------- 客戶打卡牆靜態 fallback（API 失敗或未有資料時用，保證永遠有嘢睇） ---------- */
const STATIC_WALL_PHOTOS = [
  { src: '/gloglo-3.jpg', alt: 'Glo Glo 聖誕造型打卡' },
  { src: '/gloglo-4.jpg', alt: 'Glo Glo 同店狗合照一' },
  { src: '/gloglo-1.jpg', alt: 'Glo Glo 白西裝造型打卡' },
  { src: '/gloglo-5.jpg', alt: 'Glo Glo 生活照打卡' },
  { src: '/promo-1-poster.jpg', alt: '公司宣傳拍攝打卡' },
  { src: '/gloglo-2.jpg', alt: 'Glo Glo 同店狗合照二' },
];

/* ---------- 直播開播通知常設入口（v2.2.0）：冇直播都見到 ----------
   未登入 → Link /login；登入未訂閱 → PushPermissionGuide；已訂閱 →「已開啟通知 ✓」
   （邏輯一字唔郁；淨係換皮融入 hero CTA pill cluster，第四粒 ghost 掣） */
function LivePushEntry() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [showGuide, setShowGuide] = useState(false);
  const statusQuery = trpc.push.myPushStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const subscribed =
    !!statusQuery.data?.optIn && (statusQuery.data?.activeDevices ?? 0) > 0;

  if (!user) {
    return (
      <div
        className="hero-enter col-span-2 h-full sm:col-span-1"
        style={{ animationDelay: '0.89s' }}
      >
        <Link
          to="/login"
          onPointerMove={trackCtaSpotlight}
          onPointerDown={trackCtaSpotlight}
          className="hero-cta hero-cta-ghost h-full w-full sm:w-auto"
        >
          <span aria-hidden="true" className="hero-cta-glow hero-cta-glow-gold" />
          <span className="relative z-10 inline-flex items-center justify-center gap-2">
            <Bell size={15} aria-hidden="true" className="shrink-0" />
            <span className="cta-flip">
              <span className="cta-flip-inner">
                <span className="cta-label">
                  <span className="cta-micro">LIVE ALERT</span>
                  <span className="cta-title">接收直播開播通知</span>
                </span>
                <span aria-hidden="true" className="cta-label">
                  <span className="cta-micro">LIVE ALERT</span>
                  <span className="cta-title">接收直播開播通知</span>
                </span>
              </span>
            </span>
          </span>
        </Link>
      </div>
    );
  }

  if (subscribed) {
    // 已訂閱 → 被動狀態 pill（唔係掣）：呼吸粉點 + BadgeCheck + 雙行標籤，融入 cluster
    return (
      <span
        className="hero-enter col-span-2 h-full sm:col-span-1"
        style={{ animationDelay: '0.89s' }}
      >
        <span role="status" className="cta-status-pill w-full sm:w-auto">
          <span aria-hidden="true" className="cta-status-dot" />
          <BadgeCheck size={15} aria-hidden="true" className="shrink-0 text-gold" />
          <span className="cta-label">
            <span className="cta-micro">LIVE ALERT ON</span>
            <span className="cta-title">已開啟通知</span>
          </span>
        </span>
      </span>
    );
  }

  return (
    <div
      className="hero-enter col-span-2 h-full sm:col-span-1"
      style={{ animationDelay: '0.89s' }}
    >
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        onPointerMove={trackCtaSpotlight}
        onPointerDown={trackCtaSpotlight}
        className="hero-cta hero-cta-ghost h-full w-full sm:w-auto"
      >
        <span aria-hidden="true" className="hero-cta-glow hero-cta-glow-gold" />
        <span className="relative z-10 inline-flex items-center justify-center gap-2">
          <Bell size={15} aria-hidden="true" className="shrink-0" />
          <span className="cta-flip">
            <span className="cta-flip-inner">
              <span className="cta-label">
                <span className="cta-micro">LIVE ALERT</span>
                <span className="cta-title">接收直播開播通知</span>
              </span>
              <span aria-hidden="true" className="cta-label">
                <span className="cta-micro">LIVE ALERT</span>
                <span className="cta-title">接收直播開播通知</span>
              </span>
            </span>
          </span>
        </span>
      </button>
      <PushPermissionGuide
        open={showGuide}
        onClose={(ok) => {
          setShowGuide(false);
          if (ok) {
            void utils.push.myPushStatus.invalidate();
            void utils.auth.me.invalidate();
          }
        }}
      />
    </div>
  );
}

/* ---------- v2.2.2（老闆指令）：VIP 三級首頁主題色 ----------
   普通會員＝品牌原色；銀會員＝銀月色系；金會員＝璀璨金色系。
   做法：淨係喺 Home 最外層 div 覆寫 CSS 變數（--gold 系），
   全頁所有 var(--gold) 引用自動轉色，唔郁其他頁。 */
type VipTier = 'NONE' | 'SILVER' | 'GOLD';

const TIER_HOME_VARS: Record<VipTier, CSSProperties> = {
  NONE: {},
  SILVER: {
    // 銀月：金位轉冷冽銀藍
    ['--gold' as string]: '#CBD6E4',
    ['--gold-soft' as string]: '#E6EDF6',
  },
  GOLD: {
    // 璀璨金：金位再亮起啲，帶蜜糖暖意
    ['--gold' as string]: '#FFD24A',
    ['--gold-soft' as string]: '#FFE28F',
  },
};

const TIER_BADGE: Record<VipTier, { label: string; color: string; border: string; bg: string; shimmer: boolean }> = {
  NONE: {
    label: '寶寶會員',
    color: 'var(--pink-tint)',
    border: 'rgba(255, 143, 191, 0.4)',
    bg: 'rgba(255, 0, 84, 0.12)',
    shimmer: false,
  },
  SILVER: {
    label: '銀會員 SILVER',
    color: '#1B1336',
    border: 'rgba(230, 237, 246, 0.85)',
    bg: 'linear-gradient(100deg, #E6EDF6 0%, #B9C6D8 100%)',
    shimmer: true,
  },
  GOLD: {
    label: '金會員 GOLD ✦',
    color: '#0A0614',
    border: 'rgba(255, 210, 74, 0.95)',
    bg: 'linear-gradient(100deg, #FFE28F 0%, #F5C518 55%, #D9A40E 100%)',
    shimmer: true,
  },
};

/**
 * 會員招呼（v2.2.2 老闆指令；v2.2.3 排版修正）
 * 老闆 feedback：唔好累贅、有效期唔洗喺主頁寫、要強調會員等級。
 * → 級別徽章做主角（金/銀金屬漸層＋掃光 shimmer），旁邊一句短招呼，到期日唔顯示。
 */
function MemberGreeting() {
  const { user } = useAuth();
  if (!user) return null;
  const tier = (user.vipTier ?? 'NONE') as VipTier;
  const badge = TIER_BADGE[tier];
  const firstName = user.name?.trim() || '寶寶';
  return (
    <div
      className="hero-enter mb-5 flex items-center gap-3"
      style={{ animationDelay: '0.35s' }}
    >
      {/* 級別徽章：主角位。金銀係金屬漸層＋掃光（淨 transform/opacity，合鐵律） */}
      <span
        className="tier-badge relative inline-flex shrink-0 items-center overflow-hidden rounded-full border px-3.5 py-1.5 font-mono text-[12px] font-bold tracking-[0.14em]"
        style={{ color: badge.color, borderColor: badge.border, background: badge.bg }}
      >
        {badge.label}
        {badge.shimmer && (
          <span
            aria-hidden="true"
            className="tier-badge-shine pointer-events-none absolute inset-y-0 w-1/3"
            style={{
              background:
                'linear-gradient(105deg, transparent 0%, rgba(255,255,255,0.55) 50%, transparent 100%)',
            }}
          />
        )}
      </span>
      <p className="font-serif-tc text-[15px] font-semibold text-starlight md:text-base">
        {firstName}寶寶，歡迎返嚟 ✦
      </p>
      <style>{`
        .tier-badge-shine { animation: tier-shine 3.2s ease-in-out infinite; }
        @keyframes tier-shine {
          0% { transform: translateX(-160%) skewX(-12deg); opacity: 0; }
          25% { opacity: 1; }
          60% { transform: translateX(360%) skewX(-12deg); opacity: 1; }
          75%, 100% { transform: translateX(360%) skewX(-12deg); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) { .tier-badge-shine { animation: none; opacity: 0; } }
      `}</style>
    </div>
  );
}

export default function Home() {
  const { user } = useAuth();
  // v2.2.2：跟會員級別轉首頁色調（未登入／普通會員＝原色）
  const homeTier = (user?.vipTier ?? 'NONE') as VipTier;
  // 後端連唔到（純前端預覽）時 fallback 用內建示範商品
  const { data: dbProducts, isError: productsError } = trpc.products.list.useQuery(
    {},
    { retry: false },
  );
  const allProducts =
    productsError || !dbProducts ? PRODUCTS : dbProducts.map(mapDbProduct);
  // 2026-09（Glo 要求）：新品上架只顯示最新 8 件，唔再成版碌極未完；
  // 其餘商品經「睇全部商品 →」去 /products 睇晒
  const newArrivals = allProducts.slice(0, 8);

  // 客戶打卡牆：API 失敗或空陣列 → 靜態 6 張預設相
  const { data: praiseData, isError: praiseError } = trpc.praise.list.useQuery(undefined, {
    retry: false,
  });
  const wallPhotos =
    !praiseError && praiseData && praiseData.length > 0
      ? praiseData.map((p) => ({
          key: `praise-${p.id}`,
          src: p.image,
          alt: p.caption ?? '客戶打卡分享',
          caption: p.caption ?? undefined,
        }))
      : STATIC_WALL_PHOTOS.map((p) => ({
          key: `static-${p.src}`,
          src: p.src,
          alt: p.alt,
          caption: undefined as string | undefined,
        }));
  const newRef = useReveal<HTMLDivElement>();
  const liveRef = useReveal<HTMLDivElement>();
  const promoRef = useReveal<HTMLDivElement>();
  const storyRef = useReveal<HTMLDivElement>();
  const wallRef = useReveal<HTMLDivElement>();
  const waRef = useReveal<HTMLDivElement>();

  return (
    <div style={TIER_HOME_VARS[homeTier]}>
      {/* ============ 0. 直播頂部 Banner（v2.2.2）：有直播先入嚟即見，撳咗落 #live-now ============ */}
      <LiveTopBanner />

      {/* ============ 1. Hero（§4.3 全構圖） ============ */}
      <section className="relative flex min-h-[100dvh] items-center overflow-hidden">
        {/* v2.2.0：member-hero.jpg 絲綢珍珠 flat-lay 做底（左側留白，文字擺左）＋深色漸層保證可讀 */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-right"
          style={{ backgroundImage: 'url(/vip/member-hero.jpg)' }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(10,6,20,.94) 0%, rgba(10,6,20,.80) 38%, rgba(10,6,20,.45) 68%, rgba(10,6,20,.30) 100%)',
          }}
        />
        {/* 底部漸隱返 space-1 */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-40"
          style={{ background: 'linear-gradient(180deg, transparent 0%, var(--space-1) 100%)' }}
        />

        {/* 散佈浮卡（文字之下/兩側，常態旋轉，scroll 視差） */}
        <FloatCard
          src="/gloglo-1.jpg"
          caption="last night live ♡"
          rotate={-4}
          parallax={0.8}
          className="right-[6%] top-[14%] hidden w-52 md:block"
        />
        {/* v2.2.31（老闆指令）：換做後備池 replay-29 嗰張（抱住今晚嘅衫＝tonight's pick），動態抱抱 */}
        <FloatCard
          src="/home/card-hug.jpg"
          videoSrc="/home/card-hug.mp4"
          caption="tonight's pick"
          rotate={3}
          parallax={0.5}
          className="bottom-6 right-4 w-28 sm:w-32 md:bottom-[10%] md:right-[8%] lg:bottom-[16%] lg:right-[22%] lg:w-44"
        />
        <FloatCard
          src="/gloglo-2.jpg"
          caption="wish granted ✦"
          rotate={-2}
          parallax={0.3}
          dim
          className="bottom-[8%] right-[4%] hidden w-40 xl:block"
        />
        {/* 手機版：細卡移去文字段以下左下角（唔再壓主標/介紹段），右下係 tonight's pick 卡 */}
        {/* v2.2.31（老闆指令）：同關於我們對調——花裙轉圈動態相放首頁左下角，眼鏡揮手搬咗去主播專區 */}
        <FloatCard
          src="/home/card-dress.jpg"
          videoSrc="/home/card-dress.mp4"
          caption="live ♡"
          rotate={-4}
          parallax={0.8}
          className="bottom-6 left-4 w-24 md:hidden"
        />

        {/* 文字區：左對齊，佔欄 1–7；手機版底部留 220px 俾浮卡（v2.2.5 老闆指令：
            「去最新直播款」同浮卡重疊——greeting 令文字區長咗，CTA 跌落浮卡位） */}
        <div className="relative z-10 mx-auto w-full max-w-[1280px] px-5 pb-[220px] pt-16 md:px-8 md:pb-24 xl:px-12">
          <div className="max-w-2xl">
            {/* v2.2.2（老闆指令）：會員一入首頁就見到「xxx寶寶，歡迎嚟到RedCode！」＋級別徽章 */}
            <MemberGreeting />
            <p
              className="hero-enter font-mono text-[11px] uppercase tracking-[0.3em] text-gold"
              style={{ animationDelay: '0.45s' }}
            >
              RedCode Atelier · Hong Kong
            </p>
            <p
              className="script hero-enter mt-4 text-[28px] leading-[1.3] md:text-[40px]"
              style={{ animationDelay: '0.5s' }}
            >
              Tonight&apos;s picks, written in the stars ✦
            </p>
            <h1
              className="hero-enter mt-4 font-serif-tc text-4xl font-bold leading-[1.15] tracking-[0.02em] text-starlight md:text-[64px]"
              style={{ animationDelay: '0.55s' }}
            >
              今晚嘅衫，
              <br />
              係為你而閃。
            </h1>
            <p
              className="hero-enter mt-6 max-w-lg text-[15px] leading-[1.75] text-txt-2 md:text-base"
              style={{ animationDelay: '0.6s' }}
            >
              RedCode Fashion Design —— 香港女裝直播品牌。主播 Glo Glo 每晚喺 Facebook
              開直播，即場著身、即場開賣。睇啱嘅款，呢度全部搵得返。
            </p>
            {/* Hero CTA 掣組（musepool 方向）：pill cluster，手機 2×2 grid（primary 全闊做主角），
                sm 以上 flex wrap 橫排；hero-enter 0.65s 起逐粒 +80ms stagger。
                光暈/掃光/hover 全部淨係 transform + opacity（GPU-only，唔整慢客人電話）。 */}
            {/* 星光裝飾層包住成個 cluster：absolute 漂移星塵圖喺掣底下，純 transform loop */}
            <div className="relative">
              <div aria-hidden="true" className="cta-sparkle-layer" />
              <div className="relative z-10 mt-10 grid grid-cols-2 items-stretch gap-3 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
                {/* 1. 即睇商品（primary 最搶眼）：實心品牌粉紅 + 獨有 skew 掃光 loop */}
                <div className="hero-enter col-span-2 h-full sm:col-span-1" style={{ animationDelay: '0.65s' }}>
                  <Link
                    to="/products"
                    onPointerMove={trackCtaSpotlight}
                    onPointerDown={trackCtaSpotlight}
                    className="hero-cta hero-cta-primary h-full w-full sm:w-auto"
                  >
                    <span aria-hidden="true" className="hero-cta-glow hero-cta-glow-pink" />
                    <span aria-hidden="true" className="hero-cta-shine" />
                    <span className="relative z-10 inline-flex items-center justify-center gap-2">
                      <ShoppingBag size={18} aria-hidden="true" className="shrink-0" />
                      <span className="cta-flip">
                        <span className="cta-flip-inner">
                          <span className="cta-label">
                            <span className="cta-micro">SHOP NOW</span>
                            <span className="cta-title">即睇商品</span>
                          </span>
                          <span aria-hidden="true" className="cta-label">
                            <span className="cta-micro">SHOP NOW</span>
                            <span className="cta-title">即睇商品</span>
                          </span>
                        </span>
                      </span>
                    </span>
                  </Link>
                </div>
                {/* 2. 追蹤 Facebook 專頁（outline 款 + 箭嘴 micro-interaction） */}
                <div className="hero-enter h-full" style={{ animationDelay: '0.73s' }}>
                  <a
                    href={FACEBOOK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onPointerMove={trackCtaSpotlight}
                    onPointerDown={trackCtaSpotlight}
                    className="hero-cta hero-cta-outline h-full w-full sm:w-auto"
                  >
                    <span aria-hidden="true" className="hero-cta-glow hero-cta-glow-pink" />
                    <span className="relative z-10 inline-flex items-center justify-center gap-2 text-center">
                      <Facebook size={16} aria-hidden="true" className="shrink-0" />
                      <span className="cta-flip">
                        <span className="cta-flip-inner">
                          <span className="cta-label">
                            <span className="cta-micro">FOLLOW US</span>
                            <span className="cta-title">追蹤我地 Facebook 專頁</span>
                          </span>
                          <span aria-hidden="true" className="cta-label">
                            <span className="cta-micro">FOLLOW US</span>
                            <span className="cta-title">追蹤我地 Facebook 專頁</span>
                          </span>
                        </span>
                      </span>
                      <ArrowRight size={14} aria-hidden="true" className="cta-arrow shrink-0" />
                    </span>
                  </a>
                </div>
                {/* 3. 直播重溫（outline/ghost 款）：直達 /live 嘅直播回顧區（Live.tsx 接 state 碌落 #live-history） */}
                <div className="hero-enter h-full" style={{ animationDelay: '0.81s' }}>
                  <Link
                    to="/live"
                    state={{ scrollTo: 'live-history' }}
                    onPointerMove={trackCtaSpotlight}
                    onPointerDown={trackCtaSpotlight}
                    className="hero-cta hero-cta-outline h-full w-full sm:w-auto"
                  >
                    <span aria-hidden="true" className="hero-cta-glow hero-cta-glow-gold" />
                    <span className="relative z-10 inline-flex items-center justify-center gap-2">
                      <Play size={16} aria-hidden="true" className="shrink-0" />
                      <span className="cta-flip">
                        <span className="cta-flip-inner">
                          <span className="cta-label">
                            <span className="cta-micro">LIVE REPLAY</span>
                            <span className="cta-title">直播重溫</span>
                          </span>
                          <span aria-hidden="true" className="cta-label">
                            <span className="cta-micro">LIVE REPLAY</span>
                            <span className="cta-title">直播重溫</span>
                          </span>
                        </span>
                      </span>
                      <ArrowRight size={14} aria-hidden="true" className="cta-arrow shrink-0" />
                    </span>
                  </Link>
                </div>
                {/* 4. 接收直播開播通知（LivePushEntry 邏輯唔郁，換皮融入 cluster） */}
                <LivePushEntry />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ 1.5 直播進行中（v2.2.0）：currentLive 有直播嗰 90 分鐘先 render ============ */}
      <LiveNowSection />

      {/* ============ 2. WhatsApp 群組 Banner ============ */}
      {/* v2.2.13：頂欄加咗 iPhone safe-area padding，呢條 sticky banner 要跟住避開 */}
      <section
        className="sticky top-[calc(60px+env(safe-area-inset-top))] z-30 border-y bg-space-3 md:top-[calc(72px+env(safe-area-inset-top))]"
        style={{ borderColor: 'var(--success)' }}
        aria-label="加入 WhatsApp 群組"
      >
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 md:px-8 xl:px-12">
          <div className="flex items-center gap-3" aria-live="off">
            <span
              className="live-dot"
              style={{ background: 'var(--success)' }}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-txt-2">REDCODE 寶寶群組</span>
          </div>
          <p className="font-serif-tc text-lg font-semibold text-txt-1">
            加入我哋 WhatsApp 群組，最新直播通知、獨家優惠即刻知
          </p>
          <div className="flex items-center gap-4">
            <span className="script hidden text-xl md:inline">join our family ♡</span>
            <a
              href={`${WHATSAPP_URL}?text=${encodeURIComponent('想加入REDCODE WHATSAPP群組')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-whatsapp !px-6 !py-2.5 text-sm"
            >
              <MessageCircle size={16} aria-hidden="true" />
              加入群組
            </a>
          </div>
        </div>
      </section>

      <HairlineDivider />

      {/* ============ 3. 新品上架（4 欄 + scroll reveal stagger） ============ */}
      {/* v2.2.13（老闆指令）：「今晚精選」成區刪走——同新品上架撞定位，留返新品上架一個就夠 */}
      <section className="mx-auto mt-10 max-w-[1280px] px-5 md:mt-14 md:px-8 xl:px-12">
        <div ref={newRef} className="reveal">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <SectionHeading en="New Arrivals" zh="新品上架" />
            <Link
              to="/products"
              className="border-b text-sm font-medium text-pink-soft transition-colors hover:text-pink-tint"
              style={{ borderColor: 'var(--pink)' }}
            >
              睇全部商品 →
            </Link>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-6 xl:grid-cols-4">
            {newArrivals.map((product, i) => (
              <div
                key={product.id}
                className="reveal"
                style={{ transitionDelay: `${Math.min(i * 80, 400)}ms` }}
              >
                <ProductCard product={product} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <HairlineDivider />

      {/* ============ 5. Facebook 直播專區 ============ */}
      <section className="mx-auto mt-10 max-w-[1280px] px-5 md:mt-14 md:px-8 xl:px-12">
        <div ref={liveRef} className="reveal">
          <SectionHeading en="Live Room" zh="Facebook 直播專區" />
          <p className="mt-3 max-w-xl text-[15px] text-txt-2">
            每晚 Glo Glo 都會喺 Facebook 同大家見面。錯過咗直播？
            入專頁可以重溫晒所有場次。
          </p>

          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* FB Page Plugin 嵌入（C4 FacebookPageEmbed 組件，max-width 500px 置中） */}
            <div className="self-start lg:col-span-2">
              <FacebookPageEmbed pageUrl={FACEBOOK_URL} height={600} />
            </div>

            {/* 直播 CTA panel */}
            <div
              className="flex flex-col justify-center gap-4 rounded-2xl border bg-space-2 p-6 lg:col-span-3"
              style={{ borderColor: 'var(--glass-border)' }}
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">
                Live on Facebook
              </p>
              <p className="font-serif-tc text-xl font-semibold leading-[1.4] text-txt-1">
                每晚開播，即場著身、即場開賣
              </p>
              <p className="text-[14px] leading-[1.75] text-txt-2">
                留意專頁直播通知，開播即刻入嚟搶心水款。錯過咗都可以喺專頁重溫所有場次。
              </p>
              <a
                href={FACEBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex w-fit items-center gap-2 border-b pb-1 text-sm font-semibold text-gold-soft transition-opacity hover:opacity-70"
                style={{ borderColor: 'var(--gold)' }}
              >
                <Facebook size={16} aria-hidden="true" />
                去 Facebook 睇直播 →
              </a>
            </div>
          </div>
        </div>
      </section>

      <HairlineDivider />

      {/* ============ 5.5 公司宣傳影片回顧 ============ */}
      <section className="mx-auto mt-10 max-w-[1280px] px-5 md:mt-14 md:px-8 xl:px-12">
        <div ref={promoRef} className="reveal">
          <SectionHeading en="Promo Films" zh="公司宣傳影片回顧" />
          <p className="mt-3 max-w-xl text-[15px] text-txt-2">
            Boss 親身上陣，帶住 Glo Glo 同團隊周圍去——由品牌介紹到台灣掃貨團，一次過重溫。
          </p>
          <div className="mt-8 grid items-start gap-6 lg:grid-cols-3">
            {/* 橫片：品牌篇 */}
            <div
              className="overflow-hidden rounded-2xl border bg-space-2 lg:col-span-2"
              style={{ borderColor: 'var(--glass-border)' }}
            >
              <div className="relative aspect-video">
                <PromoVideo src="/promo-1.mp4" poster="/promo-1-poster.jpg" />
                <span
                  className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-gold px-3 py-1 font-mono text-xs font-medium text-space-1"
                  aria-hidden="true"
                >
                  <Play size={12} aria-hidden="true" />
                  PROMO
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 p-4">
                <p className="text-[15px] font-bold text-txt-1">公司宣傳影片 · 品牌篇</p>
                <p className="shrink-0 font-mono text-xs text-txt-3">2026年5月</p>
              </div>
            </div>

            {/* 直片：台灣掃貨團 */}
            <div
              className="overflow-hidden rounded-2xl border bg-space-2"
              style={{ borderColor: 'var(--glass-border)' }}
            >
              <div className="relative aspect-[9/16] max-h-[520px] w-full">
                <PromoVideo src="/promo-2.mp4" poster="/promo-2-poster.jpg" />
                <span
                  className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-gold px-3 py-1 font-mono text-xs font-medium text-space-1"
                  aria-hidden="true"
                >
                  <Play size={12} aria-hidden="true" />
                  PROMO
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 p-4">
                <p className="text-[15px] font-bold text-txt-1">公司宣傳影片 · 台灣掃貨團</p>
                <p className="shrink-0 font-mono text-xs text-txt-3">2026年2月</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <HairlineDivider />

      {/* ============ 6. 品牌故事條 + Glo Glo 主播介紹 ============ */}
      <section className="mx-auto mt-10 max-w-[1280px] px-5 md:mt-14 md:px-8 xl:px-12">
        <div ref={storyRef} className="reveal grid items-center gap-10 lg:grid-cols-2">
          {/* 左：Glo Glo 相片（全彩） */}
          <div className="grid grid-cols-2 gap-4">
            <DuotoneImage
              off
              src="/gloglo-1.jpg"
              alt="主播 Glo Glo 直播造型一"
              wrapperClassName="rounded-2xl border"
              className="aspect-[4/5] h-full w-full object-cover"
            />
            <DuotoneImage
              off
              src="/gloglo-2.jpg"
              alt="主播 Glo Glo 直播造型二"
              wrapperClassName="mt-10 rounded-2xl border"
              className="aspect-[4/5] h-full w-full object-cover"
            />
          </div>

          {/* 右：花體大字 + 3 行故事 + 連結 */}
          <div>
            <p className="script text-[28px] leading-[1.3] md:text-[36px]">
              From a little live room in Hong Kong
            </p>
            <h2 className="mt-2 font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
              關於 Glo Glo 同 RedCode
            </h2>
            <div className="mt-5 space-y-4 text-[15px] leading-[1.75] text-txt-2">
              <p>
                RedCode 由一個小小嘅香港直播房開始。Glo Glo 每晚開住 Facebook
                直播，逐件衫著上身俾大家睇，邊講邊笑，好似同閨蜜視像咁。
              </p>
              <p>
                我哋相信買衫唔使靠估 —— 直播睇到真實著身效果、質地同尺寸，
                有問題即場問，WhatsApp 隨時搵到人。
              </p>
              <p>
                由揀款、落單到對數發貨，每一步都希望令你覺得：
                呢單唔係交易，係一粒小小嘅願望成真。
              </p>
            </div>
            <Link
              to="/about"
              className="mt-6 inline-block border-b text-sm font-medium text-pink-soft transition-colors hover:text-pink-tint"
              style={{ borderColor: 'var(--pink)' }}
            >
              認識 Glo Glo →
            </Link>
          </div>
        </div>
      </section>

      <HairlineDivider />

      {/* ============ 7. 客戶打卡牆（IG 風格横 scroll，duotone→hover 上色） ============ */}
      <section className="mt-10 md:mt-14">
        <div ref={wallRef} className="reveal mx-auto max-w-[1280px] px-5 md:px-8 xl:px-12">
          <SectionHeading en="Star Girls" zh="客戶打卡牆" center />
          <p className="mt-3 text-center text-[15px] text-txt-2">
            多謝每一位寶寶嘅著身分享，你哋先係夜空入面最閃嘅星。
          </p>
        </div>
        <div className="mt-8 flex gap-4 overflow-x-auto px-5 pb-4 md:px-8 xl:px-12 [scrollbar-width:thin]">
          {wallPhotos.map((photo) => (
            <div key={photo.key} className="w-56 shrink-0 md:w-64">
              <DuotoneImage
                off
                src={photo.src}
                alt={photo.alt}
                wrapperClassName="rounded-2xl border"
                className="aspect-square w-full object-cover"
              />
              {photo.caption && (
                <p className="mt-2 text-center text-[13px] leading-[1.5] text-txt-3">
                  {photo.caption}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <HairlineDivider />

      {/* ============ 8. WhatsApp CTA 區塊 ============ */}
      <section className="mx-auto mt-10 max-w-[1280px] px-5 md:mt-14 md:px-8 xl:px-12">
        <div
          ref={waRef}
          className="reveal border bg-space-3 px-6 py-12 text-center md:px-12 md:py-16"
          style={{ borderColor: 'rgba(245, 197, 24, 0.28)' }}
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">
            WhatsApp First
          </p>
          <h2 className="mx-auto mt-3 max-w-xl font-serif-tc text-2xl font-semibold leading-[1.3] text-starlight md:text-[32px]">
            有咩唔明，WhatsApp 直接問 Glo Glo 團隊
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[15px] leading-[1.75] text-txt-2">
            尺寸點揀？幾時有貨？訂單去到邊？
            我哋習慣用 WhatsApp 溝通，快過電郵好多。
          </p>
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-8 inline-flex items-center gap-2 border-b pb-1 font-serif-tc text-base font-semibold text-gold-soft transition-opacity hover:opacity-70"
            style={{ borderColor: 'var(--gold)' }}
          >
            <MessageCircle size={16} aria-hidden="true" />
            即刻 WhatsApp 我哋 →
          </a>
        </div>
      </section>

      {/* §3.4 進場 stagger：opacity 0→1 + translateY(16px)→0，--dur-page + --ease-expo */}
      <style>{`
        .hero-enter {
          opacity: 0;
          animation: hero-enter 700ms var(--ease-expo) both;
        }
        @keyframes hero-enter {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .hero-enter { opacity: 1; animation: none; }
        }

        /* ===== Hero CTA 掣組（pill cluster + pointer spotlight）=====
           老闆鐵律：動畫/transition 淨係 transform + opacity；
           光暈層用 transform: translate3d 跟手（GPU-only），唔郁 width/top/left/box-shadow/filter。
           淨係 primary 一粒有 looping 掃光，其餘三粒冇 loop 動畫。 */
        .hero-cta {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 9999px;
          text-decoration: none;
          cursor: pointer;
          transform: translateZ(0);
          transition: transform var(--dur-micro) var(--ease-expo);
        }
        .hero-cta:hover { transform: translateY(-1px) translateZ(0); }
        .hero-cta:active { transform: translateY(0) translateZ(0); }

        /* primary：實心品牌粉紅，深字 var(--space-1) 對比 ≈4.9:1 過 AA；尺寸大一碼做主角 */
        .hero-cta-primary {
          padding: 15px 32px;
          background: var(--pink);
          color: var(--space-1);
          font-size: 15px;
          font-weight: 800;
          letter-spacing: 0.05em;
        }
        /* outline：玻璃底 + hairline 邊，視覺重量次級 */
        .hero-cta-outline {
          padding: 12px 22px;
          border: 1px solid var(--glass-border);
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-1);
          font-size: 14px;
          font-weight: 600;
        }
        /* ghost（通知掣）：最收斂，融入 cluster 但唔搶戲 */
        .hero-cta-ghost {
          padding: 11px 20px;
          border: 1px solid var(--space-line);
          background: transparent;
          color: var(--text-2);
          font-size: 13px;
          font-weight: 500;
        }

        /* pointer spotlight 光暈：固定 160px 圓，JS 寫 --mx/--my，translate3d 跟手；
           平時 opacity 0，hover/按壓（:active 包手機 pointerdown）淡入 */
        .hero-cta-glow {
          position: absolute;
          top: 0;
          left: 0;
          width: 160px;
          height: 160px;
          border-radius: 9999px;
          pointer-events: none;
          opacity: 0;
          transition: opacity 200ms ease-out;
          transform: translate3d(calc(var(--mx, 80px) - 80px), calc(var(--my, 80px) - 80px), 0);
        }
        .hero-cta:hover .hero-cta-glow,
        .hero-cta:active .hero-cta-glow { opacity: 1; }
        .hero-cta-glow-pink {
          background: radial-gradient(circle, rgba(255, 143, 191, 0.5) 0%, rgba(255, 143, 191, 0) 70%);
        }
        .hero-cta-glow-gold {
          background: radial-gradient(circle, rgba(245, 197, 24, 0.42) 0%, rgba(245, 197, 24, 0) 70%);
        }

        /* primary 獨有掃光 loop（跟 btn-replay-shine 手法：淨 transform） */
        .hero-cta-shine {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          width: 40%;
          pointer-events: none;
          background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.7), transparent);
          transform: translateX(-160%) skewX(-18deg);
          animation: hero-cta-shine 2.8s ease-in-out infinite;
        }
        @keyframes hero-cta-shine {
          0% { transform: translateX(-160%) skewX(-18deg); }
          55%, 100% { transform: translateX(330%) skewX(-18deg); }
        }

        /* ===== 第二輪美化（musepool editorial 方向）=====
           1) 雙行標籤：上行 DM Mono micro-label（拉丁字先用，中文唔准用）+ 下行中文主標
           2) slide-up hover swap：cta-flip 固定高度 overflow:hidden，內部兩份一模一樣
              標籤直排；hover 成條 column translateY 碌上一格（純 transform，GPU-only）。
              高度唔寫死——第二份標籤 absolute 擺喺第一份下面，容器高由第一份自然撐開，
              咁 FB 掣主標手機版縮行都唔會 clipping；translateY(-100%) 等同 -50% 效果。
           3) 箭嘴 micro-interaction：outline 掣 hover 時 ArrowRight 向右 4px。 */
        .cta-flip {
          position: relative;
          display: inline-flex;
          overflow: hidden;
          max-width: 100%;
        }
        .cta-flip-inner {
          position: relative;
          display: flex;
          flex-direction: column;
          transition: transform 350ms var(--ease-expo);
          will-change: transform;
        }
        .cta-flip-inner .cta-label + .cta-label {
          position: absolute;
          top: 100%;
          left: 0;
          width: 100%;
        }
        .hero-cta:hover .cta-flip-inner,
        .hero-cta:focus-visible .cta-flip-inner {
          transform: translateY(-100%);
        }
        .cta-label {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          text-align: center;
        }
        .cta-micro {
          font-family: 'DM Mono', 'Noto Sans TC', monospace;
          font-size: 10px;
          font-weight: 400;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          line-height: 1.2;
        }
        .cta-title { line-height: 1.35; }
        /* micro-label 細微金/粉色；primary 實心粉底上用深字保對比 */
        .hero-cta-primary .cta-micro { color: rgba(10, 6, 20, 0.62); }
        .hero-cta-outline .cta-micro { color: var(--gold); opacity: 0.8; }
        .hero-cta-ghost .cta-micro { color: var(--pink-tint); opacity: 0.75; }

        .cta-arrow {
          transition: transform 300ms var(--ease-expo);
        }
        .hero-cta:hover .cta-arrow,
        .hero-cta:focus-visible .cta-arrow {
          transform: translateX(4px);
        }

        /* ===== 訂閱態 status pill（被動，唔係掣）=====
           同 cluster 同款 pill 外形：rounded-full + hairline border + 同 ghost 高度；
           呼吸粉點 loop 淨 transform + opacity。 */
        .cta-status-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          height: 100%;
          padding: 11px 20px;
          border: 1px solid var(--space-line);
          border-radius: 9999px;
          background: rgba(255, 143, 191, 0.06);
          color: var(--text-1);
          font-size: 13px;
          font-weight: 600;
        }
        .cta-status-pill .cta-micro { color: var(--gold); opacity: 0.8; }
        .cta-status-dot {
          width: 8px;
          height: 8px;
          flex-shrink: 0;
          border-radius: 9999px;
          background: var(--pink);
          animation: cta-status-breathe 2.4s ease-in-out infinite alternate;
        }
        @keyframes cta-status-breathe {
          from { transform: scale(1); opacity: 1; }
          to { transform: scale(1.35); opacity: 0.45; }
        }

        /* ===== 星光裝飾層：星塵圖喺掣底下慢慢漂移（淨 translate3d loop）===== */
        .cta-sparkle-layer {
          position: absolute;
          top: -40px;
          bottom: -40px;
          left: -24px;
          right: -24px;
          background-image: url(/cta-sparkles.png);
          background-position: center;
          background-repeat: no-repeat;
          background-size: contain;
          pointer-events: none;
          opacity: 0.5;
          animation: cta-sparkle-drift 26s linear infinite alternate;
        }
        @keyframes cta-sparkle-drift {
          from { transform: translate3d(-12px, -8px, 0); }
          to { transform: translate3d(12px, 8px, 0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .hero-cta { transition: none; }
          .hero-cta:hover, .hero-cta:active { transform: translateZ(0); }
          .hero-cta-glow { display: none; }
          .hero-cta-shine { display: none; animation: none; }
          /* flip swap / 箭嘴 / 呼吸點 / 星光漂移全部停 */
          .cta-flip-inner { transition: none; }
          .hero-cta:hover .cta-flip-inner,
          .hero-cta:focus-visible .cta-flip-inner { transform: none; }
          .cta-arrow { transition: none; }
          .hero-cta:hover .cta-arrow,
          .hero-cta:focus-visible .cta-arrow { transform: none; }
          .cta-status-dot { animation: none; }
          .cta-sparkle-layer { animation: none; }
        }
      `}</style>
    </div>
  );
}
