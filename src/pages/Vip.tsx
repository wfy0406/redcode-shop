/// <reference types="vite/client" />
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  BadgeCheck,
  Crown,
  Globe,
  MapPin,
  PackageCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Truck,
  UserPlus,
} from 'lucide-react';
import { useReveal } from '@/hooks/useReveal';
import heroImg from '@/assets/vip/hero.jpg';
import cardSilverImg from '@/assets/vip/card-silver.png';
import cardGoldImg from '@/assets/vip/card-gold.png';

/**
 * RedCode 會員制度介紹頁（/vip）
 * 1. Hero：AI 生成星空金銀卡橫幅 + 主標 + 副題 + CTA
 * 2. 三級會員卡區：會員 / VIP銀會員 / VIP金會員（金卡最有氣勢：旋轉星印 + 掃光）
 * 3. 免運・運費制度（4 格圖標分塊）
 * 4. 點樣升級（3 步 + CTA）
 * 5. 細則小字（友善語氣）
 *
 * 設計語言：深空星空 × 桃紅霓虹（--pink #FF0054）× 金銀金屬級別色；
 * 動效只用到 opacity / transform（hero-enter、reveal、star-spin、vip-shine 掃光）。
 */

// ===== VIP / 免運規則常數 =====
// v2.1.0：之後會接 getPublicVipConfig 動態攞，而家先寫死做展示
const SILVER_THRESHOLD_LABEL = '$3,000'; // 本年度消費滿額自動升銀
const GOLD_THRESHOLD_LABEL = '$5,000'; // 本年度消費滿額自動升金
const SILVER_DISCOUNT_NUM = '92'; // 全年全單折扣：92 折（bps 9200）
const GOLD_DISCOUNT_NUM = '9'; // 全年全單折扣：9 折（bps 9000）
const FREE_SHIP_THRESHOLD_LABEL = '$350'; // 順豐站自取免運門檻
const VIP_DURATION_LABEL = '由生效日起計一年';

/* ===== 金屬色階（由深空金 --gold #F5C518 / --gold-soft #F7D774 推導出嘅明暗梯；
   銀色用同一明暗節奏轉冷調，保持同品牌星光色同溫） ===== */
const GOLD_METAL = {
  frame:
    'linear-gradient(135deg, #FCE1B6 0%, #AF915F 34%, #F5C518 52%, #8A6D3B 74%, #FCE1B6 100%)',
  text: 'linear-gradient(180deg, #FCE1B6 0%, #F5C518 55%, #AF915F 100%)',
  tint: 'rgba(175, 145, 95, 0.16)',
  hairline: 'rgba(252, 225, 182, 0.28)',
  glow: '0 24px 64px rgba(245, 197, 24, 0.22), 0 8px 24px rgba(175, 145, 95, 0.25)',
};
const SILVER_METAL = {
  frame:
    'linear-gradient(135deg, #F2F3F8 0%, #9AA0B4 36%, #E4E6EF 54%, #767C92 76%, #F2F3F8 100%)',
  text: 'linear-gradient(180deg, #F2F3F8 0%, #C7CBD9 55%, #9AA0B4 100%)',
  tint: 'rgba(154, 160, 180, 0.14)',
  hairline: 'rgba(228, 230, 239, 0.24)',
  glow: '0 18px 48px rgba(154, 160, 180, 0.18)',
};

