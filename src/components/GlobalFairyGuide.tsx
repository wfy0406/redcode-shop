import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { X } from 'lucide-react';
import GloCutout from '@/components/GloCutout';
import { usePageVisible } from '@/hooks/usePageVisible';
import {
  EMPTY_TRYON_SIGNALS,
  FAIRY_ALL_DONE_COPY,
  FAIRY_DISMISS_KEY,
  FAIRY_GENERIC_COPY,
  FAIRY_HOME_COPY,
  FAIRY_HOME_TARGET_SELECTORS,
  FAIRY_STEP_COPY,
  FAIRY_STEP_ORDER,
  FAIRY_STEP_TARGET_SELECTORS,
  HOME_FAIRY_EVENT,
  TRYON_GUIDE_EVENT,
  anchorToTarget,
  approachPoint,
  buildStepStates,
  clampFairyPosition,
  computePanelLayout,
  computeTryOnStep,
  hoverDrift,
  parseHomeFairyReaction,
  parseTryOnGuideAction,
  restPosition,
  type FairyPoint,
  type FairySize,
  type FairyStepId,
  type FairyStepStatus,
  type TryOnSignals,
} from '@/components/globalFairyGuide';

/**
 * 全域小精靈導覽（2026-10-26）
 *
 * 掛載：Layout.tsx return 最底（<PrizeWinModal /> 之後）唯一實例；
 * 組件內部以 useLocation 判路由，/admin* 自動回避（全站動效慣例）。
 *
 * 行為摘要：
 * - 全站一隻小精靈（沿用 /fairy-fly-alpha.webm、/fairy-fly-anim.webp、
 *   /fairy-fly-poster.webp 原裝素材，經 GloCutout 三層切換，位元不變）
 * - fixed 全 viewport overlay：pointer-events-none；淨係小精靈掣同打開咗嘅
 *   面板 pointer-events-auto——永遠唔會擋用戶操作
 * - /try-on 五步帶路：影相/上載 → 揀款 → 生成 → 分享/下載 → 購買；
 *   上一步完成先飛去下一步目標（目標 rect、小精靈大細、viewport 全部 cached，
 *   observer/scroll/resize 觸發先重讀，rAF 每幀零 DOM 讀取——審碼修正：
 *   offsetWidth/innerWidth 只喺 refresh() 度，flight loop 淨係讀 ref）
 * - document.hidden：observers/listeners 全部拆走＋取消 pending refresh rAF，
 *   背景分頁零工作；返前景即刻 refresh 補返；unmount 取消晒兩個 rAF
 * - 面板打開時暫停飛行，面板位唔會同小精靈分離；關埋即恢復
 * - prefers-reduced-motion 直跳唔飛（GloCutout 自己會出靜態 poster）；
 *   手機 clamp 唔出界；落腳點驗證唔冚目標掣，冇位就退休息位；
 *   overlay overflow-hidden 冇橫向 overflow
 * - 鍵盤可達：小精靈係 <button>，Esc 關面板、關咗 focus 返小精靈；可收細（角落
 *   小徽章）或今次唔使（sessionStorage）；面板入面每個掣都有真功能
 *
 * data-attribute 合約（可選，見 globalFairyGuide.ts 頭註）：
 *   data-fairy-target="photo|product|generate|share|purchase|home-cta"
 *
 * 首頁互動聯動（跨組件合約）：監聽 window `redcode:home-fairy` CustomEvent；
 * 兩種 detail 詞彙都收（見 globalFairyGuide.ts）：計劃書版 { action:'celebrate'|'shy', x?, y? }
 * 同首頁 trio 版 { action:'tap'|'shy-start'|'shy-end' }（tap→慶祝、shy-start→怕羞、shy-end 唔使郁）。
 * celebrate 開面板＋飛埋去互動位，shy 收面板＋閃開；document.hidden／reduced-motion 降級（唔飛、唔裝 listener）。
 * 小精靈淨係 listen，永遠唔 dispatch 返——唔會同首頁互相撩到 loop。
 */

type GuideTargetKey = FairyStepId | 'home';

const PANEL_ESTIMATE = { w: 320, h: 300 };

