import { Clock, ExternalLink, Facebook, MessageCircle, Moon, Play, Zap } from 'lucide-react';
import { useReveal } from '@/hooks/useReveal';

/**
 * RedCode 直播專區（/live）
 * 1. Hero：live-banner.png 底 + 「直播專區」標題 + LIVE 眨燈 badge（§3.5 steps(2) 眨燈）
 * 2. Facebook 直播嵌入：FB page plugin iframe（玻璃框包住 + fallback 連結）
 * 3. 直播時間表卡（brief.md：晚場 22:00 ／ 快閃場 15:30，單場可逾 3 小時，以 FB 公佈為準）
 * 4. 直播回顧：live-clip-1/2.mp4 video card（controls + poster）
 * 5. 「點樣睇直播落單」四步（大字編號 DM Mono）
 * 6. CTA：去 Facebook 睇直播 + WhatsApp
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼（brief：聯絡方法未能確認，用佔位先）
const WHATSAPP_URL = 'https://wa.me/85254835368';
const FACEBOOK_URL = 'https://www.facebook.com/redcodexhk';
const FB_PAGE_PLUGIN =
  'https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2Fredcodexhk&tabs=timeline&small_header=false&adapt_container_width=true&hide_cover=false&show_facepile=true';

/* ---------- 直播場次（唔寫死時間，以 FB 公佈為準） ---------- */
const SCHEDULE = [
  {
    icon: Moon,
    tag: '#晚上場',
    time: '每晚',
    title: '晚上場',
    body: '每晚開播，新品著身、快閃價、留言下單。單場可以長達 3 小時以上，慢慢揀唔使急。',
  },
  {
    icon: Zap,
    tag: '#快閃場',
    time: '突襲',
    title: '快閃場',
    body: '不定期突襲開場，快閃價款色手快有手慢冇。部分場次僅限直播下單，不設加單。',
  },
];

/* ---------- 落單四步 ---------- */
const STEPS = [
  {
    num: '01',
    title: '追蹤 Facebook 專頁',
    body: '追蹤「Red Code HK直播台」（@redcodexhk），開直播會收到通知，唔會錯過任何一場。',
  },
  {
    num: '02',
    title: '直播留言落單',
    body: '睇啱邊件，直接喺直播留言區留貨號或指定字句落單，例如「留言 REDCODE♥️」。',
  },
  {
    num: '03',
    title: 'WhatsApp 確認',
    body: '落單後 WhatsApp 同 Glo Glo 團隊確認訂單同入數安排——即日入數全單減 $15。',
  },
  {
    num: '04',
    title: '官網會員追蹤訂單',
    body: '登入官網會員中心，隨時睇返訂單狀態：待對數、已確認、已發貨，一目了然。',
  },
];

/* ---------- 直播回顧 ---------- */
const CLIPS = [
  {
    src: '/live-clip-1.mp4',
    poster: '/video0-mid.jpg',
    title: '直播回顧 · 精華片段一',
    note: '即場著身示範',
  },
  {
    src: '/live-clip-2.mp4',
    poster: '/video1-mid.jpg',
    title: '直播回顧 · 精華片段二',
    note: '快閃價開心share',
  },
];

