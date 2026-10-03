import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';

/**
 * 常見問題 FAQ /faq
 * 兩大區塊：
 *   1) 接收通知教學（id="notify-tutorial" 錨點）——裝置偵測預設 iPhone/Android tab，
 *      兩條教學片 /faq/notify-iphone.mp4、/faq/notify-android.mp4（public/faq/）。
 *   2) Q&A 手風琴——十條常見問題，禮賓清單式 hairline 分隔，同時只開一條。
 * Design brief：深紫底 #0A0614、金 #F5C518、香檳 #F7D774；重點標記兩級 .key / .mark；
 * 動畝只有 transform/opacity；prefers-reduced-motion 全部即時完成。
 * 獨有 CSS 全部內聯喺下面 <style>，class 名加 faq- prefix 避免撞全站樣式。
 * 字體：Noto Serif TC / Noto Sans TC 站內 index.html 已載入，呢度淨係補 Marcellus。
 */

type FaqItem = { q: string; a: React.ReactNode };

const FAQ_ITEMS: FaqItem[] = [
  {
    q: '付款方便嗎？',
    a: (
      <>
        好方便！我哋支援<span className="faq-key">即時支付</span>
        （信用卡等），撳幾下就搞掂，唔使等過數、唔使入數紙。
      </>
    ),
  },
  {
    q: '落單過程係點？',
    a: (
      <>
        整個流程好簡單，得<span className="faq-mark">四步</span>：
        <span className="faq-key">購買</span>（揀貨落單）→ 付款（即時支付）→ 審批（我哋同事核實）
        → 確認訂單（審批通過後訂單正式成立，等出貨）。
      </>
    ),
  },
  {
    q: '出貨時間？',
    a: (
      <>
        訂單確認之後，大約 <span className="faq-key">7–12 個工作天</span>
        出貨。出咗貨會有通知話你知，記得留意。
      </>
    ),
  },
  {
    q: '即時支付安全嗎？',
    a: (
      <>
        放心，我哋用 <span className="faq-key">Airwallex</span> 收款平台（國際認證、持牌機構），
        我哋全程<span className="faq-mark">接觸唔到你嘅信用卡資料</span>，卡資料由平台直接處理。
      </>
    ),
  },
  {
    q: '有瑕疵點算？',
    a: (
      <>
        如果收到貨發現有瑕疵，收貨後 <span className="faq-key">7 天內</span>
        可以提出退換貨，我哋會盡快幫你跟進。
      </>
    ),
  },
  {
    q: '會員制度係點？',
    a: (
      <>
        消費會累積升級<span className="faq-key">會員等級</span>，等級愈高，享有嘅折扣同專屬優惠就愈多。
        詳情可以睇<Link to="/vip" className="faq-link">會員制度介紹</Link>。
      </>
    ),
  },
  {
    q: '順豐站點查詢點用？',
    a: (
      <>
        結帳或者帳戶頁可以用 <span className="faq-key">GPS</span>
        一撳搵最近站點（順豐站／自提點／智能櫃分類清楚），搵到啱嘅可以
        <span className="faq-mark">即時預設做自己收貨站點</span>；亦可以輸入詳細地址慢慢搵。
      </>
    ),
  },
  {
    q: '幾多錢包郵？',
    a: (
      <>
        買滿 <span className="faq-key">$350</span> 就包郵，湊夠數就唔使畀運費。
      </>
    ),
  },
  {
    q: '訂閱通知會收到咩？',
    a: (
      <>
        <span className="faq-mark">只會收到開播通知</span>
        ，唔會收到會員購買嘅通知同動作，唔怕滋擾。
      </>
    ),
  },
  {
    q: '想取消接收通知喺邊到取消？',
    a: (
      <>
        到<Link to="/account" className="faq-link">我嘅帳戶</Link>頁，撳熄
        <span className="faq-key">「開播通知」</span>開關就得，隨時開返都得。
      </>
    ),
  },
];

