import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import AppInstallGuide from '@/components/AppInstallGuide';
import { AI_TRYON_TUTORIAL_POSTER, AI_TRYON_TUTORIAL_SRC } from '@/components/AiTryOnTutorial';

/**
 * 常見問題 FAQ /faq
 * 四大區塊：
 *   1) 接收通知教學（id="notify-tutorial" 錨點）——裝置偵測預設 iPhone/Android tab，
 *      兩條教學片 /faq/notify-iphone.mp4、/faq/notify-android.mp4（public/faq/）。
 *   2) AI 試穿教學（id="ai-tryon-tutorial"）——70 秒原片，客人撳播放先睇。
 *   3) APP 安裝教學（id="app-install"）——共用全站 PWA 安裝事件，附 iPhone/Android 步驟。
 *   4) Q&A 手風琴——常見問題，禮賓清單式 hairline 分隔，同時只開一條。
 *      除購物／通知問題外，亦包括 PWA 安裝、AI 試穿流程、Mix & Match、
 *      尺碼免責、鏡頭權限、上載故障、WhatsApp 分享私隱。
 * Design brief：深紫底 #0A0614、金 #F5C518、香檳 #F7D774；重點標記兩級 .key / .mark；
 * 動畝只有 transform/opacity；prefers-reduced-motion 全部即時完成。
 * 獨有 CSS 全部內聯喺下面 <style>，class 名加 faq- prefix 避免撞全站樣式。
 * 字體：Noto Serif TC / Noto Sans TC 站內 index.html 已載入，呢度淨係補 Marcellus。
 */

type FaqItem = { q: string; a: React.ReactNode };

