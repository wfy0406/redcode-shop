import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Bell, Facebook, MessageCircle, Play } from 'lucide-react';
import ProductCard from '@/components/ProductCard';
import DuotoneImage from '@/components/DuotoneImage';
import { PRODUCTS } from '@/data/products';
import type { Product } from '@/data/products';
import { useReveal } from '@/hooks/useReveal';
import { trpc } from '@/providers/trpc';

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
 * 2. 直播預告 Banner（§4.5）
 * 3. 今晚精選：2 大 4 細不對稱格網
 * 4. 新品上架：4 欄商品卡 + scroll reveal stagger
 * 5. Facebook 直播專區（page plugin + 直播回顧 video cards）
 * 6. 品牌故事條 + Glo Glo 主播介紹
 * 7. 客戶打卡牆（IG 風格横 scroll）
 * 8. WhatsApp CTA 區塊
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';
const FACEBOOK_URL = 'https://www.facebook.com/redcodexhk';
const FB_PAGE_PLUGIN =
  'https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2Fredcodexhk&tabs=timeline&small_header=false&adapt_container_width=true&hide_cover=false&show_facepile=true&locale=zh_HK';

/* ---------- §4.5 直播倒數：每晚 22:00 開播 ---------- */
function useLiveCountdown() {
  const [remain, setRemain] = useState('--:--:--');

  useEffect(() => {
    const nextLive = () => {
      const now = new Date();
      const target = new Date(now);
      target.setHours(22, 0, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target;
    };

    const tick = () => {
      const diff = Math.max(0, nextLive().getTime() - Date.now());
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      setRemain(`${pad(h)}:${pad(m)}:${pad(s)}`);
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return remain;
}

/* ---------- §4.3 Hero 浮卡（拍立得樣式 + scroll 視差） ---------- */
interface FloatCardProps {
  src: string;
  caption: string;
  rotate: number;
  parallax: number;
  className?: string;
  dim?: boolean;
}

function FloatCard({ src, caption, rotate, parallax, className, dim }: FloatCardProps) {
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
      <img src={src} alt="" className="h-full max-h-40 w-full rounded-xl object-cover" />
      <p className="script mt-1.5 text-center text-base leading-none">{caption}</p>
    </div>
  );
}

/* ---------- Section 標題 ---------- */
function SectionHeading({ en, zh, center }: { en: string; zh: string; center?: boolean }) {
  return (
    <h2
      className={`font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px] ${
        center ? 'text-center' : ''
      }`}
    >
      <span className="font-display-en mr-3 text-purple-text">{en}</span>
      {zh}
    </h2>
  );
}

export default function Home() {
  const countdown = useLiveCountdown();
  // 後端連唔到（純前端預覽）時 fallback 用內建示範商品
  const { data: dbProducts, isError: productsError } = trpc.products.list.useQuery(
    {},
    { retry: false },
  );
  const allProducts =
    productsError || !dbProducts ? PRODUCTS : dbProducts.map(mapDbProduct);
  const featured = allProducts.slice(0, 4);
  const picksRef = useReveal<HTMLDivElement>();
  const newRef = useReveal<HTMLDivElement>();
  const liveRef = useReveal<HTMLDivElement>();
  const storyRef = useReveal<HTMLDivElement>();
  const wallRef = useReveal<HTMLDivElement>();
  const waRef = useReveal<HTMLDivElement>();

  return (
    <div>
      {/* ============ 1. Hero（§4.3 全構圖） ============ */}
      <section className="relative flex min-h-[100dvh] items-center overflow-hidden">
        {/* hero-nebula.png 做底 + radial burst（§3.3：銀河核心喺頭頂） */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center opacity-60"
          style={{ backgroundImage: 'url(/hero-nebula.png)' }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[70vh]"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, var(--pink-haze) 0%, transparent 70%)',
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
        <FloatCard
          src="/product-2.png"
          caption="tonight's pick"
          rotate={3}
          parallax={0.5}
          className="bottom-[16%] right-[22%] hidden w-44 lg:block"
        />
        <FloatCard
          src="/gloglo-2.jpg"
          caption="wish granted ✦"
          rotate={-2}
          parallax={0.3}
          dim
          className="bottom-[8%] right-[4%] hidden w-40 xl:block"
        />
        {/* 手機版：主標上方一張細卡 */}
        <FloatCard
          src="/gloglo-1.jpg"
          caption="live ♡"
          rotate={-4}
          parallax={0.8}
          className="right-5 top-20 w-28 md:hidden"
        />

        {/* 文字區：左對齊，佔欄 1–7 */}
        <div className="relative z-10 mx-auto w-full max-w-[1280px] px-5 pb-24 pt-16 md:px-8 xl:px-12">
          <div className="max-w-2xl">
            <p
              className="script hero-enter text-[28px] leading-[1.3] md:text-[40px]"
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
              開直播，即場著身、即場講價。睇啱嘅款，呢度全部搵得返。
            </p>
            <div
              className="hero-enter mt-10 flex flex-col gap-4 sm:flex-row sm:items-center"
              style={{ animationDelay: '0.65s' }}
            >
              <Link to="/live" className="btn btn-primary btn-pulse">
                去最新直播款
              </Link>
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-whatsapp"
              >
                <MessageCircle size={18} aria-hidden="true" />
                WhatsApp 問款
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ============ 2. 直播預告 Banner（§4.5） ============ */}
      <section
        className="sticky top-[60px] z-30 border-y bg-space-3 md:top-[72px]"
        style={{ borderColor: 'var(--pink)' }}
        aria-label="下次直播預告"
      >
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 md:px-8 xl:px-12">
          <div className="flex items-center gap-3" aria-live="off">
            <span className="live-dot" aria-hidden="true" />
            <span className="text-sm font-medium text-txt-2">下次直播</span>
            <span
              className="font-mono text-xl font-medium text-starlight"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {countdown}
            </span>
          </div>
          <p className="font-serif-tc text-lg font-semibold text-txt-1">
            今晚主題：初秋新品 · 顯瘦連身裙專場
          </p>
          <div className="flex items-center gap-4">
            <span className="script hidden text-xl md:inline">set your wish ✦</span>
            <a
              href={`${WHATSAPP_URL}?text=${encodeURIComponent('Glo Glo 開直播記得提我！')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary !px-6 !py-2.5 text-sm"
            >
              <Bell size={16} aria-hidden="true" />
              提醒我
            </a>
          </div>
        </div>
      </section>

      {/* ============ 3. 今晚精選（2 大 4 細不對稱格網） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={picksRef} className="reveal">
          <SectionHeading en="Tonight's Picks" zh="今晚精選" />
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {/* 左：2×2 大卡 Glo Glo 著身圖（全彩，人像唔用 duotone） */}
            <div className="group relative overflow-hidden rounded-[20px] border" style={{ borderColor: 'var(--glass-border)' }}>
              <img
                src="/gloglo-3.jpg"
                alt="Glo Glo 著身示範今晚精選款"
                className="h-full min-h-[420px] w-full object-cover transition-transform duration-1000"
              />
              <div
                className="absolute inset-x-0 bottom-0 p-6"
                style={{
                  background: 'linear-gradient(180deg, transparent 0%, rgba(7,3,15,.85) 100%)',
                }}
              >
                <p className="font-mono text-xs tracking-widest text-pink-tint">WORN BY GLO GLO</p>
                <p className="mt-1 font-serif-tc text-2xl font-semibold text-starlight">
                  Glo Glo 著身示範 · 直播同款
                </p>
                <Link
                  to="/products"
                  className="mt-3 inline-block border-b text-sm font-medium text-pink-soft transition-colors hover:text-pink-tint"
                  style={{ borderColor: 'var(--pink)' }}
                >
                  睇晒全部直播款 →
                </Link>
              </div>
            </div>
            {/* 右：4 張商品卡 */}
            <div className="grid grid-cols-2 gap-4 md:gap-6">
              {featured.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============ 4. 新品上架（4 欄 + scroll reveal stagger） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
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
            {allProducts.map((product, i) => (
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

      {/* ============ 5. Facebook 直播專區 ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={liveRef} className="reveal">
          <SectionHeading en="Live Room" zh="Facebook 直播專區" />
          <p className="mt-3 max-w-xl text-[15px] text-txt-2">
            每晚 Glo Glo 都會喺 Facebook 同大家見面。錯過咗直播？
            下面有回顧片段，或者入專頁重溫晒所有場次。
          </p>

          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* FB Page Plugin 嵌入 */}
            <div
              className="overflow-hidden rounded-2xl border bg-space-2 lg:col-span-2"
              style={{ borderColor: 'var(--glass-border)' }}
            >
              <iframe
                src={FB_PAGE_PLUGIN}
                width="500"
                height="600"
                style={{ border: 'none', overflow: 'hidden', width: '100%', height: '600px' }}
                scrolling="no"
                allowFullScreen
                allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                title="RedCode HK Facebook 專頁"
                loading="lazy"
              />
            </div>

            {/* 直播回顧 video cards */}
            <div className="grid gap-6 sm:grid-cols-2 lg:col-span-3">
              {[
                {
                  src: '/live-clip-1.mp4',
                  poster: '/video0-mid.jpg',
                  title: '直播回顧 · 連身裙專場精華',
                  date: '7月24日',
                },
                {
                  src: '/live-clip-2.mp4',
                  poster: '/video1-mid.jpg',
                  title: '直播回顧 · 秒殺價開心share',
                  date: '7月22日',
                },
              ].map((clip) => (
                <div
                  key={clip.src}
                  className="overflow-hidden rounded-2xl border bg-space-2"
                  style={{ borderColor: 'var(--glass-border)' }}
                >
                  <div className="duotone relative aspect-video">
                    <video
                      src={clip.src}
                      poster={clip.poster}
                      controls
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-cover"
                    />
                    <span
                      className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-pink px-3 py-1 font-mono text-xs font-medium text-space-1"
                      aria-hidden="true"
                    >
                      <Play size={12} aria-hidden="true" />
                      REPLAY
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 p-4">
                    <p className="text-[15px] font-bold text-txt-1">{clip.title}</p>
                    <p className="shrink-0 font-mono text-xs text-txt-3">{clip.date}</p>
                  </div>
                </div>
              ))}

              {/* 去 Facebook 睇直播 CTA */}
              <a
                href={FACEBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary sm:col-span-2"
              >
                <Facebook size={18} aria-hidden="true" />
                去 Facebook 睇直播
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ============ 6. 品牌故事條 + Glo Glo 主播介紹 ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={storyRef} className="reveal grid items-center gap-10 lg:grid-cols-2">
          {/* 左：Glo Glo 相片（全彩） */}
          <div className="grid grid-cols-2 gap-4">
            <DuotoneImage
              off
              src="/gloglo-1.jpg"
              alt="主播 Glo Glo 直播造型一"
              wrapperClassName="rounded-2xl border"
              className="aspect-[4/5] w-full object-cover"
            />
            <DuotoneImage
              off
              src="/gloglo-2.jpg"
              alt="主播 Glo Glo 直播造型二"
              wrapperClassName="mt-10 rounded-2xl border"
              className="aspect-[4/5] w-full object-cover"
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
                由揀款、落單到對數發貨，每一步都希望令你觉得：
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

      {/* ============ 7. 客戶打卡牆（IG 風格横 scroll，duotone→hover 上色） ============ */}
      <section className="mt-16 md:mt-24">
        <div ref={wallRef} className="reveal mx-auto max-w-[1280px] px-5 md:px-8 xl:px-12">
          <SectionHeading en="Star Girls" zh="客戶打卡牆" center />
          <p className="mt-3 text-center text-[15px] text-txt-2">
            多謝每一位寶寶嘅著身分享，你哋先係夜空入面最閃嘅星。
          </p>
        </div>
        <div className="mt-8 flex gap-4 overflow-x-auto px-5 pb-4 md:px-8 xl:px-12 [scrollbar-width:thin]">
          {[
            { src: '/gloglo-3.jpg', alt: '客戶著身打卡相一' },
            { src: '/gloglo-1.jpg', alt: '客戶著身打卡相二' },
            { src: '/video0-mid.jpg', alt: '直播截圖打卡一' },
            { src: '/gloglo-2.jpg', alt: '客戶著身打卡相三' },
            { src: '/video1-mid.jpg', alt: '直播截圖打卡二' },
            { src: '/about-texture.jpg', alt: '品牌花絮相' },
          ].map((photo) => (
            <DuotoneImage
              key={photo.src + photo.alt}
              off
              src={photo.src}
              alt={photo.alt}
              wrapperClassName="w-56 shrink-0 rounded-2xl border md:w-64"
              className="aspect-square w-full object-cover"
            />
          ))}
        </div>
      </section>

      {/* ============ 8. WhatsApp CTA 區塊 ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div
          ref={waRef}
          className="reveal rounded-[24px] border bg-space-3 px-6 py-12 text-center md:px-12"
          style={{ borderColor: 'var(--glass-border)' }}
        >
          <p className="font-mono text-xs tracking-[0.2em] text-success">WHATSAPP FIRST</p>
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
            className="btn btn-whatsapp mt-8"
          >
            <MessageCircle size={18} aria-hidden="true" />
            即刻 WhatsApp 我哋
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
      `}</style>
    </div>
  );
}