/** 喺 selector 清單入面揀第一個命中的元素（data-attribute 合約優先）。 */
function queryFirst(selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/** 由而家 TryOn DOM 讀五步訊號（純讀取，唔寫唔改頁面任何嘢）。 */
function readTryOnSignals(): Omit<TryOnSignals, 'shareActed' | 'purchaseActed'> {
  const hasPhoto = !!document.querySelector('.tryon-photo-panel .tryon-photo-preview');
  const selectionCount = document.querySelectorAll('.tryon-product-card[data-selected="true"]').length;
  const statusEl = document.querySelector('.tryon-result-section .tryon-job-status');
  const status = statusEl?.getAttribute('data-status') ?? '';
  return {
    hasPhoto,
    selectionCount,
    jobPresent: !!statusEl,
    jobActive: status === 'queued' || status === 'processing',
    jobCompleted: status === 'completed',
    purchasePresent: !!document.querySelector('[data-testid="tryon-purchase"]'),
  };
}

export default function GlobalFairyGuide() {
  const { pathname } = useLocation();
  const pageVisible = usePageVisible();
  // 管理員工作台係數據密集頁（全站慣例：admin 唔要動效裝飾），小精靈一齊回避
  const isAdmin = pathname.startsWith('/admin');
  const isTryOn = pathname === '/try-on';
  const isHome = pathname === '/';

  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(FAIRY_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [minimized, setMinimized] = useState(false);
  const [open, setOpen] = useState(false);
  const [signals, setSignals] = useState<TryOnSignals>(EMPTY_TRYON_SIGNALS);
  const [panelPos, setPanelPos] = useState<FairyPoint | null>(null);

  const fairyRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef<FairyPoint | null>(null);
  const signalsRef = useRef<TryOnSignals>(EMPTY_TRYON_SIGNALS);
  const shareActedRef = useRef(false);
  const purchaseActedRef = useRef(false);
  const prevCompletedRef = useRef(false);
  // 首頁互動聯動（redcode:home-fairy）：短時間內嘅「反應落腳點」，過期即返正常目標
  const reactionRef = useRef<{ point: FairyPoint; until: number } | null>(null);
  // 目標元素＋rect 快取：observer/scroll/resize 先更新，飛行迴圈零 DOM 讀取
  const targetsRef = useRef<Map<GuideTargetKey, { el: Element; rect: DOMRect }>>(new Map());
  // 小精靈大細＋viewport 都快取喺 ref：淨係 refresh()（observer/scroll/resize 觸發）
  // 先會讀 offsetWidth/innerWidth，rAF 每幀唔再掂 layout（審碼修正 2026-10-26）
  const sizeRef = useRef<FairySize>({ w: 96, h: 48 });
  const viewportRef = useRef<FairySize>({
    w: typeof window === 'undefined' ? 390 : window.innerWidth,
    h: typeof window === 'undefined' ? 844 : window.innerHeight,
  });
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  // scheduleRefresh 嘅 pending rAF id（0 = 冇），方便 hidden／unmount 時取消
  const scheduledRafRef = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 路由轉換：行為紀錄清零（新頁重新帶路），順手收埋面板＋清走反應落腳點
  useEffect(() => {
    shareActedRef.current = false;
    purchaseActedRef.current = false;
    prevCompletedRef.current = false;
    reactionRef.current = null;
    setOpen(false);
    setSignals(EMPTY_TRYON_SIGNALS);
    signalsRef.current = EMPTY_TRYON_SIGNALS;
  }, [pathname]);

  /** 唯一會讀 layout 嘅地方：refresh 入面先度小精靈大細（rAF 迴圈唔會call）。 */
  const measureFairy = () => {
    const el = fairyRef.current;
    if (el && el.offsetWidth > 0) {
      sizeRef.current = { w: el.offsetWidth, h: el.offsetHeight };
    }
  };

  /** 重讀 viewport／小精靈大細／目標 rect 快取＋TryOn 訊號。只喺 observer/scroll/resize/點擊觸發。 */
  const refresh = useCallback(() => {
    if (typeof document === 'undefined') return;
    viewportRef.current = { w: window.innerWidth, h: window.innerHeight };
    measureFairy();
    const cache = targetsRef.current;
    if (isTryOn) {
      for (const step of FAIRY_STEP_ORDER) {
        const cached = cache.get(step);
        const el = cached?.el.isConnected ? cached.el : queryFirst(FAIRY_STEP_TARGET_SELECTORS[step]);
        if (el) {
          cache.set(step, { el, rect: el.getBoundingClientRect() });
        } else {
          cache.delete(step);
        }
      }
    } else {
      for (const step of FAIRY_STEP_ORDER) cache.delete(step);
    }
    if (isHome) {
      const cached = cache.get('home');
      const el = cached?.el.isConnected ? cached.el : queryFirst(FAIRY_HOME_TARGET_SELECTORS);
      if (el) cache.set('home', { el, rect: el.getBoundingClientRect() });
      else cache.delete('home');
    } else {
      cache.delete('home');
    }

    if (isTryOn) {
      // 新一次生成開始 → 分享／購買行為紀錄清零，唔會假裝已做
      const dom = readTryOnSignals();
      if (dom.jobActive && prevCompletedRef.current) {
        shareActedRef.current = false;
        purchaseActedRef.current = false;
      }
      prevCompletedRef.current = dom.jobCompleted;
      const next: TryOnSignals = {
        ...dom,
        shareActed: shareActedRef.current,
        purchaseActed: purchaseActedRef.current,
      };
      const prev = signalsRef.current;
      const changed = (Object.keys(next) as Array<keyof TryOnSignals>).some((key) => next[key] !== prev[key]);
      if (changed) {
        signalsRef.current = next;
        setSignals(next);
      }
    }

    // reduced-motion：冇飛行迴圈，呢度直接把小精靈放去目標（都係 observer 驅動，唔係每幀）
    if (reducedMotion) {
      const el = fairyRef.current;
      if (el) {
        const rest = restPosition(viewportRef.current, sizeRef.current);
        el.style.transform = `translate3d(${Math.round(rest.x)}px, ${Math.round(rest.y)}px, 0)`;
      }
    }
  }, [isHome, isTryOn, reducedMotion]);

  /** rAF 合併嘅 refresh（observer/事件風暴都唔會連環觸發 DOM 讀取）。 */
  const scheduleRefresh = useCallback(() => {
    if (scheduledRafRef.current) return;
    scheduledRafRef.current = requestAnimationFrame(() => {
      scheduledRafRef.current = 0;
      refresh();
    });
  }, [refresh]);

  /** 取消 pending 嘅 scheduled refresh（hidden／unmount 時調用，防離場後做嘢）。 */
  const cancelScheduledRefresh = useCallback(() => {
    if (scheduledRafRef.current) {
      cancelAnimationFrame(scheduledRafRef.current);
      scheduledRafRef.current = 0;
    }
  }, []);

  // DOM 觀察：MutationObserver（TryOn 狀態轉換）＋ ResizeObserver ＋ scroll ＋ resize。
  // document.hidden（pageVisible=false）→ 全部 observer/listener 拆走＋取消 pending
  // refresh，背景分頁零工作；返前景 effect 重跑 → 即刻 refresh() 補返最新狀態。
  useEffect(() => {
    if (dismissed || isAdmin || !pageVisible) return;
    refresh();
    // 留意：小精靈自己每幀寫 style.transform——mutation 喺自己 root 入面要跳過，
    // 否則 observer 俾自己觸發到變相每幀讀 DOM
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const t = mutation.target;
        if (t instanceof Element && t.closest('[data-fairy-guide-root]')) continue;
        scheduleRefresh();
        return;
      }
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-status', 'data-selected', 'data-active'],
    });
    const ro = new ResizeObserver(scheduleRefresh);
    ro.observe(document.body);
    window.addEventListener('resize', scheduleRefresh);
    // capture：頁面入面任何 scroll 容器郁都會更新 cached rect
    window.addEventListener('scroll', scheduleRefresh, { capture: true, passive: true });
    return () => {
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener('resize', scheduleRefresh);
      window.removeEventListener('scroll', scheduleRefresh, true);
      cancelScheduledRefresh();
    };
  }, [dismissed, isAdmin, pageVisible, pathname, refresh, scheduleRefresh, cancelScheduledRefresh]);

  // 分享／購買「完成」偵測（2026-10-26 第二輪）：廢除 capture-phase click 推測——
  // 舊寫法 target.closest('[data-fairy-target="purchase"]') 會令購買區任何 click
  // （優惠碼 input、wallet switch、移出清單、空白位）都誤記做已購買＝假進度。
  // 而家只聽 TRYON_GUIDE_EVENT 明確成功事件（download/nativeShare/WhatsApp 真開分享、
  // addMany 成功＋record 更新、buyNow draft 儲存成功先會由 TryOn/TryOnPurchase dispatch）。
  // hidden／dismissed／admin 唔裝 listener；reduced-motion 照聽（狀態更新冇動作成分）。
  useEffect(() => {
    if (!isTryOn || dismissed || isAdmin || !pageVisible) return;
    const onGuideAction = (event: Event) => {
      const action = parseTryOnGuideAction(event instanceof CustomEvent ? event.detail : null);
      if (!action) return;
      if (action === 'share') shareActedRef.current = true;
      if (action === 'purchase') purchaseActedRef.current = true;
      scheduleRefresh();
    };
    window.addEventListener(TRYON_GUIDE_EVENT, onGuideAction);
    return () => {
      window.removeEventListener(TRYON_GUIDE_EVENT, onGuideAction);
      cancelScheduledRefresh();
    };
  }, [dismissed, isAdmin, isTryOn, pageVisible, scheduleRefresh, cancelScheduledRefresh]);

  // 首頁互動聯動（跨組件合約）：首頁 dispatch `redcode:home-fairy`，小精靈做可見反應——
  // celebrate：飛埋去互動位＋開面板打招呼；shy：收埋面板＋閃去遠離互動嘅低位。
  // document.hidden（pageVisible=false）／已收皮／admin 頁一律唔裝 listener（降級唔做）；
  // reduced-motion 唔飛（唔設反應落腳點），只開／關面板呢種無動作反應。
  useEffect(() => {
    if (dismissed || isAdmin || !pageVisible) return;
    const onHomeFairy = (event: Event) => {
      const reaction = parseHomeFairyReaction(event instanceof CustomEvent ? event.detail : null);
      if (!reaction) return;
      const viewport = viewportRef.current;
      const size = sizeRef.current;
      const px = reaction.x;
      const py = reaction.y;
      const hasPoint = typeof px === 'number' && typeof py === 'number' && !reducedMotion;
      if (reaction.action === 'celebrate') {
        setMinimized(false);
        setOpen(true);
        if (hasPoint) {
          reactionRef.current = {
            point: { x: px - size.w / 2, y: py - size.h / 2 },
            until: performance.now() + 2400,
          };
        }
      } else {
        setOpen(false);
        if (hasPoint) {
          // 怕醜：閃去水平鏡像、貼近底部嘅位（夾取後一定喺 viewport 內）
          reactionRef.current = {
            point: { x: viewport.w - px - size.w / 2, y: viewport.h - size.h - 64 },
            until: performance.now() + 1800,
          };
        }
      }
      scheduleRefresh();
    };
    window.addEventListener(HOME_FAIRY_EVENT, onHomeFairy);
    return () => {
      window.removeEventListener(HOME_FAIRY_EVENT, onHomeFairy);
    };
  }, [dismissed, isAdmin, pageVisible, reducedMotion, scheduleRefresh]);

  // unmount 雙保險：取消 pending refresh rAF＋飛行 rAF，離場後零工作
  useEffect(() => {
    return () => {
      cancelScheduledRefresh();
      cancelAnimationFrame(rafRef.current);
    };
  }, [cancelScheduledRefresh]);

  /** 目標落腳點：全部讀快取（targetsRef／viewportRef／sizeRef），零 DOM 查詢。 */
  const currentAnchor = useCallback((): FairyPoint => {
    const viewport = viewportRef.current;
    const size = sizeRef.current;
    // 首頁互動反應窗：有效期內小精靈飛去互動位（已夾入 viewport），過期即丟
    const reaction = reactionRef.current;
    if (reaction) {
      if (performance.now() < reaction.until) {
        return clampFairyPosition(reaction.point, viewport, size);
      }
      reactionRef.current = null;
    }
    let rect: DOMRect | undefined;
    if (isTryOn) {
      rect = targetsRef.current.get(computeTryOnStep(signalsRef.current))?.rect;
    } else if (isHome) {
      rect = targetsRef.current.get('home')?.rect;
    }
    if (rect && rect.width > 0 && rect.height > 0) {
      return anchorToTarget(rect, viewport, size);
    }
    return restPosition(viewport, size);
  }, [isHome, isTryOn]);

  // 飛行迴圈：transform 直寫 style（唔經 React re-render），每幀零 DOM 讀取；
  // document.hidden／reduced-motion／收細／關閉／面板打開都會停，唔會背景嘥電，
  // 面板開住時暫停飛行——面板位係開嗰刻按小精靈位置計，繼續飛會同面板分離。
  const active = !dismissed && !minimized && !isAdmin;
  useEffect(() => {
    if (!active || reducedMotion || !pageVisible || open) return;
    const el = fairyRef.current;
    if (!el) return;
    if (!posRef.current) posRef.current = currentAnchor();
    lastFrameRef.current = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastFrameRef.current) / 1000);
      lastFrameRef.current = now;
      const anchor = currentAnchor();
      const pos = approachPoint(posRef.current ?? anchor, anchor, dt);
      posRef.current = pos;
      const drift = hoverDrift(now / 1000);
      const clamped = clampFairyPosition({ x: pos.x + drift.x, y: pos.y + drift.y }, viewportRef.current, sizeRef.current);
      el.style.transform = `translate3d(${Math.round(clamped.x)}px, ${Math.round(clamped.y)}px, 0)`;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, reducedMotion, pageVisible, open, currentAnchor]);

  // 面板擺位：打開時＋訊號變化時計一次（面板開住時飛行已暫停，小精靈唔會郁，
  // 所以唔使逐幀跟）；panelRef 度尺只係一次性事件，唔喺 rAF 入面
  useEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const viewport = viewportRef.current;
    const size = sizeRef.current;
    const origin = posRef.current ?? restPosition(viewport, size);
    const measured = panelRef.current;
    const panel = measured
      ? { w: measured.offsetWidth, h: measured.offsetHeight }
      : PANEL_ESTIMATE;
    setPanelPos(computePanelLayout(origin, size, panel, viewport));
  }, [open, signals]);

  // 打開面板：focus 入去；關閉：focus 返小精靈（鍵盤用戶唔會迷路）
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      panelRef.current?.querySelector<HTMLElement>('[data-fairy-close]')?.focus();
    }
    if (!open && wasOpenRef.current) {
      fairyRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  if (dismissed || isAdmin) return null;

  const step: FairyStepId = isTryOn ? computeTryOnStep(signals) : 'photo';
  const allDone = isTryOn && signals.purchaseActed;
  const stepStates = allDone
    ? FAIRY_STEP_ORDER.map((id) => ({ id, status: 'done' as FairyStepStatus }))
    : buildStepStates(step);
  const copy = allDone
    ? FAIRY_ALL_DONE_COPY
    : isTryOn
      ? FAIRY_STEP_COPY[step]
      : isHome
        ? FAIRY_HOME_COPY
        : FAIRY_GENERIC_COPY;

  const statusLabel = (status: FairyStepStatus) =>
    status === 'done' ? '完成' : status === 'current' ? '而家' : '未到';

  const dismissForSession = () => {
    try {
      window.sessionStorage.setItem(FAIRY_DISMISS_KEY, '1');
    } catch {
      // 私密模式寫唔入都照收，重新整理先會再出現
    }
    setOpen(false);
    setDismissed(true);
  };

  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 60 }}
      data-fairy-guide-root=""
    >
      {/* 收細狀態：角落小徽章，撳返大。都係真掣，唔係裝飾。 */}
      {minimized ? (
        <button
          type="button"
          onClick={() => setMinimized(false)}
          aria-label="開返小精靈 Glo Glo 幫助"
          className="pointer-events-auto absolute bottom-4 left-4 h-11 w-11 cursor-pointer rounded-full border border-[var(--glass-border)] bg-space-2/90 p-1 shadow-lg outline-none backdrop-blur focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          <img
            src="/fairy-fly-poster.webp"
            alt=""
            width={512}
            height={256}
            className="h-full w-full object-contain"
          />
        </button>
      ) : (
        <button
          ref={fairyRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? '收埋小精靈 Glo Glo 幫助面板' : '小精靈 Glo Glo：撳我開幫助同試穿帶路'}
          className="pointer-events-auto absolute left-0 top-0 w-[clamp(64px,18vw,104px)] cursor-pointer border-0 bg-transparent p-0 outline-none will-change-transform focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
        >
          <GloCutout
            videoSrc="/fairy-fly-alpha.webm"
            animSrc="/fairy-fly-anim.webp"
            poster="/fairy-fly-poster.webp"
            alt=""
            eager
            posterW={512}
            posterH={256}
          />
          {isTryOn && !allDone && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-gold text-[11px] font-bold text-space-1"
            >
              {FAIRY_STEP_ORDER.indexOf(step) + 1}
            </span>
          )}
        </button>
      )}

      {/* 幫助／帶路面板：非 modal，唔會鎖住頁面；Esc 或 ✕ 關閉 */}
      {open && !minimized && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="小精靈 Glo Glo 幫助"
          className="pointer-events-auto absolute w-[min(320px,calc(100vw-32px))] rounded-2xl border border-[var(--glass-border)] bg-space-2/95 p-4 text-txt-1 shadow-2xl backdrop-blur"
          style={panelPos ? { left: panelPos.x, top: panelPos.y } : { left: 16, bottom: 16, top: 'auto' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[15px] font-bold">{copy.title}</p>
            <button
              type="button"
              data-fairy-close=""
              onClick={() => setOpen(false)}
              aria-label="關閉幫助面板"
              className="shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-1 text-txt-3 outline-none hover:text-txt-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          {isTryOn && (
            <ol aria-label="試穿五步進度" className="mt-3 space-y-1.5">
              {stepStates.map(({ id, status }) => (
                <li
                  key={id}
                  aria-current={status === 'current' ? 'step' : undefined}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[13px] ${
                    status === 'current' ? 'bg-space-1 font-bold' : ''
                  }`}
                >
                  <span className={status === 'todo' ? 'text-txt-3' : ''}>{FAIRY_STEP_COPY[id].title}</span>
                  <span
                    className={`shrink-0 text-[11px] ${
                      status === 'done' ? 'text-gold' : status === 'current' ? 'text-txt-1' : 'text-txt-3'
                    }`}
                  >
                    {statusLabel(status)}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <p className="mt-3 text-[13px] leading-[1.7] text-txt-3">{copy.body}</p>

          {!isTryOn && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to="/try-on"
                className="btn btn-primary !px-4 !py-2 text-[13px] font-bold"
                onClick={() => setOpen(false)}
              >
                開始 AI 試穿
              </Link>
              {isHome ? (
                <Link
                  to="/products"
                  className="btn btn-secondary !px-4 !py-2 text-[13px]"
                  onClick={() => setOpen(false)}
                >
                  先去揀心水款
                </Link>
              ) : (
                <Link
                  to="/faq"
                  className="btn btn-secondary !px-4 !py-2 text-[13px]"
                  onClick={() => setOpen(false)}
                >
                  常見問題
                </Link>
              )}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3 border-t border-[var(--glass-border)] pt-3 text-[12px]">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setMinimized(true);
              }}
              className="cursor-pointer border-0 bg-transparent p-0 text-txt-3 underline underline-offset-2 outline-none hover:text-txt-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              收細做角落徽章
            </button>
            <button
              type="button"
              onClick={dismissForSession}
              className="cursor-pointer border-0 bg-transparent p-0 text-txt-3 underline underline-offset-2 outline-none hover:text-txt-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              今次唔使（關咗個 tab 先再出現）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
