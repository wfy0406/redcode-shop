'use client';

/**
 * WebDesignPage —— RedCode 網頁設計服務單頁（五段向下滾動）
 *
 * ① 服務：front_only（純展示）vs full_stack（自己改內容）＋專屬查單原位展開
 * ② 價錢：市場價／RedCode 價／慳幾多／幾多折；單一 SEO 套票；雲端＋domain＋月費解釋
 * ③ AI 協作：更靚／功能更多／AI agent 分工慳人手（唔寫模型、供應商、虛假案例）
 * ④ 示範網頁：RedCode／bDog Tokyo 真網站
 * ⑤ WhatsApp／留言／購物車＋結帳（原位 aside，唔係全屏 modal）
 *
 * 設計：Musepool 24-col editorial＋Motion Sites 直片 stage；scoped CSS（wd- 前綴）。
 * SEO：單一 H1、語義 sections、真實 Service JSON-LD（無虛假評分／案例）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_WEB_DESIGN_CATALOG,
  planAllows,
  type WebDesignCatalog,
  type WebDesignCatalogItem,
  type WebDesignPlan,
} from '@contracts/webDesign';
import SuitScroll from '@/components/web-design/SuitScroll';
import AiScene from '@/components/web-design/AiScene';
import CrystalBackground from '@/components/web-design/CrystalBackground';
import ShinyText from '@/components/web-design/ShinyText';
import Magnet from '@/components/web-design/Magnet';
import Reveal from '@/components/web-design/Reveal';
import LookupPanel from '@/components/web-design/LookupPanel';
import CartPanel from '@/components/web-design/CartPanel';
import { wdApi } from '@/components/web-design/api';
import {
  fmtHKD,
  savings,
  discountLabel,
  billingLabel,
  isNonEmpty,
  looksLikeEmail,
  looksLikePhone,
} from '@/components/web-design/helpers';
import '@/components/web-design/webDesign.css';

const WHATSAPP_URL = `https://wa.me/85254835368?text=${encodeURIComponent('你好，我想查詢網頁設計需求')}`;

const CATEGORY_TITLE: Record<WebDesignCatalogItem['category'], string> = {
  seo: 'SEO 技術優化套票',
  feature: '進階功能',
  service: '託管及服務',
};

const PAYMENT_RETURN_KEY = 'redcode_web_design_return';

interface PaymentReturnState {
  orderNo: string;
  name: string;
  phone: string;
}

function readPaymentReturn(): PaymentReturnState | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('ap') !== 'done') return null;
  const orderNo = (params.get('orderNo') || '').trim();
  if (!/^WD/i.test(orderNo)) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(PAYMENT_RETURN_KEY) || 'null') as Partial<PaymentReturnState> | null;
    if (saved?.orderNo === orderNo && typeof saved.name === 'string' && typeof saved.phone === 'string') {
      return { orderNo, name: saved.name, phone: saved.phone };
    }
  } catch {
    // 冇一次性身份時仍返到查單位，客人可手動輸入。
  }
  return { orderNo, name: '', phone: '' };
}

/* ---------- 留言表格 ---------- */
function InquiryForm() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; emailSent: boolean } | null>(null);
  const submitInquiry = wdApi.submitInquiry.useMutation();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isNonEmpty(name) || !looksLikePhone(phone) || !looksLikeEmail(email) || !isNonEmpty(message)) {
      setError('請填寫姓名、電話、有效 Email 同想問嘅內容。');
      return;
    }
    try {
      const result = await submitInquiry.mutateAsync({
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        message: message.trim(),
      });
      setDone({
        emailSent: result.emailSent,
        message: result.emailSent
          ? '已收到留言 ✓ 我哋會盡快用電話或 WhatsApp 覆你。'
          : result.note || '留言已保存，但通知電郵暫時寄唔到；我哋會由後台跟進。',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '送出失敗，請稍後再試。');
    }
  };

  if (done) {
    return (
      <p className={done.emailSent ? 'wd-ok' : 'wd-partial'} role="status">
        {done.message}
      </p>
    );
  }

  return (
    <form className="wd-msg-form" onSubmit={onSubmit} noValidate>
      <div className="wd-field">
        <label className="wd-label" htmlFor="wd-msg-name">
          姓名 <span className="wd-req" aria-hidden="true">*</span>
        </label>
        <input
          id="wd-msg-name"
          className="wd-input"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="wd-field">
        <label className="wd-label" htmlFor="wd-msg-phone">
          電話 <span className="wd-req" aria-hidden="true">*</span>
        </label>
        <input
          id="wd-msg-phone"
          className="wd-input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
      </div>
      <div className="wd-field">
        <label className="wd-label" htmlFor="wd-msg-email">
          Email <span className="wd-req" aria-hidden="true">*</span>
        </label>
        <input
          id="wd-msg-email"
          className="wd-input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="wd-field">
        <label className="wd-label" htmlFor="wd-msg-message">
          想問嘅內容 <span className="wd-req" aria-hidden="true">*</span>
        </label>
        <textarea
          id="wd-msg-message"
          className="wd-textarea"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
        />
      </div>
      {error && (
        <p className="wd-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="wd-btn" disabled={submitInquiry.isPending}>
          {submitInquiry.isPending ? '送出緊…' : '送出留言'}
        </button>
      </div>
    </form>
  );
}

/* ---------- 主頁 ---------- */
function scrollToSection(id: string) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

const GUIDE_STEPS = [
  { id: 'wd-services', label: '01 方案', next: '02 價錢' },
  { id: 'pricing', label: '02 價錢', next: '03 AI 協作' },
  { id: 'wd-ai', label: '03 AI 協作', next: '04 示範' },
  { id: 'wd-demos', label: '04 示範', next: '05 購物車' },
  { id: 'contact', label: '05 購物車', next: '05 購物車' },
] as const;

/* 由 01 開始逐段帶客人向 05 前進；見到聯絡／購物車區即收起。 */
function CartJourneyGuide() {
  const [state, setState] = useState({ visible: false, current: 0 });

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const vh = window.innerHeight || 1;
      const first = document.getElementById(GUIDE_STEPS[0].id);
      const contact = document.getElementById('contact');
      if (!first || !contact) {
        setState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }
      const firstRect = first.getBoundingClientRect();
      const contactRect = contact.getBoundingClientRect();
      const cartRect = document.querySelector('#contact .wd-cart')?.getBoundingClientRect();
      const cartVisible = Boolean(cartRect && cartRect.top < vh * 0.9 && cartRect.bottom > 0);
      const visible = firstRect.top <= vh * 0.82 && contactRect.top > vh * 0.62 && !cartVisible;
      let current = 0;
      for (let index = 0; index < GUIDE_STEPS.length - 1; index += 1) {
        const section = document.getElementById(GUIDE_STEPS[index].id);
        if (section && section.getBoundingClientRect().top <= vh * 0.55) current = index;
      }
      setState((prev) => (prev.visible === visible && prev.current === current ? prev : { visible, current }));
    };
    const requestUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
    return () => {
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  if (!state.visible) return null;
  const targetIndex = Math.min(state.current + 1, GUIDE_STEPS.length - 1);
  const target = GUIDE_STEPS[targetIndex];
  const goNext = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const destination = target.id === 'contact'
      ? document.querySelector('#contact .wd-cart') || document.getElementById('contact')
      : document.getElementById(target.id);
    destination?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <aside className="wd-journey-guide" aria-label="前往購物車導引">
      <button
        type="button"
        className="wd-journey-button"
        onClick={goNext}
        data-guide-target={target.id}
        aria-label={`向下前往${target.label}；購物車喺第 05 段`}
        title={`向下去 ${target.label}`}
      >
        <span className="wd-journey-copy">
          <span className="wd-journey-progress">{GUIDE_STEPS[state.current].label} → {target.label}</span>
          <strong>向下去 {target.label}</strong>
        </span>
        <span className="wd-journey-mobile-label" aria-hidden="true">0{targetIndex + 1}</span>
        <span className="wd-phantom-arrows" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>
    </aside>
  );
}