export default function Live() {
  const embedRef = useReveal<HTMLDivElement>();
  const scheduleRef = useReveal<HTMLDivElement>();
  const clipsRef = useReveal<HTMLDivElement>();
  const stepsRef = useReveal<HTMLDivElement>();
  const ctaRef = useReveal<HTMLDivElement>();

  return (
    <div>
      {/* ============ 1. Hero：live-banner.png 底 + LIVE 眨燈 badge ============ */}
      <section className="relative flex min-h-[70dvh] items-center overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: 'url(/live-banner.png)' }}
        />
        {/* 壓暗 + 融入深空底 */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(10,6,20,.55) 0%, rgba(10,6,20,.75) 60%, var(--space-1) 100%)',
          }}
        />
        {/* radial burst（§3.3：銀河核心喺頭頂） */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[70vh]"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, var(--pink-haze) 0%, transparent 70%)',
          }}
        />

        <div className="relative z-10 mx-auto w-full max-w-[1280px] px-5 pb-20 pt-16 md:px-8 xl:px-12">
          <div className="max-w-2xl">
            {/* LIVE 眨燈 badge（§3.5：steps(2) 眨燈，aria-live off 避免騷擾） */}
            <p
              className="hero-enter inline-flex items-center gap-2 rounded-full bg-pink px-4 py-1.5 font-mono text-sm font-medium tracking-[0.15em] text-space-1"
              style={{ animationDelay: '0.5s' }}
              aria-live="off"
            >
              <span
                className="live-dot"
                style={{ background: 'var(--space-1)' }}
                aria-hidden="true"
              />
              LIVE
            </p>
            <h1
              className="hero-enter mt-5 font-serif-tc text-3xl font-bold leading-[1.2] tracking-[0.02em] text-starlight md:text-[44px]"
              style={{ animationDelay: '0.55s' }}
            >
              直播專區
            </h1>
            <p
              className="script hero-enter mt-3 text-[26px] leading-[1.3] md:text-[34px]"
              style={{ animationDelay: '0.6s' }}
            >
              every night, live from Hong Kong ✦
            </p>
            <p
              className="hero-enter mt-5 max-w-lg text-[15px] leading-[1.75] text-txt-2 md:text-base"
              style={{ animationDelay: '0.65s' }}
            >
              Glo Glo 每晚喺 Facebook 開直播，即場著身、即場講價、留言落單。
              錯過咗都唔緊要——呢度有時間表同回顧片段。
            </p>
            <div
              className="hero-enter mt-8 flex flex-col gap-4 sm:flex-row sm:items-center"
              style={{ animationDelay: '0.7s' }}
            >
              <a
                href={FACEBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary btn-pulse"
              >
                <Facebook size={18} aria-hidden="true" />
                去 Facebook 睇直播
              </a>
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

      {/* ============ 2. Facebook 直播嵌入（玻璃框 + fallback 連結） ============ */}
      <section className="mx-auto max-w-[1280px] px-5 md:px-8 xl:px-12">
        <div ref={embedRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Live Room</span>
            Facebook 直播間
          </h2>
          <p className="mt-3 max-w-xl text-[15px] text-txt-2">
            最新直播同帖文都喺晒度。開播嗰陣，直接喺度睇或者撳入 Facebook 一齊留言。
          </p>
          <div
            className="mt-8 overflow-hidden rounded-2xl border"
            style={{
              background: 'var(--glass-bg)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              borderColor: 'var(--glass-border)',
            }}
          >
            <iframe
              src={FB_PAGE_PLUGIN}
              width="500"
              height="600"
              style={{ border: 'none', overflow: 'hidden', width: '100%', height: '600px' }}
              scrolling="no"
              allowFullScreen
              allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
              title="Red Code HK直播台 Facebook 專頁"
              loading="lazy"
            />
          </div>
          {/* fallback：嵌入載入唔到嘅替代出口 */}
          <p className="mt-4 text-sm text-txt-3">
            嵌入內容載入唔到？
            <a
              href={FACEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 inline-flex items-center gap-1 border-b font-medium text-pink-soft transition-colors hover:text-pink-tint"
              style={{ borderColor: 'var(--pink)' }}
            >
              直接去 Facebook 專頁
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </p>
        </div>
      </section>

      {/* ============ 3. 直播時間表卡 ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={scheduleRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Schedule</span>
            直播時間表
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {SCHEDULE.map((slot, i) => {
              const Icon = slot.icon;
              return (
                <div
                  key={slot.tag}
                  className="reveal rounded-2xl border bg-space-2 p-6 transition-colors duration-200 hover:border-pink-soft md:p-8"
                  style={{
                    borderColor: 'var(--glass-border)',
                    transitionDelay: `${Math.min(i * 80, 400)}ms`,
                  }}
                >
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-mono text-xs tracking-[0.2em] text-pink-tint">
                      {slot.tag}
                    </span>
                    <Icon size={20} className="text-gold" aria-hidden="true" />
                  </div>
                  <p
                    className="mt-4 font-mono text-5xl font-medium text-starlight md:text-6xl"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {slot.time}
                  </p>
                  <h3 className="mt-3 text-lg font-bold leading-[1.4] text-txt-1 md:text-xl">
                    {slot.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-[1.75] text-txt-2">{slot.body}</p>
                </div>
              );
            })}
          </div>
          <p className="mt-5 flex items-center gap-2 text-sm text-txt-3">
            <Clock size={14} aria-hidden="true" />
            直播時間以 Facebook 專頁公佈為準；單場直播可逾 3 小時。
          </p>
        </div>
      </section>

      {/* ============ 4. 直播回顧 video cards ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={clipsRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">Replay</span>
            直播回顧
          </h2>
          <p className="mt-3 max-w-xl text-[15px] text-txt-2">
            錯過咗直播？睇返精華片段，感受下直播間嘅氣氛。
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {CLIPS.map((clip, i) => (
              <div
                key={clip.src}
                className="reveal overflow-hidden rounded-2xl border bg-space-2"
                style={{
                  borderColor: 'var(--glass-border)',
                  transitionDelay: `${Math.min(i * 80, 400)}ms`,
                }}
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
                  <p className="shrink-0 text-xs text-txt-3">{clip.note}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 5. 點樣睇直播落單（四步，大字編號 DM Mono） ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div ref={stepsRef} className="reveal">
          <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            <span className="font-display-en mr-3 text-purple-text">How To Order</span>
            點樣睇直播落單
          </h2>
          <div className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <div
                key={step.num}
                className="reveal border-t pt-6"
                style={{
                  borderColor: 'var(--space-line)',
                  transitionDelay: `${Math.min(i * 80, 400)}ms`,
                }}
              >
                <p className="font-mono text-4xl font-medium text-purple-text">{step.num}</p>
                <h3 className="mt-4 text-lg font-bold leading-[1.4] text-txt-1">{step.title}</h3>
                <p className="mt-2 text-sm leading-[1.75] text-txt-2">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 6. CTA：去 Facebook 睇直播 + WhatsApp ============ */}
      <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
        <div
          ref={ctaRef}
          className="reveal rounded-[24px] border bg-space-3 px-6 py-12 text-center md:px-12"
          style={{ borderColor: 'var(--glass-border)' }}
        >
          <p className="font-mono text-xs tracking-[0.2em] text-pink-tint">#不一樣的靚衫</p>
          <h2 className="mx-auto mt-3 max-w-xl font-serif-tc text-2xl font-semibold leading-[1.3] text-starlight md:text-[32px]">
            今晚，直播間見
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[15px] leading-[1.75] text-txt-2">
            追蹤專頁，開播即刻收到通知；想問款或者確認訂單，WhatsApp 隨時搵我哋。
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href={FACEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-pulse"
            >
              <Facebook size={18} aria-hidden="true" />
              去 Facebook 睇直播
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
