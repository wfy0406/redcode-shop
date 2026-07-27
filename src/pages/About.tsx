import { Facebook, MessageCircle } from 'lucide-react';
import DuotoneImage from '@/components/DuotoneImage';
import { useReveal } from '@/hooks/useReveal';

/**
 * RedCode 關於我們（design-system.md §P4）
 * 1. Hero：左 Glo Glo 大像（duotone→全彩進場）+ 右花體「Hi, I'm Glo Glo ✦」+ 第一人稱介紹
 * 2. 品牌故事：時間線直排，節點用金色四角星（資料源自 brief.md 真實品牌事實）
 * 3. Glo Glo 專區：gloglo-1/2/3 duotone 相片 + 寵粉文化
 * 4. 點解揀我哋：大字編號 01–04（DM Mono --purple-text，唔用 icon 卡）
 * 5. 聯絡區：三條全寬列（WhatsApp／Facebook／土瓜灣），hover 整行 --space-2 亮起
 * 6. WhatsApp + Facebook CTA 區塊
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼（brief：聯絡方法未能確認，用佔位先）
const WHATSAPP_URL = 'https://wa.me/85254835368';
const WHATSAPP_DISPLAY = '+852 5483 5368';
const FACEBOOK_URL = 'https://www.facebook.com/redcodexhk';

/* ---------- §P4 金色四角星（時間線節點） ---------- */
function GoldStar({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      className={className}
      fill="var(--gold)"
    >
      <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" />
    </svg>
  );
}

/* ---------- 品牌時間線（brief.md 真資料，未能確認嘅年份唔作） ---------- */
const TIMELINE = [
  {
    title: '開台第一晚',
    body: '喺香港土瓜灣一個小小嘅直播房，Glo Glo 第一次喺 Facebook 開 live 賣女裝——逐件著上身、逐件講質地，由嗰晚開始就冇停過。',
  },
  {
    title: '「寶寶」們聚埋一齊',
    body: 'Red Code HK直播台（redcodexhk）累積咗約 4,390 位粉絲，仲有超過 4,000 人經常討論緊我哋——相對粉絲數係極高互動，因為每晚留言區都真係好熱鬧。',
  },
  {
    title: '直播帶貨文化成形',
    body: '留言下單、3件再包郵、即日入數全單減 $15；有啲場次「僅限直播下單，不設加單」。睇直播唔再係睇嘢咁簡單，係一齊搶心水款嘅儀式。',
  },
  {
    title: '台灣聯乘直運場',
    body: '「RedCode X 台灣服裝設計店家聯乘」系列開跑，台灣直運、外地滿 $450 包郵。仲有一年一度「Glo Glo誕」寵粉場——留言「生日快樂」全單再減 $10。',
  },
];

/* ---------- §P4 點解揀我哋（大字編號，唔用 icon 卡） ---------- */
const REASONS = [
  {
    num: '01',
    title: '直播互動，睇真啲先買',
    body: '每晚直播即場著身示範，質地、尺寸、上身效果一目了然。有問題即場留言問，Glo Glo 即場答。',
  },
  {
    num: '02',
    title: '寵粉優惠，場場有驚喜',
    body: '3件再包郵、即日入數全單減 $15、「Glo Glo誕」生日場全單再減 $10——寶寶們嘅福利，從來唔會少。',
  },
  {
    num: '03',
    title: '台灣聯乘，直運到你手',
    body: '同台灣服裝設計店家聯乘開直播，款色香港搵唔到。台灣直運，外地滿 $450 包郵。',
  },
  {
    num: '04',
    title: 'WhatsApp 貼身服務',
    body: '由問款、確認訂單到追蹤寄件，全程 WhatsApp 直接對話，唔使等電郵回覆。',
  },
];