export default function WebDesignPage() {
  const catalogQuery = wdApi.getCatalog.useQuery(undefined, { staleTime: 60_000 });
  // catalog 未返之前用預設值頂住（server 計價永遠以 DB 為準）
  const catalog: WebDesignCatalog = catalogQuery.data ?? DEFAULT_WEB_DESIGN_CATALOG;

  const [plan, setPlan] = useState<WebDesignPlan | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [paymentReturn] = useState<PaymentReturnState | null>(() => readPaymentReturn());

  useEffect(() => {
    if (!paymentReturn) return;
    try {
      sessionStorage.removeItem(PAYMENT_RETURN_KEY);
    } catch {
      // 一次性身份只係方便回跳；清除失敗唔影響查單。
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('orderNo');
    url.searchParams.delete('ap');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [paymentReturn]);

  // 外部直接開 /web-design#pricing 呢類深連結時，React mount 後先補做原生 anchor 滾動。
  // 後台 catalog、圖片同字體會令段落高度稍後改變；短時間內只在目標偏位時校正。
  // 客人一撳、一碌或用鍵盤操作就立即停止，唔會同客人爭滾動控制。
  useEffect(() => {
    const rawHash = window.location.hash.slice(1);
    if (!rawHash) return;
    let id = rawHash;
    try {
      id = decodeURIComponent(rawHash);
    } catch {
      // 非完整 percent-encoding 都唔可以令成頁 crash；直接用原字串搵 ID。
    }

    let stopped = false;
    let firstFrame = 0;
    let secondFrame = 0;
    let interval = 0;
    let stopTimer = 0;
    let observer: ResizeObserver | null = null;
    const startedAt = performance.now();

    const align = () => {
      if (stopped) return;
      const target = document.getElementById(id);
      if (!target) return;
      const marginTop = Number.parseFloat(window.getComputedStyle(target).scrollMarginTop) || 0;
      if (Math.abs(target.getBoundingClientRect().top - marginTop) > 2) {
        const root = document.documentElement;
        const previousScrollBehavior = root.style.scrollBehavior;
        // CSS 全域 smooth 會令 auto 仍然逐格動；深連結校正要即時完成，否則會追唔上內容變化。
        root.style.scrollBehavior = 'auto';
        try {
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
        } finally {
          root.style.scrollBehavior = previousScrollBehavior;
        }
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (firstFrame) window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (interval) window.clearInterval(interval);
      if (stopTimer) window.clearTimeout(stopTimer);
      observer?.disconnect();
      window.removeEventListener('load', align);
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('pointerdown', stop);
      window.removeEventListener('keydown', stop);
    };

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(align);
    });
    interval = window.setInterval(align, 150);
    stopTimer = window.setTimeout(stop, 4500);
    window.addEventListener('load', align, { once: true });
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('pointerdown', stop, { passive: true });
    window.addEventListener('keydown', stop);
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (performance.now() - startedAt < 4500) align();
      });
      const root = document.getElementById('root');
      if (root) observer.observe(root);
    }
    void document.fonts?.ready.then(align).catch(() => undefined);
    return stop;
  }, []);

  const pickPlan = (p: WebDesignPlan) => {
    setPlan(p);
    // 轉 plan 時踢走唔適用嘅項目（例如轉 front_only 踢走 full_stack-only）
    setSelected((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        const item = catalog.items.find((it) => it.key === key);
        if (item && planAllows(p, item.requiredPlan)) next.add(key);
      }
      return next;
    });
  };

  const toggleItem = (item: WebDesignCatalogItem) => {
    // full_stack-only 功能喺 front_only 底下擋（UI disabled 之外嘅第二重；server 會再擋）
    if (!planAllows(plan ?? 'front_only', item.requiredPlan)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
  };

  const removeItem = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  const sortedItems = useMemo(
    () =>
      catalog.items
        .filter((it) => it.active)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [catalog],
  );
  const byCategory = useMemo(() => {
    const map = new Map<WebDesignCatalogItem['category'], WebDesignCatalogItem[]>();
    for (const it of sortedItems) {
      const list = map.get(it.category) ?? [];
      list.push(it);
      map.set(it.category, list);
    }
    return map;
  }, [sortedItems]);

  const effectivePlan = plan ?? 'front_only';

  return (
    <main className="wd-page" id="wd-top">
      <CrystalBackground />
      {/* ===== ① Hero（直片 stage）＋ 服務 ===== */}
      <section className="wd-hero" data-crystal="hero" aria-label="RedCode 網頁設計服務簡介">
        <SuitScroll spacerVh={250} />
        <div className="wd-hero-overlay">
          <div className="wd-hero-content wd-container">
            <div className="wd-hero-inner">
              <p className="wd-kicker">RedCode® · Digital Atelier</p>
              <h1 className="wd-h1 wd-hero-title">
                你嘅生意，
                <br />
                <span className="wd-accent">值得被看見。</span>
              </h1>
              <p className="wd-hero-sub">
                由品牌門面到真正好用嘅管理系統，設計、開發、SEO 同雲端託管一次過理順。
                你專心做生意，網站交俾我哋整到似樣、用得順。
              </p>
              <div className="wd-hero-actions">
                <a
                  className="wd-cta"
                  href="/web-design#wd-services"
                  onClick={(event) => {
                    event.preventDefault();
                    scrollToSection('wd-services');
                  }}
                >
                  揀選方案 <span aria-hidden="true">↘</span>
                </a>
                <a
                  className="wd-hero-text-link"
                  href="/web-design#wd-demos"
                  onClick={(event) => {
                    event.preventDefault();
                    scrollToSection('wd-demos');
                  }}
                >
                  睇示範網頁 <span aria-hidden="true">↗</span>
                </a>
              </div>
              <div className="wd-hero-meta">
                <span>一頁式 {fmtHKD(catalog.frontOnlyPrice)} 起</span>
                <span>逐項明細</span>
                <span>香港團隊跟進</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="wd-section wd-solid" id="wd-services" data-crystal="services" aria-labelledby="wd-services-h">
        <div className="wd-container">
          <header className="wd-section-head">
            <span className="wd-section-no" aria-hidden="true">01</span>
            <div className="wd-section-title">
              <p className="wd-kicker">服務</p>
              <h2 className="wd-h2" id="wd-services-h">揀啱你嘅方案</h2>
            </div>
            <p className="wd-section-note">兩個方案都包設計＋開發，可自行建置或加託管</p>
          </header>

          <Reveal>
            <div className="wd-plans" role="group" aria-label="方案選擇">
              <button
                type="button"
                className="wd-plan wd-plan--front"
                aria-pressed={plan === 'front_only'}
                onClick={() => pickPlan('front_only')}
              >
                <h3 className="wd-plan-name">{catalog.frontOnlyCopy.name}</h3>
                <div className="wd-plan-price">
                  <strong>{fmtHKD(catalog.frontOnlyPrice)}</strong>
                  <s>市場參考 {fmtHKD(catalog.frontOnlyMarketPrice)}</s>
                  <span className="wd-plan-tag">
                    慳 {fmtHKD(savings(catalog.frontOnlyPrice, catalog.frontOnlyMarketPrice))}
                  </span>
                </div>
                <p className="wd-plan-desc">{catalog.frontOnlyCopy.description}</p>
                <ul className="wd-plan-points">
                  {catalog.frontOnlyCopy.points.map((point) => <li key={point}>{point}</li>)}
                </ul>
                <span className="wd-plan-cta">
                  {plan === 'front_only' ? '✓ 已加入購物車' : '揀呢個 →'}
                </span>
              </button>

              <button
                type="button"
                className="wd-plan wd-plan--full"
                aria-pressed={plan === 'full_stack'}
                onClick={() => pickPlan('full_stack')}
              >
                <h3 className="wd-plan-name">{catalog.fullStackCopy.name}</h3>
                <div className="wd-plan-price">
                  <strong>{fmtHKD(catalog.fullStackPrice)}</strong>
                  <s>市場參考 {fmtHKD(catalog.fullStackMarketPrice)}</s>
                  <span className="wd-plan-tag">
                    慳 {fmtHKD(savings(catalog.fullStackPrice, catalog.fullStackMarketPrice))}
                  </span>
                </div>
                <p className="wd-plan-desc">{catalog.fullStackCopy.description}</p>
                <ul className="wd-plan-points">
                  {catalog.fullStackCopy.points.map((point) => <li key={point}>{point}</li>)}
                </ul>
                <span className="wd-plan-cta">
                  {plan === 'full_stack' ? '✓ 已加入購物車' : '揀呢個 →'}
                </span>
              </button>
            </div>
          </Reveal>

          <Reveal>
            {paymentReturn && (
              <p className="wd-partial" role="status">
                訂單 {paymentReturn.orderNo} 已返回本網站；請以專屬查單顯示嘅伺服器付款狀態為準。
              </p>
            )}
            <details className="wd-lookup" open={Boolean(paymentReturn)}>
              <summary>已經落咗單？專屬查單</summary>
              <LookupPanel
                initialName={paymentReturn?.name}
                initialPhone={paymentReturn?.phone}
                autoLookup={Boolean(paymentReturn?.name && paymentReturn?.phone)}
              />
            </details>
          </Reveal>
        </div>
      </section>

      {/* ===== ② 價錢 ===== */}
      <section className="wd-section wd-solid" id="pricing" data-crystal="pricing" aria-labelledby="wd-pricing-h">
        <div className="wd-container">
          <header className="wd-section-head">
            <span className="wd-section-no" aria-hidden="true">02</span>
            <div className="wd-section-title">
              <p className="wd-kicker">價錢</p>
              <h2 className="wd-h2" id="wd-pricing-h">
                <ShinyText
                  text="明碼實價，逐項計清"
                  color="#0b0b0b"
                  shineColor="#ff5a1f"
                  speed={3}
                  trigger="view"
                />
              </h2>
            </div>
            <p className="wd-section-note">方案及加購項目逐項列明，落單前睇清總價</p>
          </header>

          <Reveal>
            <div className="wd-price-base">
              <button
                type="button"
                className="wd-price-base-cell wd-price-base-cell--a wd-price-base-cell--select"
                aria-pressed={plan === 'front_only'}
                data-plan="front_only"
                onClick={() => pickPlan('front_only')}
              >
                <p className="wd-kicker" style={{ marginBottom: 6 }}>{catalog.frontOnlyCopy.name}</p>
                <p className="wd-price-num">{fmtHKD(catalog.frontOnlyPrice)}</p>
                <p className="wd-price-market">
                  <s>市場參考 {fmtHKD(catalog.frontOnlyMarketPrice)}</s>
                  <span className="wd-price-save">
                    慳 {fmtHKD(savings(catalog.frontOnlyPrice, catalog.frontOnlyMarketPrice))}（
                    {discountLabel(catalog.frontOnlyPrice, catalog.frontOnlyMarketPrice)}）
                  </span>
                </p>
                <p className="wd-price-plan-desc">{catalog.frontOnlyCopy.description}</p>
                <span className="wd-price-select-cta">
                  {plan === 'front_only' ? '✓ 已加入購物車' : '選擇方案，加入購物車 →'}
                </span>
              </button>
              <button
                type="button"
                className="wd-price-base-cell wd-price-base-cell--b wd-price-base-cell--select"
                aria-pressed={plan === 'full_stack'}
                data-plan="full_stack"
                onClick={() => pickPlan('full_stack')}
              >
                <p className="wd-kicker" style={{ marginBottom: 6 }}>{catalog.fullStackCopy.name}</p>
                <p className="wd-price-num">{fmtHKD(catalog.fullStackPrice)}</p>
                <p className="wd-price-market">
                  <s>市場參考 {fmtHKD(catalog.fullStackMarketPrice)}</s>
                  <span className="wd-price-save">
                    慳 {fmtHKD(savings(catalog.fullStackPrice, catalog.fullStackMarketPrice))}（
                    {discountLabel(catalog.fullStackPrice, catalog.fullStackMarketPrice)}）
                  </span>
                </p>
                <p className="wd-price-plan-desc">{catalog.fullStackCopy.description}</p>
                <span className="wd-price-select-cta">
                  {plan === 'full_stack' ? '✓ 已加入購物車' : '選擇方案，加入購物車 →'}
                </span>
              </button>
              <div className="wd-price-base-cell wd-price-base-cell--c">
                <p className="wd-kicker" style={{ marginBottom: 6 }}>點解平咁多？</p>
                <p className="wd-hint" style={{ fontSize: 14 }}>
                  AI 協作分工，人手時間大跌——詳情睇第 03 段。
                  平唔代表求其：每項交付都有清單核對。
                </p>
              </div>
            </div>
          </Reveal>

          {(['seo', 'feature', 'service'] as const).map((cat) => {
            const items = byCategory.get(cat);
            if (!items || items.length === 0) return null;
            return (
              <div key={cat}>
                <h3 className="wd-cat-title">
                  {CATEGORY_TITLE[cat]}
                  {cat === 'seo' && (
                    <span className="wd-hint" style={{ fontSize: 12.5, letterSpacing: 0 }}>
                      只列可驗證技術項目，唔承諾搜尋排名
                    </span>
                  )}
                </h3>
                <ul className="wd-rows">
                  {items.map((it) => {
                    const locked = !planAllows(effectivePlan, it.requiredPlan);
                    const inCart = selected.has(it.key);
                    return (
                      <li key={it.key} className={`wd-row${locked ? ' wd-row--locked' : ''}`}>
                        <div className="wd-row-main">
                          <p className="wd-row-name">
                            {it.name}
                            {it.requiredPlan === 'full_stack' && (
                              <span className="wd-tag wd-tag--fs">需前台＋後台</span>
                            )}
                            {it.billing === 'monthly' && (
                              <span className="wd-tag wd-tag--monthly">月費</span>
                            )}
                          </p>
                          <p className="wd-row-desc">{it.description}</p>
                          {locked && (
                            <p className="wd-lock-note">
                              「只要前台」方案冇後台，用呢個功能請揀「前台＋後台」。
                            </p>
                          )}
                        </div>
                        <div className="wd-row-price">
                          {it.billing === 'at_cost' ? (
                            <span className="wd-hint">{it.priceNote || '實報實銷'}</span>
                          ) : (
                            <>
                              <strong>
                                {fmtHKD(it.price)}
                                {it.billing === 'monthly' ? '／月' : ''}
                              </strong>
                              {it.marketPrice > 0 && <s>{fmtHKD(it.marketPrice)}</s>}
                              <span className="wd-tag">{billingLabel(it.billing)}</span>
                            </>
                          )}
                        </div>
                        <div className="wd-row-save">
                          {it.billing !== 'at_cost' && it.marketPrice > 0 && (
                            <>
                              慳 <strong>{fmtHKD(savings(it.price, it.marketPrice))}</strong>
                              <br />
                              {discountLabel(it.price, it.marketPrice)}
                            </>
                          )}
                        </div>
                        <div className="wd-row-action">
                          {it.selectable && it.billing !== 'at_cost' ? (
                            <button
                              type="button"
                              className="wd-add"
                              aria-pressed={inCart}
                              disabled={locked}
                              onClick={() => toggleItem(it)}
                            >
                              {inCart ? '✓ 已加入' : '加入'}
                            </button>
                          ) : it.key === 'website_customization' ? (
                            <div className="wd-quote-actions">
                              <span className="wd-tag">參考</span>
                              <a
                                className="wd-quote-link"
                                href="/web-design#contact"
                                onClick={(event) => {
                                  event.preventDefault();
                                  scrollToSection('contact');
                                }}
                              >
                                查詢報價 ↓
                              </a>
                            </div>
                          ) : (
                            <span className="wd-tag">參考</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          <Reveal>
            <div className="wd-price-base" style={{ marginTop: 40, marginBottom: 0 }}>
              <div className="wd-price-base-cell wd-price-base-cell--a">
                <p className="wd-kicker" style={{ marginBottom: 6 }}>雲端係咩？</p>
                <p className="wd-hint" style={{ fontSize: 14 }}>
                  網站成品需要地方存放，好似畀間屋佢住。月費已包雲端服務商收費，
                  以及系統有問題時由我哋維修，唔使自己搞伺服器。
                </p>
              </div>
              <div className="wd-price-base-cell wd-price-base-cell--b">
                <p className="wd-kicker" style={{ marginBottom: 6 }}>Domain 點計？</p>
                <p className="wd-hint" style={{ fontSize: 14 }}>
                  網域名稱一般約 HK$100–300／年，按供應商實報實銷，我哋唔會加收，
                  亦唔會強制加入購物車。
                </p>
              </div>
              <div className="wd-price-base-cell wd-price-base-cell--c">
                <p className="wd-kicker" style={{ marginBottom: 6 }}>月費點收？</p>
                <p className="wd-hint" style={{ fontSize: 14 }}>
                  今次付款 = 一次性費用＋首月月費；其後月費每月另行安排，
                  唔會自動續扣，唔想用可以隨時停。
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ===== ③ AI 協作：未來 HUD 滾動工作流 ===== */}
      <section className="wd-section wd-solid wd-ai" id="wd-ai" data-crystal="dark" aria-labelledby="wd-ai-h">
        <div className="wd-container">
          <header className="wd-ai-header">
            <div>
              <span className="wd-section-no" aria-hidden="true">03</span>
              <p className="wd-kicker">AI 協作</p>
              <h2 className="wd-h2" id="wd-ai-h">AI 加速，<br />唔係 AI 求其。</h2>
            </div>
            <p className="wd-lede">
              設計、開發同檢查由唔同 AI agent 分工推進，真人負責決策同最終驗收。
              你畀嘅係度身訂造嘅成品，唔係一撳生成嘅模板。
            </p>
          </header>
        </div>
        <AiScene />
      </section>

      {/* ===== ④ 示範網頁：真網站、真截圖 ===== */}
      <section className="wd-section wd-solid wd-demos" id="wd-demos" data-crystal="demos" aria-labelledby="wd-demos-h">
        <div className="wd-container">
          <header className="wd-section-head">
            <span className="wd-section-no" aria-hidden="true">04</span>
            <div className="wd-section-title">
              <p className="wd-kicker">示範網頁</p>
              <h2 className="wd-h2" id="wd-demos-h">唔同生意，應該有唔同樣。</h2>
            </div>
            <p className="wd-section-note">以下係已上線網站，可即刻入去睇實際效果</p>
          </header>

          <div className="wd-demo-grid">
            <Reveal>
              <article className="wd-demo-card">
                <a className="wd-demo-visual" href="https://redcode.red" target="_blank" rel="noopener noreferrer" aria-label="開啟 RedCode 官方網站（新分頁）">
                  <div className="wd-demo-browser" aria-hidden="true"><span><i /><i /><i /></span><b>redcode.red</b></div>
                  <img src="/web-design/demo-redcode.webp" alt="RedCode 官方網站首頁真實截圖" width="1381" height="1120" loading="lazy" />
                  <span className="wd-demo-open">前往網站 ↗</span>
                </a>
                <div className="wd-demo-copy">
                  <p className="wd-kicker">LIVE COMMERCE / REDCODE</p>
                  <h3 className="wd-h3">品牌、直播同購物，一個網站串連。</h3>
                  <p>以品牌視覺為主導，將商品、直播內容同會員購物流程整合，桌面同手機都有完整體驗。</p>
                  <ul className="wd-demo-features"><li>品牌首頁</li><li>商品展示</li><li>直播內容</li><li>會員購物</li></ul>
                </div>
              </article>
            </Reveal>

            <Reveal>
              <article className="wd-demo-card wd-demo-card--offset">
                <a className="wd-demo-visual" href="https://bdog.pet" target="_blank" rel="noopener noreferrer" aria-label="開啟 bDog Tokyo 網站（新分頁）">
                  <div className="wd-demo-browser" aria-hidden="true"><span><i /><i /><i /></span><b>bdog.pet</b></div>
                  <img src="/web-design/demo-bdog.webp" alt="bDog Tokyo 網站首頁真實截圖" width="1428" height="1133" loading="lazy" />
                  <span className="wd-demo-open">前往網站 ↗</span>
                </a>
                <div className="wd-demo-copy">
                  <p className="wd-kicker">SERVICE & BOOKING / BDOG TOKYO</p>
                  <h3 className="wd-h3">服務介紹之外，客人仲可以即刻行動。</h3>
                  <p>將店舖服務、網上預約同會員功能放喺清晰路徑，並提供多語切換，方便唔同客人使用。</p>
                  <ul className="wd-demo-features"><li>服務介紹</li><li>網上預約</li><li>會員中心</li><li>多語切換</li></ul>
                </div>
              </article>
            </Reveal>
          </div>
          <p className="wd-demo-note">畫面為網站首頁真實截圖；實際內容及功能以各網站現時版本為準。</p>
        </div>
      </section>

      {/* ===== ⑤ WhatsApp／留言／購物車 ===== */}
      <section className="wd-section wd-solid" id="contact" data-crystal="contact" aria-labelledby="wd-contact-h">
        <div className="wd-container">
          <header className="wd-section-head">
            <span className="wd-section-no" aria-hidden="true">05</span>
            <div className="wd-section-title">
              <p className="wd-kicker">開始</p>
              <h2 className="wd-h2" id="wd-contact-h">傾兩句，或者即刻落單</h2>
            </div>
            <p className="wd-section-note">唔急嘅話 WhatsApp 傾都得</p>
          </header>

          <div className="wd-contact-grid">
            <div className="wd-contact-left">
              <Reveal className="wd-whatsapp-reveal">
                <div className="wd-whatsapp-card">
                  <h3 className="wd-h3" style={{ color: '#f5efe3' }}>WhatsApp 直接傾</h3>
                  <p>
                    未諗清楚要咩？唔緊要。講吓你嘅生意同諗法，
                    我哋俾個實在建議你，唔硬銷。
                  </p>
                  <Magnet padding={80} magnetStrength={3}>
                    <a
                      className="wd-cta wd-cta--wa"
                      href={WHATSAPP_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      WhatsApp 查詢
                    </a>
                  </Magnet>
                </div>
              </Reveal>

              <Reveal>
                <div>
                  <h3 className="wd-h3" style={{ marginBottom: 14 }}>或者留個言</h3>
                  <InquiryForm />
                </div>
              </Reveal>
            </div>

            <div className="wd-contact-right">
              <Reveal>
                <CartPanel
                  catalog={catalog}
                  plan={plan}
                  selected={selected}
                  onRemoveItem={removeItem}
                  onChangePlan={() => {
                    setPlan(null);
                    document.getElementById('wd-services')?.scrollIntoView({ behavior: 'smooth' });
                  }}
                />
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      <CartJourneyGuide />

      <footer className="wd-footer" data-crystal="dark">
        <div className="wd-container wd-footer-inner">
          <div>
            <p className="wd-kicker">YOUR NEXT CHAPTER</p>
            <p className="wd-footer-title">由一個真正屬於你嘅網站開始。</p>
          </div>
          <a className="wd-glass-home" href="/"><span aria-hidden="true">←</span> 返回 RedCode 官網</a>
        </div>
      </footer>

    </main>
  );
}