/** 裝置偵測：iPhone/iPad/iPod（含 iPadOS 13+ 扮 Mac）→ 預設 iPhone tab，否則 Android */
function detectDefaultTab(): 'iphone' | 'android' {
  if (typeof navigator === 'undefined') return 'android';
  const isApple =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isApple ? 'iphone' : 'android';
}

const TABS = [
  {
    key: 'iphone' as const,
    label: 'iPhone 教學',
    src: '/faq/notify-iphone.mp4',
    title: 'iPhone 開啟開播通知',
    desc: '跟住影片步驟，喺 iPhone 開啟瀏覽器通知，開播即刻收到提示。',
  },
  {
    key: 'android' as const,
    label: 'Android 教學',
    src: '/faq/notify-android.mp4',
    title: 'Android 開啟開播通知',
    desc: '跟住影片步驟，喺 Android 開啟瀏覽器通知，開播即刻收到提示。',
  },
];

export default function Faq() {
  const { hash } = useLocation();
  // 裝置偵測喺 useState 初始化做，首 render 已經係啱嘅 tab，唔會閃切
  const [tab, setTab] = useState<'iphone' | 'android'>(detectDefaultTab);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // 由首頁「接收通知教學」連結入嚟（/faq#notify-tutorial）→ 自動碌去教學區
  useEffect(() => {
    if (hash !== '#notify-tutorial') return;
    const t = setTimeout(() => {
      document.getElementById('notify-tutorial')?.scrollIntoView({ block: 'start' });
    }, 0);
    return () => clearTimeout(t);
  }, [hash]);

  return (
    <main className="faq-page">
      {/* 站內已載入 Noto Serif TC / Noto Sans TC，淨補 Marcellus（拉丁小標用） */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Marcellus&display=swap"
      />
      <style>{FAQ_CSS}</style>

      {/* ===== Hero：純深紫底，CONCIERGE 小標 → 大標（上下 hairline 進場）→ 一句副標 ===== */}
      <header className="faq-hero">
        <p className="faq-hero-kicker">CONCIERGE</p>
        <span aria-hidden="true" className="faq-hero-line faq-hero-line-top" />
        <h1 className="faq-hero-title">
          有咩可以<span className="faq-mark">幫到你</span>？
        </h1>
        <span aria-hidden="true" className="faq-hero-line faq-hero-line-bottom" />
        <p className="faq-hero-sub">關於落單、付款、退換，全部喺晒度。</p>
      </header>

      {/* ===== 第一區：接收通知教學（錨點 notify-tutorial） ===== */}
      <section id="notify-tutorial" className="faq-section" aria-label="接收通知教學">
        <p className="faq-kicker">
          <span className="faq-kicker-latin">HOW TO SUBSCRIBE</span>
          <span className="faq-kicker-cn">接收通知教學</span>
        </p>
        <span aria-hidden="true" className="faq-section-line" />

        {/* 手動 tab：文字制兩選項，active 下面 2px 金線 */}
        <div className="faq-tabs" role="tablist" aria-label="揀返你嘅裝置">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className="faq-tab"
              data-active={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 兩條片疊住，opacity 交叉淡入切換（唔准位移） */}
        <div className="faq-videos">
          {TABS.map((t) => (
            <figure
              key={t.key}
              role="tabpanel"
              className="faq-video-panel"
              data-active={tab === t.key}
              aria-hidden={tab !== t.key}
            >
              <video
                className="faq-video"
                src={t.src}
                controls
                playsInline
                preload="metadata"
                tabIndex={tab === t.key ? 0 : -1}
              />
              <figcaption>
                <p className="faq-video-title">{t.title}</p>
                <p className="faq-video-desc">{t.desc}</p>
              </figcaption>
            </figure>
          ))}
        </div>

        {/* 備註（老闆指定內容） */}
        <p className="faq-note">
          備註：訂閱通知之後，只會收到開播通知，唔會收到會員購買嘅通知同動作；如果想取消接收通知，
          到<Link to="/account" className="faq-link">我嘅帳戶</Link>頁，撳熄「開播通知」就得。
        </p>
      </section>

      {/* ===== 第二區：Q&A 手風琴 ===== */}
      <section className="faq-section" aria-label="常見問題">
        <p className="faq-kicker">
          <span className="faq-kicker-latin">Q &amp; A</span>
          <span className="faq-kicker-cn">常見問題</span>
        </p>
        <span aria-hidden="true" className="faq-section-line" />

        <div className="faq-list">
          {FAQ_ITEMS.map((item, i) => {
            const open = openIndex === i;
            return (
              <div key={i} className="faq-item">
                <h2 className="faq-q-heading">
                  <button
                    type="button"
                    id={`faq-q-${i}`}
                    aria-expanded={open}
                    aria-controls={`faq-a-${i}`}
                    className="faq-q"
                    onClick={() => setOpenIndex(open ? null : i)}
                  >
                    <span className="faq-q-text">{item.q}</span>
                    <span className="faq-plus" data-open={open} aria-hidden="true">
                      <span className="faq-plus-bar" />
                      <span className="faq-plus-bar faq-plus-bar-v" />
                    </span>
                  </button>
                </h2>
                <div
                  id={`faq-a-${i}`}
                  role="region"
                  aria-labelledby={`faq-q-${i}`}
                  className="faq-a-wrap"
                  data-open={open}
                >
                  <div className="faq-a-inner">
                    <div className="faq-answer">{item.a}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

const FAQ_CSS = /* css */ `
  .faq-page {
    background: #0A0614;
    color: #F5F1FA;
    font-family: 'Noto Sans TC', -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
    padding: 72px 20px 120px;
  }

  /* ---------- 重點標記兩級 ---------- */
  .faq-key { font-weight: 700; color: #F5C518; }
  .faq-mark {
    background: rgb(245 197 24 / 0.14);
    color: #F7D774;
    font-weight: 600;
    padding: 0 0.18em;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  .faq-link {
    color: #F7D774;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  /* ---------- Hero ---------- */
  .faq-hero { max-width: 800px; margin: 0 auto; text-align: center; }
  .faq-hero-kicker {
    font-family: 'Marcellus', 'Noto Serif TC', serif;
    text-transform: uppercase;
    letter-spacing: 0.35em;
    font-size: 13px;
    color: #F7D774;
    margin: 0 0 28px;
  }
  .faq-hero-title {
    font-family: 'Noto Serif TC', serif;
    font-weight: 600;
    font-size: clamp(34px, 6vw, 56px);
    line-height: 1.25;
    margin: 0;
    padding: 26px 0;
  }
  .faq-hero-line {
    display: block;
    height: 1px;
    background: rgb(247 215 116 / 0.22);
    transform-origin: center;
    animation: faq-hero-line-in 0.8s cubic-bezier(0.19, 1, 0.22, 1) both;
  }
  .faq-hero-line-bottom { animation-duration: 1.1s; }
  @keyframes faq-hero-line-in {
    from { transform: scaleX(0); }
    to { transform: scaleX(1); }
  }
  .faq-hero-sub { margin: 26px 0 0; font-size: 16px; color: #CFC4E4; }

  /* ---------- 區塊結構：小標 → hairline → 內容 ---------- */
  .faq-section { max-width: 800px; margin: 110px auto 0; scroll-margin-top: 96px; }
  .faq-kicker { margin: 0 0 14px; display: flex; flex-direction: column; gap: 8px; }
  .faq-kicker-latin {
    font-family: 'Marcellus', 'Noto Serif TC', serif;
    text-transform: uppercase;
    letter-spacing: 0.3em;
    font-size: 12px;
    color: #F7D774;
  }
  .faq-kicker-cn {
    font-family: 'Noto Serif TC', serif;
    font-weight: 600;
    letter-spacing: 0.35em;
    font-size: 17px;
    color: #F7D774;
  }
  .faq-section-line {
    display: block;
    height: 1px;
    background: rgb(247 215 116 / 0.22);
    margin-bottom: 40px;
  }

  /* ---------- 影片 tab（文字制，active 2px 金線） ---------- */
  .faq-tabs { display: flex; gap: 32px; margin-bottom: 24px; }
  .faq-tab {
    appearance: none;
    background: none;
    border: none;
    padding: 10px 2px;
    min-height: 44px;
    font-family: inherit;
    font-size: 15.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #9488B3;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.3s ease, border-color 0.3s ease;
  }
  .faq-tab[data-active='true'] { color: #F5F1FA; border-bottom-color: #F5C518; }

  /* ---------- 影片 9:16 直式＋hairline 框，切換 opacity 交叉淡入 ---------- */
  .faq-videos { display: grid; }
  .faq-video-panel {
    grid-area: 1 / 1;
    margin: 0 auto;
    max-width: 380px;
    width: 100%;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
    text-align: center;
  }
  .faq-video-panel[data-active='true'] { opacity: 1; pointer-events: auto; }
  .faq-video {
    display: block;
    width: 100%;
    aspect-ratio: 9 / 16;
    object-fit: cover;
    background: #120C24;
    border: 1px solid rgb(247 215 116 / 0.22);
  }
  .faq-video-title {
    font-family: 'Noto Serif TC', serif;
    font-weight: 600;
    font-size: 17px;
    margin: 16px 0 6px;
  }
  .faq-video-desc { font-size: 14px; color: #9488B3; margin: 0; line-height: 1.8; }

  .faq-note { margin: 32px 0 0; font-size: 14px; line-height: 1.9; color: #9488B3; }

  /* ---------- 手風琴：禮賓清單（hairline 分隔，唔准卡片/圓角/陰影） ---------- */
  .faq-item { border-bottom: 1px solid rgb(247 215 116 / 0.22); }
  .faq-q-heading { margin: 0; }
  .faq-q {
    appearance: none;
    background: none;
    border: none;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 24px 0;
    min-height: 44px;
    cursor: pointer;
    text-align: left;
    font-family: 'Noto Serif TC', serif;
    font-weight: 600;
    font-size: 19px;
    line-height: 1.5;
    color: #F5F1FA;
  }
  /* 自畫 1.5px 金「＋」，展開 rotate 45° 變「×」 */
  .faq-plus {
    position: relative;
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.4s cubic-bezier(0.19, 1, 0.22, 1);
  }
  .faq-plus[data-open='true'] { transform: rotate(45deg); }
  .faq-plus-bar { position: absolute; width: 15px; height: 1.5px; background: #F5C518; }
  .faq-plus-bar-v { transform: rotate(90deg); }

  /* 展開動畫：grid-template-rows 0fr → 1fr */
  .faq-a-wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.5s cubic-bezier(0.19, 1, 0.22, 1);
  }
  .faq-a-wrap[data-open='true'] { grid-template-rows: 1fr; }
  .faq-a-inner { overflow: hidden; min-height: 0; }
  .faq-answer {
    background: rgb(247 215 116 / 0.06);
    border-top: 1px solid rgb(247 215 116 / 0.22);
    border-bottom: 1px solid rgb(247 215 116 / 0.22);
    padding: 22px 20px;
    margin-bottom: 24px;
    font-size: 16.5px;
    line-height: 1.9;
    color: #CFC4E4;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.4s ease, transform 0.4s ease;
  }
  .faq-a-wrap[data-open='true'] .faq-answer { opacity: 1; transform: translateY(0); }

  /* ---------- reduced motion：全部即時完成 ---------- */
  @media (prefers-reduced-motion: reduce) {
    .faq-hero-line { animation: none; transform: none; }
    .faq-plus,
    .faq-a-wrap,
    .faq-answer,
    .faq-tab,
    .faq-video-panel {
      transition: none;
    }
  }
`;