const FAQ_ITEMS: FaqItem[] = [
  {
    q: '唔開帳號買唔買到？',
    a: (
      <>
        買到！用<span className="faq-key">訪客快速結帳</span>
        ，填稱呼、電話同 email 就落得單，網上即時付款，記住喺
        <span className="faq-mark">30 分鐘內</span>
        完成付款，逾時訂單會自動取消。之後喺「我的訂單」頁用訂單編號＋電話就查到進度。
        不過開個帳號更著數——有積分同 VIP 折扣。
      </>
    ),
  },
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
        訂單確認之後，大約 <span className="faq-key">7–10 個工作天</span>
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
        揀<span className="faq-key">順豐站／自提點／智能櫃自取</span>，買滿{' '}
        <span className="faq-key">$350</span> 就免運費，湊夠數就唔使畀。
        送貨上門就一律順豐到付，運費收貨時直接畀順豐。
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
  {
    q: '網站可以裝落手機主畫面嗎？',
    a: (
      <>
        可以！我哋係 <span className="faq-key">PWA 網頁應用</span>，直接用瀏覽器安裝就得，
        <span className="faq-mark">唔係 App Store／Google Play 上架嘅 app</span>，唔使去商店搵。
        詳細 iPhone／Android 步驟同真正安裝掣，請睇
        <a href="#app-install" className="faq-link">「安裝 APP 教學」</a>。
        如果你喺其他 app 內置瀏覽器睇緊，請先用系統瀏覽器（Safari／Chrome）開返個網站再裝。
      </>
    ),
  },
  {
    q: 'AI 試穿點玩？',
    a: (
      <>
        想跟住片做，可以先睇<a href="#ai-tryon-tutorial" className="faq-link">70 秒 AI 試穿教學</a>。
        成個流程好簡單：先<span className="faq-key">登入會員</span>，去
        <Link to="/try-on" className="faq-link">AI 試穿</Link>頁，準備一張
        <span className="faq-key">全身相</span>（<span className="faq-mark">前鏡自拍、後鏡拍攝或相簿揀相都得</span>；
        前鏡可以將手機拎遠少少，後鏡可以請家人幫手）
        → 揀想試嘅<span className="faq-key">商品</span> → 提交之後系統會
        <span className="faq-mark">異步生成</span>，唔使一直等，一陣返嚟就有得睇 →
        睇<span className="faq-key">前後對照</span>，鍾意可以<span className="faq-key">下載／分享</span>，
        唔鍾意可以<span className="faq-key">刪除</span>。
        結果會幫你保留 <span className="faq-mark">24 小時</span>，過咗就會自動清除。
      </>
    ),
  },
  {
    q: '試穿相係咪一定要好光、用後鏡？',
    a: (
      <>
        唔使。<span className="faq-mark">前鏡同後鏡都用得</span>，亦可以直接由相簿上載；
        一般室內光線、唔算完美嘅相都可以先試，唔使專業打燈。
        如果張相<span className="faq-key">完全非人像或者真係極暗</span>，系統會先請你換相，
        避免浪費生成額度；呢種情況<span className="faq-mark">未送 AI 生成，亦未預留或扣除 credits</span>。
      </>
    ),
  },
  {
    q: 'Mix & Match 混搭係點計？',
    a: (
      <>
        Mix &amp; Match 每件衫都係<span className="faq-key">獨立生成、獨立扣額</span>：
        每套最多 <span className="faq-key">3 件</span>，每件都要你<span className="faq-key">確認咗先追加</span>下一件；
        <span className="faq-mark">相同穿著部位唔可以重複</span>（例如唔可以一套兩件上身）。
        如果中途生成失敗，<span className="faq-mark">唔會扣你個人每日額度</span>，放心試。
      </>
    ),
  },
  {
    q: 'AI 預覽可以當尺碼參考嗎？',
    a: (
      <>
        唔可以。AI 試穿只係<span className="faq-key">視覺效果預覽</span>，
        <span className="faq-mark">唔代表尺碼、鬆緊、合身程度或者著上身嘅舒適度</span>。
        揀碼請以<span className="faq-key">尺寸表</span>同<span className="faq-key">實物</span>為準，
        有疑問隨時問我哋。
      </>
    ),
  },
  {
    q: '鏡頭權限被拒絕咗點算？',
    a: (
      <>
        有兩條路：一、喺試穿頁撳<span className="faq-key">「重新檢查鏡頭權限」</span>再試；
        二、唔使鏡頭，直接用<span className="faq-key">相簿揀相</span>上載。
        留意網頁<span className="faq-mark">冇辦法直接幫你開系統設定</span>——如果之前拒絕過，
        要你自己去<span className="faq-key">瀏覽器嘅網站設定</span>或者<span className="faq-key">系統設定</span>度，
        將相機權限開返俾我哋個網站。如果你係喺其他 app 嘅內置瀏覽器（WebView）入面用，
        權限係由<span className="faq-mark">嗰個 app 同系統控制</span>，我哋網頁改唔到，
        建議用系統瀏覽器開返。
      </>
    ),
  },
  {
    q: '上載相／生成失敗點算？',
    a: (
      <>
        常見原因有幾個：<span className="faq-key">HEIC 格式</span>（iPhone 預設）未必支援，
        可以先轉做 <span className="faq-key">JPG／PNG</span>；<span className="faq-key">格式</span>唔啱或者
        <span className="faq-key">檔案太大</span>都會食唔到，縮細啲再試；<span className="faq-key">權限</span>未開就開返相簿／鏡頭；
        <span className="faq-key">網絡</span>唔穩就換個好啲嘅訊號再提交。
        搞唔掂就 cap 圖搵我哋跟進。
      </>
    ),
  },
  {
    q: '用 WhatsApp 分享試穿結果安全嗎？',
    a: (
      <>
        安全。WhatsApp 分享 fallback 只會帶<span className="faq-key">公開商品資料同網址</span>，
        <span className="faq-mark">你嘅私人試穿結果唔會自動附加</span>。
        如果想俾朋友睇效果，可以先<span className="faq-key">下載 PNG</span>，
        再喺 WhatsApp 自己揀相附加，話事權完全喺你手。
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

  // 首頁／問答內嘅教學錨點，入到嚟自動碌去指定區塊。
  useEffect(() => {
    const targetId = hash.slice(1);
    if (!['notify-tutorial', 'ai-tryon-tutorial', 'app-install'].includes(targetId)) return;
    const t = setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: 'start' });
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

      {/* ===== 第二區：AI 試穿原片教學；FAQ 內按需播放，唔會自動播 ===== */}
      <section id="ai-tryon-tutorial" className="faq-section" aria-labelledby="ai-tryon-tutorial-title">
        <p className="faq-kicker">
          <span className="faq-kicker-latin">AI TRY-ON · 7 STEPS</span>
          <span className="faq-kicker-cn" id="ai-tryon-tutorial-title">AI 試穿教學</span>
        </p>
        <span aria-hidden="true" className="faq-section-line" />
        <div className="faq-videos">
          <figure className="faq-video-panel" data-active="true">
            <video
              className="faq-video"
              src={AI_TRYON_TUTORIAL_SRC}
              poster={AI_TRYON_TUTORIAL_POSTER}
              controls
              playsInline
              preload="metadata"
              aria-label="70 秒 AI 試穿七步教學影片"
            />
            <figcaption>
              <p className="faq-video-title">70 秒跟住做 · 有聲教學</p>
              <p className="faq-video-desc">由揀衫、影全身相、生成對照到購買，七步完整示範；撳播放先會開始。</p>
              <Link to="/try-on" className="faq-primary-link">去 AI 試穿</Link>
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ===== 第三區：PWA 安裝教學＋真正安裝掣 ===== */}
      <section id="app-install" className="faq-section" aria-labelledby="app-install-title">
        <p className="faq-kicker">
          <span className="faq-kicker-latin">APP INSTALL</span>
          <span className="faq-kicker-cn" id="app-install-title">安裝 APP 教學</span>
        </p>
        <span aria-hidden="true" className="faq-section-line" />
        <AppInstallGuide />
      </section>

      {/* ===== 第四區：Q&A 手風琴 ===== */}
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
  .faq-primary-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    margin-top: 20px;
    padding: 0 22px;
    border: 1px solid #F5C518;
    background: #F5C518;
    color: #0A0614;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
  }

  /* ---------- APP 安裝：原廠圖示＋單一主掣＋分機三步，唔造假下載 ---------- */
  .faq-install-guide { max-width: 640px; }
  .faq-install-intro { display: flex; align-items: center; gap: 18px; padding-bottom: 24px; border-bottom: 1px solid rgb(247 215 116 / 0.22); }
  .faq-install-intro > img { width: 58px; height: 58px; flex: 0 0 auto; border-radius: 14px; }
  .faq-install-intro h3 { margin: 0 0 7px; font-family: 'Noto Serif TC', serif; font-size: 22px; font-weight: 600; }
  .faq-install-intro p { margin: 0; color: #CFC4E4; font-size: 14px; line-height: 1.8; }
  .faq-install-button {
    appearance: none;
    width: 100%;
    min-height: 50px;
    margin-top: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    border: 1px solid #F5C518;
    border-radius: 0;
    background: #F5C518;
    color: #0A0614;
    font-family: inherit;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }
  .faq-install-button:disabled { cursor: default; opacity: .68; }
  .faq-install-button:focus-visible, .faq-primary-link:focus-visible { outline: 2px solid #F7D774; outline-offset: 4px; }
  .faq-install-hint { margin: 10px 0 0; color: #9488B3; font-size: 12px; line-height: 1.7; text-align: center; }
  .faq-install-status { margin: 18px 0 0; padding: 12px 14px; border-left: 2px solid #F5C518; background: rgb(245 197 24 / 0.08); color: #F7D774; font-size: 14px; line-height: 1.75; }
  .faq-install-tabs { margin-top: 26px; margin-bottom: 4px; }
  .faq-install-steps { list-style: none; margin: 0; padding: 0; }
  .faq-install-steps li { display: flex; align-items: flex-start; gap: 15px; padding: 18px 0; border-bottom: 1px solid rgb(247 215 116 / 0.16); color: #CFC4E4; font-size: 15px; line-height: 1.8; }
  .faq-install-steps li > b { flex: 0 0 auto; padding-top: 2px; color: #F5C518; font-family: 'Marcellus', 'Noto Serif TC', serif; font-size: 13px; font-weight: 400; }
  .faq-install-steps strong { color: #F5F1FA; font-weight: 600; }
  .faq-install-steps svg { display: inline-block; vertical-align: -4px; color: #F7D774; }

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