export default function About() {
  const storyRef = useReveal<HTMLDivElement>();
  const glogloRef = useReveal<HTMLDivElement>();
  const reasonsRef = useReveal<HTMLDivElement>();
  const contactRef = useReveal<HTMLDivElement>();
  const ctaRef = useReveal<HTMLDivElement>();

  return (
    <div>
      {/* ============ 1. Hero（§P4：左大像 + 右花體 + 第一人稱介紹） ============ */}
      <section className="relative overflow-hidden">
        {/* radial burst：銀河核心喺頭頂（§3.3） */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[70vh]"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, var(--pink-haze) 0%, transparent 70%)',
          }}
        />
        <div className="relative z-10 mx-auto grid max-w-[1280px] items-center gap-10 px-5 pb-16 pt-12 md:px-8 md:pt-20 lg:grid-cols-2 xl:px-12">
          {/* 左：Glo Glo 大像（全彩顯示） */}
          <div className="relative">
            <DuotoneImage
              off
              src="/boss-glo.jpg"
              alt="Boss 同主播 Glo Glo 合照"
              wrapperClassName="hero-enter rounded-[20px] border"
              className="aspect-[4/5] w-full object-cover"
              onError={(e) => {
                // boss-glo.jpg 未上傳時 fallback 去 Glo Glo 造型相
                const img = e.currentTarget;
                if (!img.src.endsWith('/gloglo-2.jpg')) img.src = '/gloglo-2.jpg';
              }}
            />
            {/* 散佈小浮卡（拍立得樣式，常態旋轉） */}
            <div
              aria-hidden="true"
              className="hero-enter absolute -right-4 bottom-8 hidden w-36 rounded-2xl border bg-space-2 p-2 pb-3 md:block lg:-right-10 lg:w-44"
              style={{
                borderColor: 'var(--glass-border)',
                transform: 'rotate(4deg)',
                animationDelay: '0.6s',
              }}
            >
              <img
                src="/gloglo-1.jpg"
                alt=""
                className="aspect-square w-full rounded-xl object-cover"
              />
              <p className="mt-1.5 text-center font-mono text-xs leading-none text-pink-tint">
                your host ♡
              </p>
            </div>
          </div>

          {/* 右：花體 + 第一人稱介紹（§3.4 進場 stagger 50ms 級距） */}
          <div>
            <p
              className="script hero-enter text-[28px] leading-[1.3] md:text-[40px]"
              style={{ animationDelay: '0.5s' }}
            >
              Hi, I&apos;m Glo Glo ✦
            </p>
            <h1
              className="hero-enter mt-4 font-serif-tc text-3xl font-bold leading-[1.2] tracking-[0.02em] text-starlight md:text-[44px]"
              style={{ animationDelay: '0.55s' }}
            >
              我係 Glo Glo，
              <br />
              RedCode 嘅主播。
            </h1>
            <div
              className="hero-enter mt-6 space-y-4 text-[15px] leading-[1.75] text-txt-2 md:text-base"
              style={{ animationDelay: '0.6s' }}
            >
              <p>
                每晚我都會喺 Facebook 開直播，同寶寶們逐件衫慢慢睇。
                邊個款顯瘦、邊隻色啱黃皮膚、彈性夠唔夠——你想知嘅，我著上身話你知。
              </p>
              <p>
                RedCode 唔係一間舖頭咁簡單，係一個每晚都開住燈等你嘅直播房。
                留言落單、吹水開賣、生日一齊慶祝——呢啲先係我哋嘅日常。
              </p>
            </div>
            <div
              className="hero-enter mt-8 flex flex-col gap-4 sm:flex-row sm:items-center"
              style={{ animationDelay: '0.65s' }}
            >
              <a
                href={FACEBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                <Facebook size={18} aria-hidden="true" />
                追蹤 Red Code HK直播台
              </a>
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-whatsapp"
              >
                <MessageCircle size={18} aria-hidden="true" />
                WhatsApp 搵我
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ============ 2. 品牌故事時間線（§P4：直排 + 金色四角星節點） ============ */}
      <section className="mx-auto max-w-[1280px] px-5 md:px-8 xl:px-12">
        <div ref={storyRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Our Story</span>
            由一個小直播房開始
          </h2>
          <div className="relative mt-10 space-y-12 border-l pl-8 md:pl-12" style={{ borderColor: 'var(--space-line)' }}>
            {TIMELINE.map((item, i) => (
              <div
                key={item.title}
                className="reveal relative"
                style={{ transitionDelay: `${Math.min(i * 80, 400)}ms` }}
              >
                <span className="absolute -left-[41px] top-1 md:-left-[57px]">
                  <GoldStar />
                </span>
                <p className="font-mono text-xs tracking-[0.2em] text-gold">
                  CHAPTER {String(i + 1).padStart(2, '0')}
                </p>
                <h3 className="mt-2 font-serif-tc text-xl font-semibold text-txt-1 md:text-2xl">
                  {item.title}
                </h3>
                <p className="mt-3 max-w-2xl text-[15px] leading-[1.75] text-txt-2">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 3. Glo Glo 專區（duotone 相片 + 寵粉文化） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={glogloRef} className="reveal">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
              <span className="font-display-en mr-3 text-purple-text">Glo Glo</span>
              主播專區
            </h2>
            <p className="max-w-md text-sm leading-[1.6] text-txt-3">
              直播入面嘅每一個造型，都係 Glo Glo 親自襯出嚟。
            </p>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-6">
            {[
              { src: '/gloglo-1.jpg', alt: 'Glo Glo 直播造型一', cls: '' },
              { src: '/gloglo-4.jpg', alt: 'Glo Glo 同店狗合照', cls: 'md:mt-10' },
              { src: '/gloglo-3.jpg', alt: 'Glo Glo 聖誕造型', cls: 'col-span-2 md:col-span-1 md:mt-20' },
            ].map((photo, i) => (
              <div
                key={photo.src}
                className={`reveal ${photo.cls}`}
                style={{ transitionDelay: `${Math.min(i * 80, 400)}ms` }}
              >
                <DuotoneImage
                  off
                  src={photo.src}
                  alt={photo.alt}
                  wrapperClassName="rounded-2xl border"
                  className="aspect-[4/5] w-full object-cover"
                />
              </div>
            ))}
          </div>
          {/* 寵粉文化 */}
          <div
            className="mt-10 rounded-[24px] border bg-space-2 px-6 py-8 md:px-10"
            style={{ borderColor: 'var(--glass-border)' }}
          >
            <p className="font-mono text-xs tracking-[0.2em] text-pink-tint">FAN CLUB CULTURE</p>
            <p className="mt-3 max-w-3xl text-[15px] leading-[1.75] text-txt-2">
              喺 RedCode，粉絲唔叫粉絲，叫<strong className="font-bold text-pink-soft">「寶寶」</strong>。
              每年「Glo Glo誕」，留言一句「生日快樂」全單再減 $10；
              直播留言區嘅熟面孔，Glo Glo 個個都記得。
              呢種互相撐住嘅關係，先係 RedCode 最值錢嘅嘢。
            </p>
          </div>
        </div>
      </section>

      {/* ============ 4. 點解揀我哋（§P4：大字編號 01–04，唔用 icon 卡） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={reasonsRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Why RedCode</span>
            點解揀我哋
          </h2>
          <div className="mt-10 grid gap-x-12 gap-y-10 md:grid-cols-2">
            {REASONS.map((reason, i) => (
              <div
                key={reason.num}
                className="reveal border-t pt-6"
                style={{
                  borderColor: 'var(--space-line)',
                  transitionDelay: `${Math.min(i * 80, 400)}ms`,
                }}
              >
                <p className="font-mono text-4xl font-medium text-purple-text md:text-5xl">
                  {reason.num}
                </p>
                <h3 className="mt-4 text-lg font-bold leading-[1.4] text-txt-1 md:text-xl">
                  {reason.title}
                </h3>
                <p className="mt-2 max-w-md text-[15px] leading-[1.75] text-txt-2">{reason.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 5. 聯絡區（§P4 本頁重點：三條全寬列，hover 整行亮起） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={contactRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Find Us</span>
            搵我哋
          </h2>
          <div className="mt-8 divide-y rounded-[24px] border" style={{ borderColor: 'var(--glass-border)' }}>
            {/* WhatsApp 列 */}
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col gap-4 px-6 py-6 transition-colors duration-200 hover:bg-space-2 md:flex-row md:items-center md:justify-between md:px-10"
              style={{ borderColor: 'var(--space-line)' }}
            >
              <div className="flex items-center gap-4">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
                >
                  <MessageCircle size={20} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-lg font-bold text-txt-1">WhatsApp 貼身對話</p>
                  <p className="text-sm text-txt-3">問款、落單、追蹤寄件，一句搞掂</p>
                </div>
              </div>
              <span className="font-mono text-lg text-success md:text-xl">{WHATSAPP_DISPLAY}</span>
            </a>

            {/* Facebook 列 */}
            <a
              href={FACEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col gap-4 px-6 py-6 transition-colors duration-200 hover:bg-space-2 md:flex-row md:items-center md:justify-between md:px-10"
              style={{ borderColor: 'var(--space-line)' }}
            >
              <div className="flex items-center gap-4">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: 'var(--pink)', color: 'var(--pink-soft)' }}
                >
                  <Facebook size={20} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-lg font-bold text-txt-1">Red Code HK直播台</p>
                  <p className="text-sm text-txt-3">約 4,390 位粉絲 · 直播時間以專頁公佈為準</p>
                </div>
              </div>
              <span className="font-mono text-lg text-pink-soft md:text-xl">@redcodexhk</span>
            </a>

          </div>
        </div>
      </section>

      {/* ============ 6. WhatsApp + FB CTA 區塊 ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div
          ref={ctaRef}
          className="reveal rounded-[24px] border bg-space-3 px-6 py-12 text-center md:px-12"
          style={{ borderColor: 'var(--glass-border)' }}
        >
          <p className="script text-2xl md:text-3xl">see you in the live room ♡</p>
          <h2 className="mx-auto mt-3 max-w-xl font-serif-tc text-2xl font-semibold leading-[1.3] text-starlight md:text-[32px]">
            今晚，直播房見
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[15px] leading-[1.75] text-txt-2">
            追蹤 Facebook 專頁就唔會錯過任何一場；
            有咩想問，WhatsApp 隨時搵到 Glo Glo 團隊。
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href={FACEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-pulse"
            >
              <Facebook size={18} aria-hidden="true" />
              去 Facebook 追蹤
            </a>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-whatsapp"
            >
              <MessageCircle size={18} aria-hidden="true" />
              WhatsApp 聯絡我哋
            </a>
          </div>
        </div>
      </section>

      {/* §3.4 進場 stagger（同 Home 一致）：opacity 0→1 + translateY(16px)→0 */}
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