/* ---------- 金屬框卡（漸變邊框 = 1.5px 金屬框 + 深空內底） ---------- */
function MetalFrame({
  metal,
  className,
  innerClassName,
  children,
}: {
  metal: { frame: string; glow: string };
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-[26px] p-[1.5px] ${className ?? ''}`}
      style={{ background: metal.frame, boxShadow: metal.glow }}
    >
      <div
        className={`relative h-full overflow-hidden rounded-[24.5px] bg-space-2 ${innerClassName ?? ''}`}
        style={{
          background:
            'linear-gradient(180deg, var(--space-3) 0%, var(--space-2) 45%, var(--space-1) 100%)',
        }}
      >
        {/* 頂部金屬反光 hairline */}
        <div
          aria-hidden="true"
          className="absolute inset-x-6 top-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
          }}
        />
        {children}
      </div>
    </div>
  );
}

/* ---------- 金屬漸變字 ---------- */
function MetalText({
  metal,
  className,
  children,
}: {
  metal: { text: string };
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={className}
      style={{
        background: metal.text,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }}
    >
      {children}
    </span>
  );
}

/* ---------- 金卡專屬：旋轉星印（圓形文字環繞，復用全站 star-spin keyframes） ---------- */
function GoldSeal() {
  return (
    <div
      aria-hidden="true"
      className="absolute -top-6 right-5 h-20 w-20 md:-top-8 md:right-7 md:h-24 md:w-24"
    >
      <svg
        viewBox="0 0 100 100"
        className="h-full w-full"
        style={{ animation: 'star-spin 22s linear infinite' }}
      >
        <defs>
          <path
            id="vip-gold-seal-ring"
            d="M50,50 m-36,0 a36,36 0 1,1 72,0 a36,36 0 1,1 -72,0"
            fill="none"
          />
        </defs>
        <circle cx="50" cy="50" r="49" fill="rgba(10, 6, 20, 0.88)" stroke="#AF915F" strokeWidth="0.8" />
        <circle cx="50" cy="50" r="27" fill="none" stroke="rgba(252, 225, 182, 0.35)" strokeWidth="0.5" />
        <text
          fill="#FCE1B6"
          style={{ fontFamily: "'DM Mono', monospace", fontSize: '7.2px', letterSpacing: '1.6px' }}
        >
          <textPath href="#vip-gold-seal-ring">
            RED CODE ✦ GOLD MEMBER ✦ WRITTEN IN THE STARS ✦
          </textPath>
        </text>
      </svg>
      <Star
        size={20}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ color: '#F5C518', fill: '#F5C518' }}
      />
    </div>
  );
}

/* ---------- Section 標題（同 Home 一致嘅節奏） ---------- */
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

export default function Vip() {
  const tiersRef = useReveal<HTMLDivElement>();
  const shipRef = useReveal<HTMLDivElement>();
  const stepsRef = useReveal<HTMLDivElement>();
  const fineRef = useReveal<HTMLDivElement>();

  return (
    <div>
      {/* ============ 1. Hero：AI 星空金銀卡橫幅 ============ */}
      <section className="relative flex min-h-[92dvh] items-center overflow-hidden">
        <img
          src={heroImg}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover opacity-70"
        />
        {/* 左側壓暗俾文字 + 頂部桃紅霓虹暈 + 底部漸隱返 space-1 */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(7,3,15,0.88) 0%, rgba(7,3,15,0.55) 45%, rgba(7,3,15,0.15) 100%)',
          }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[60vh]"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, var(--pink-haze) 0%, transparent 70%)',
          }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-40"
          style={{ background: 'linear-gradient(180deg, transparent 0%, var(--space-1) 100%)' }}
        />

        {/* 桌面版：金銀卡浮喺右側（透明底 PNG + 常態旋轉 + 陰影） */}
        <img
          src={cardGoldImg}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute right-[4%] top-[12%] hidden w-[380px] rotate-6 lg:block xl:w-[440px]"
          style={{ filter: 'drop-shadow(0 24px 48px rgba(245, 197, 24, 0.3))' }}
        />
        <img
          src={cardSilverImg}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[10%] right-[16%] hidden w-[320px] -rotate-3 lg:block xl:w-[360px]"
          style={{ filter: 'drop-shadow(0 20px 40px rgba(154, 160, 180, 0.35))' }}
        />

        <div className="relative z-10 mx-auto w-full max-w-[1280px] px-5 pb-24 pt-16 md:px-8 xl:px-12">
          <div className="max-w-2xl">
            <p
              className="script hero-enter text-[28px] leading-[1.3] md:text-[40px]"
              style={{ animationDelay: '0.4s' }}
            >
              Every wish counts, every babe shines ♡
            </p>
            <h1
              className="hero-enter mt-4 font-serif-tc text-4xl font-bold leading-[1.15] tracking-[0.02em] text-starlight md:text-[60px]"
              style={{ animationDelay: '0.5s' }}
            >
              <span className="font-display-en tracking-[0.06em]">REDCODE</span>
              <br />
              會員制度
            </h1>
            <p
              className="hero-enter mt-5 font-serif-tc text-xl font-semibold text-gold-soft md:text-2xl"
              style={{ animationDelay: '0.58s' }}
            >
              每一粒許願星，都值得被寵壞 ✦
            </p>
            <p
              className="hero-enter mt-5 max-w-lg text-[15px] leading-[1.75] text-txt-2 md:text-base"
              style={{ animationDelay: '0.66s' }}
            >
              寶寶每次落單，都係向我哋許一個小小心願。呢個會員制度就係我哋嘅回應 ——
              買得越多，著數越多：全年折扣、全年免運，達標即刻自動升級，
              唔使申請、唔使搶、唔使等。
            </p>
            <div
              className="hero-enter mt-10 flex flex-col gap-4 sm:flex-row sm:items-center"
              style={{ animationDelay: '0.74s' }}
            >
              <Link to="/register" className="btn btn-primary btn-pulse">
                免費註冊做會員
              </Link>
              {/* v2.1.1 修正：本站係 HashRouter，href="#tiers" 會被當成路由跳轉（冇呢條 route → 黑屏），
                  改用 preventDefault＋scrollIntoView 純捲動，唔郁 location.hash */}
              <a
                href="#tiers"
                className="btn btn-secondary"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById('tiers')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                睇三級會員福利
              </a>
            </div>
          </div>

          {/* 手機版：金銀卡排喺文字下面，互相疊住有層次 */}
          <div className="relative mt-14 h-44 sm:h-52 lg:hidden" aria-hidden="true">
            <img
              src={cardSilverImg}
              alt=""
              className="absolute left-0 top-8 w-56 -rotate-6 sm:w-64"
              style={{ filter: 'drop-shadow(0 16px 32px rgba(154, 160, 180, 0.3))' }}
            />
            <img
              src={cardGoldImg}
              alt=""
              className="absolute right-0 top-0 w-64 rotate-3 sm:w-72"
              style={{ filter: 'drop-shadow(0 20px 40px rgba(245, 197, 24, 0.28))' }}
            />
          </div>
        </div>
      </section>

      {/* ============ 2. 三級會員卡區（拾級而上：金卡最高最有氣勢） ============ */}
      <section id="tiers" className="mx-auto mt-16 max-w-[1280px] scroll-mt-24 px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={tiersRef} className="reveal">
          <SectionHeading en="Membership Tiers" zh="三級會員，一級比一級閃" />
          <p className="mt-3 max-w-2xl text-[15px] leading-[1.75] text-txt-2">
            由註冊嗰刻開始，你每一蚊消費都會儲入「本年度消費」。夠數就自動升級，
            折扣即日生效 —— 你嘅忠實，星星都睇到。
          </p>

          <div className="mt-12 grid items-start gap-10 md:gap-6 lg:grid-cols-3 lg:gap-7">
            {/* ----- TIER 01 會員 ----- */}
            <div className="reveal">
              <div
                className="relative h-full overflow-hidden rounded-[24px] border bg-space-2 p-7 md:p-8"
                style={{
                  borderColor: 'var(--glass-border)',
                  background:
                    'linear-gradient(180deg, var(--space-2) 0%, var(--space-1) 100%)',
                }}
              >
                <p className="font-mono text-xs tracking-[0.28em] text-txt-3">TIER 01 · MEMBER</p>
                <div className="mt-5 flex items-center gap-3">
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-full border"
                    style={{ borderColor: 'var(--glass-border)' }}
                  >
                    <Sparkles size={20} className="text-lavender" aria-hidden="true" />
                  </span>
                  <h3 className="font-serif-tc text-2xl font-semibold text-txt-1">會員</h3>
                </div>
                <p className="mt-4 text-sm font-medium text-pink-tint">免費註冊，即成會員</p>
                <ul className="mt-5 space-y-3 text-sm leading-relaxed text-txt-2">
                  <li className="flex gap-2.5">
                    <Star size={15} className="mt-1 shrink-0 text-lavender" aria-hidden="true" />
                    每次已付款訂單自動儲入本年度消費，隨時升級
                  </li>
                  <li className="flex gap-2.5">
                    <Star size={15} className="mt-1 shrink-0 text-lavender" aria-hidden="true" />
                    會員中心睇訂單、追蹤進度、管理收貨資料
                  </li>
                  <li className="flex gap-2.5">
                    <Star size={15} className="mt-1 shrink-0 text-lavender" aria-hidden="true" />
                    直播開賣通知、會員專屬優惠活動
                  </li>
                </ul>
                <p className="mt-6 border-t pt-4 text-[13px] text-txt-3" style={{ borderColor: 'var(--glass-border)' }}>
                  會員期限：永久有效，註冊即成
                </p>
              </div>
            </div>

            {/* ----- TIER 02 VIP銀會員（升一級） ----- */}
            <div className="reveal lg:-translate-y-5" style={{ transitionDelay: '120ms' }}>
              <MetalFrame metal={SILVER_METAL}>
                <div className="p-7 pt-8 md:p-8">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-xs tracking-[0.28em]" style={{ color: '#C7CBD9' }}>
                      TIER 02 · SILVER
                    </p>
                    <BadgeCheck size={18} style={{ color: '#C7CBD9' }} aria-hidden="true" />
                  </div>
                  <img
                    src={cardSilverImg}
                    alt="RED CODE 銀色金屬會員卡"
                    className="mx-auto mt-5 w-full max-w-[320px] transition-transform duration-500 hover:-translate-y-1.5"
                    style={{ filter: 'drop-shadow(0 18px 36px rgba(154, 160, 180, 0.3))' }}
                  />
                  <h3 className="mt-5 font-serif-tc text-2xl font-semibold text-txt-1">
                    VIP<MetalText metal={SILVER_METAL}>銀會員</MetalText>
                  </h3>
                  <p className="mt-2 text-sm text-txt-2">
                    本年度消費滿{' '}
                    <MetalText metal={SILVER_METAL} className="font-mono text-base font-medium">
                      {SILVER_THRESHOLD_LABEL}
                    </MetalText>{' '}
                    自動升級
                  </p>
                  <p className="mt-5 flex items-baseline gap-2">
                    <MetalText metal={SILVER_METAL} className="font-display-en text-5xl font-semibold leading-none md:text-6xl">
                      {SILVER_DISCOUNT_NUM}
                    </MetalText>
                    <span className="font-serif-tc text-xl font-semibold text-txt-1">折 · 全年全單</span>
                  </p>
                  <ul className="mt-5 space-y-3 text-sm leading-relaxed text-txt-2">
                    <li className="flex gap-2.5">
                      <Star size={15} className="mt-1 shrink-0" style={{ color: '#C7CBD9' }} aria-hidden="true" />
                      全年買咩都 {SILVER_DISCOUNT_NUM} 折，仲可以同優惠碼疊加用
                    </li>
                    <li className="flex gap-2.5">
                      <Star size={15} className="mt-1 shrink-0" style={{ color: '#C7CBD9' }} aria-hidden="true" />
                      達標嗰刻自動升級，折扣即日用得
                    </li>
                  </ul>
                  <p
                    className="mt-6 border-t pt-4 text-[13px] text-txt-3"
                    style={{ borderColor: SILVER_METAL.hairline }}
                  >
                    會員期限：{VIP_DURATION_LABEL}
                  </p>
                </div>
              </MetalFrame>
            </div>

            {/* ----- TIER 03 VIP金會員（最高級：旋轉星印 + 掃光 + 升到最高） ----- */}
            <div className="reveal lg:-translate-y-10" style={{ transitionDelay: '240ms' }}>
              <MetalFrame metal={GOLD_METAL} className="relative">
                {/* 掃光（transform-only shimmer） */}
                <div aria-hidden="true" className="vip-shine pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[24.5px]">
                  <div className="vip-shine-strip" />
                </div>
                <GoldSeal />
                <div className="p-7 pt-9 md:p-8 md:pt-10">
                  <div className="flex items-center gap-3">
                    <p className="font-mono text-xs tracking-[0.28em]" style={{ color: '#FCE1B6' }}>
                      TIER 03 · GOLD
                    </p>
                    <span
                      className="rounded-full px-2.5 py-0.5 font-mono text-[10px] tracking-[0.2em]"
                      style={{ background: GOLD_METAL.tint, color: '#FCE1B6', border: `1px solid ${GOLD_METAL.hairline}` }}
                    >
                      最高級
                    </span>
                  </div>
                  <img
                    src={cardGoldImg}
                    alt="RED CODE 金色金屬會員卡"
                    className="mx-auto mt-4 w-full max-w-[340px] transition-transform duration-500 hover:-translate-y-1.5"
                    style={{ filter: 'drop-shadow(0 22px 44px rgba(245, 197, 24, 0.32))' }}
                  />
                  <h3 className="mt-5 flex items-center gap-2 font-serif-tc text-[26px] font-semibold text-txt-1">
                    <Crown size={22} style={{ color: '#F5C518' }} aria-hidden="true" />
                    VIP<MetalText metal={GOLD_METAL}>金會員</MetalText>
                  </h3>
                  <p className="mt-2 text-sm text-txt-2">
                    本年度消費滿{' '}
                    <MetalText metal={GOLD_METAL} className="font-mono text-base font-medium">
                      {GOLD_THRESHOLD_LABEL}
                    </MetalText>{' '}
                    自動升級
                  </p>
                  <p className="mt-5 flex items-baseline gap-2">
                    <MetalText metal={GOLD_METAL} className="font-display-en text-6xl font-semibold leading-none md:text-7xl">
                      {GOLD_DISCOUNT_NUM}
                    </MetalText>
                    <span className="font-serif-tc text-xl font-semibold text-txt-1">折 · 全年全單</span>
                  </p>
                  <p
                    className="mt-3 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold"
                    style={{ background: GOLD_METAL.tint, color: '#FCE1B6', border: `1px solid ${GOLD_METAL.hairline}` }}
                  >
                    <Truck size={15} aria-hidden="true" />
                    全年免運 · 一件都免
                  </p>
                  <ul className="mt-5 space-y-3 text-sm leading-relaxed text-txt-2">
                    <li className="flex gap-2.5">
                      <Star size={15} className="mt-1 shrink-0" style={{ color: '#F5C518', fill: '#F5C518' }} aria-hidden="true" />
                      全年全單 {GOLD_DISCOUNT_NUM} 折，同優惠碼疊加都仲得
                    </li>
                    <li className="flex gap-2.5">
                      <Star size={15} className="mt-1 shrink-0" style={{ color: '#F5C518', fill: '#F5C518' }} aria-hidden="true" />
                      全年順豐站及自提點免運，一件都免，唔使湊單
                    </li>
                    <li className="flex gap-2.5">
                      <Star size={15} className="mt-1 shrink-0" style={{ color: '#F5C518', fill: '#F5C518' }} aria-hidden="true" />
                      免運僅限順豐站及自提點自取；送貨上門維持到付
                    </li>
                  </ul>
                  <p
                    className="mt-6 border-t pt-4 text-[13px]"
                    style={{ borderColor: GOLD_METAL.hairline, color: 'rgba(252, 225, 182, 0.7)' }}
                  >
                    會員期限：{VIP_DURATION_LABEL}
                  </p>
                </div>
              </MetalFrame>
            </div>
          </div>
        </div>
      </section>

      {/* ============ 3. 免運・運費制度（4 格圖標分塊） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={shipRef} className="reveal">
          <SectionHeading en="Shipping" zh="免運・運費一覽" />
          <p className="mt-3 max-w-2xl text-[15px] leading-[1.75] text-txt-2">
            幾時免運、幾時到付，一眼睇晒。規矩簡單，絕唔收「驚喜價」。
          </p>

          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {/* 順豐站自取 滿 $350 免運 */}
            <div
              className="reveal rounded-[20px] border bg-space-2 p-6 md:p-7"
              style={{ borderColor: 'var(--glass-border)' }}
            >
              <div className="flex items-start justify-between gap-4">
                <span
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: 'rgba(255, 77, 141, 0.4)' }}
                >
                  <MapPin size={22} className="text-pink-soft" aria-hidden="true" />
                </span>
                <span className="rounded-full bg-pink px-3 py-1 font-mono text-[11px] font-medium tracking-[0.14em] text-space-1">
                  滿 {FREE_SHIP_THRESHOLD_LABEL} 免運
                </span>
              </div>
              <h3 className="mt-5 font-serif-tc text-xl font-semibold text-txt-1">順豐站自取</h3>
              <p className="mt-2 text-sm leading-relaxed text-txt-2">
                揀順豐站或自提點取貨，訂單滿 {FREE_SHIP_THRESHOLD_LABEL} 即免運費。
                未滿都唔緊要，順豐到付，幾多錢清清楚楚。
              </p>
            </div>

            {/* 送貨上門 運費到付 */}
            <div
              className="reveal rounded-[20px] border bg-space-2 p-6 md:p-7"
              style={{ borderColor: 'var(--glass-border)', transitionDelay: '100ms' }}
            >
              <div className="flex items-start justify-between gap-4">
                <span
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: 'rgba(201, 166, 255, 0.35)' }}
                >
                  <Truck size={22} className="text-lavender" aria-hidden="true" />
                </span>
                <span
                  className="rounded-full border px-3 py-1 font-mono text-[11px] tracking-[0.14em] text-txt-2"
                  style={{ borderColor: 'var(--glass-border)' }}
                >
                  運費到付
                </span>
              </div>
              <h3 className="mt-5 font-serif-tc text-xl font-semibold text-txt-1">送貨上門</h3>
              <p className="mt-2 text-sm leading-relaxed text-txt-2">
                想直送到屋企或者公司？冇問題。送貨上門一律運費到付，
                由順豐按重量距離收取。
              </p>
            </div>

            {/* 澳門及海外 不包郵 */}
            <div
              className="reveal rounded-[20px] border bg-space-2 p-6 md:p-7"
              style={{ borderColor: 'var(--glass-border)', transitionDelay: '200ms' }}
            >
              <div className="flex items-start justify-between gap-4">
                <span
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: 'rgba(201, 166, 255, 0.35)' }}
                >
                  <Globe size={22} className="text-lavender" aria-hidden="true" />
                </span>
                <span
                  className="rounded-full border px-3 py-1 font-mono text-[11px] tracking-[0.14em] text-txt-2"
                  style={{ borderColor: 'var(--glass-border)' }}
                >
                  不包郵 · 順豐到付
                </span>
              </div>
              <h3 className="mt-5 font-serif-tc text-xl font-semibold text-txt-1">澳門及海外</h3>
              <p className="mt-2 text-sm leading-relaxed text-txt-2">
                澳門同海外訂單不包郵，一律順豐到付。澳門寶寶落單記得揀返澳門站點，
                我哋會喺出貨備註寫明「澳門單」。
              </p>
            </div>

            {/* VIP金會員 全年免運（金框亮點格） */}
            <div className="reveal" style={{ transitionDelay: '300ms' }}>
              <MetalFrame metal={GOLD_METAL} className="h-full">
                <div className="p-6 md:p-7">
                  <div className="flex items-start justify-between gap-4">
                    <span
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                      style={{ borderColor: GOLD_METAL.hairline, background: GOLD_METAL.tint }}
                    >
                      <Crown size={22} style={{ color: '#F5C518' }} aria-hidden="true" />
                    </span>
                    <span
                      className="rounded-full px-3 py-1 font-mono text-[11px] font-medium tracking-[0.14em]"
                      style={{ background: GOLD_METAL.tint, color: '#FCE1B6', border: `1px solid ${GOLD_METAL.hairline}` }}
                    >
                      全年免運 · 一件都免
                    </span>
                  </div>
                  <h3 className="mt-5 font-serif-tc text-xl font-semibold text-txt-1">
                    VIP<MetalText metal={GOLD_METAL}>金會員</MetalText>專享
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-txt-2">
                    金會員全年喺順豐站及自提點免運，一件都免、唔使湊單、冇下限。
                    係我哋對最錫嘅寶寶嘅小小心意 ✦
                  </p>
                </div>
              </MetalFrame>
            </div>
          </div>
        </div>
      </section>

      {/* ============ 4. 點樣升級（3 步 + CTA） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={stepsRef} className="reveal">
          <SectionHeading en="How to Level Up" zh="點樣升級？三步搞掂" />

          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              {
                no: '01',
                icon: <UserPlus size={20} aria-hidden="true" />,
                title: '註冊做會員',
                desc: '一分鐘搞掂，完全免費。註冊嗰刻，你已經係 RedCode 寶寶。',
              },
              {
                no: '02',
                icon: <ShoppingBag size={20} aria-hidden="true" />,
                title: '盡情購物',
                desc: '每張已付款訂單都會儲入本年度消費，愈買愈近下一級。',
              },
              {
                no: '03',
                icon: <PackageCheck size={20} aria-hidden="true" />,
                title: '達標自動升級',
                desc: `夠 ${SILVER_THRESHOLD_LABEL} 升銀、夠 ${GOLD_THRESHOLD_LABEL} 升金。即日生效，折扣即刻用得。`,
              },
            ].map((step, i) => (
              <div
                key={step.no}
                className="reveal relative rounded-[20px] border bg-space-2 p-6 md:p-7"
                style={{ borderColor: 'var(--glass-border)', transitionDelay: `${i * 100}ms` }}
              >
                {/* 階段數字頭（金調半透明底） */}
                <div className="flex items-center justify-between">
                  <span
                    className="rounded-lg px-3 py-1.5 font-display-en text-2xl font-semibold leading-none"
                    style={{ background: 'rgba(175, 145, 95, 0.16)', color: '#FCE1B6' }}
                  >
                    {step.no}
                  </span>
                  <span className="text-pink-soft">{step.icon}</span>
                </div>
                <h3 className="mt-5 font-serif-tc text-xl font-semibold text-txt-1">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-txt-2">{step.desc}</p>
              </div>
            ))}
          </div>

          {/* CTA 列 */}
          <div className="reveal mt-12 flex flex-col items-center gap-4 sm:flex-row sm:justify-center" style={{ transitionDelay: '200ms' }}>
            <Link to="/register" className="btn btn-primary btn-pulse">
              立即免費註冊
            </Link>
            <Link to="/products" className="btn btn-secondary">
              先去睇吓有咩款
            </Link>
          </div>
        </div>
      </section>

      {/* ============ 5. 細則小字（友善版） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={fineRef} className="reveal">
          <div
            className="rounded-[20px] border bg-space-2 px-6 py-8 md:px-10"
            style={{ borderColor: 'var(--glass-border)' }}
          >
            <p className="font-mono text-xs tracking-[0.28em] text-txt-3">
              THE FINE PRINT · 細則（好友善嗰隻）
            </p>
            <ul className="mt-5 space-y-2.5 text-[13px] leading-relaxed text-txt-3">
              <li>・ VIP 折扣可以同優惠碼同時使用，著數疊住嚟先係王道。</li>
              <li>・ 年度消費按「已付款」訂單計算，以每年 1 月 1 日至 12 月 31 日為一個年度。</li>
              <li>・ 銀 / 金會員級別{VIP_DURATION_LABEL}；到期後會按你當年嘅消費重新判定，唔會無啦啦冇咗。</li>
              <li>・ 金會員免運只適用於順豐站及自提點；送貨上門、澳門及海外訂單維持運費到付。</li>
              <li>
                ・ 以上規則以官網最新公佈為準，如有爭議 RedCode 保留最終決定權 ——
                但放心，我哋最錫嘅就係寶寶，一定公道 ♡
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* 頁面專屬動效：進場 stagger（同 Home/About 一致）+ 金卡掃光（transform only） */}
      <style>{`
        .hero-enter {
          opacity: 0;
          animation: hero-enter 700ms var(--ease-expo) both;
        }
        @keyframes hero-enter {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .vip-shine-strip {
          position: absolute;
          top: -20%;
          bottom: -20%;
          left: 0;
          width: 36%;
          background: linear-gradient(100deg, transparent, rgba(252, 225, 182, 0.16), transparent);
          transform: translateX(-180%) skewX(-16deg);
          animation: vip-shine 5.5s var(--ease-expo) infinite;
        }
        @keyframes vip-shine {
          0% { transform: translateX(-180%) skewX(-16deg); }
          45% { transform: translateX(420%) skewX(-16deg); }
          100% { transform: translateX(420%) skewX(-16deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .hero-enter { opacity: 1; animation: none; }
          .vip-shine-strip { animation: none; opacity: 0; }
        }
      `}</style>
    </div>
  );
}
