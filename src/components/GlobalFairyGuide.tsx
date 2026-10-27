import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { X } from 'lucide-react';
import { usePageVisible } from '@/hooks/usePageVisible';
import FairyActionAnimation from '@/components/FairyActionAnimation';
import { nextFairyAction, type FairyAction } from '@/components/fairyActions';
import {
  EMPTY_TRYON_SIGNALS,
  FAIRY_DISMISS_KEY,
  TRYON_GUIDE_EVENT,
  chooseFairyPlacement,
  computeBubbleLayout,
  computeTryOnStep,
  expandRect,
  getFairyRouteGuide,
  intersectRect,
  parseTryOnGuideAction,
  visibleActionRect,
  type FairyGuideCandidate,
  type FairyPoint,
  type FairyRect,
  type FairySize,
  type FairyStepCopy,
  type TryOnSignals,
} from '@/components/globalFairyGuide';
import './GlobalFairyGuide.css';

type CandidateTarget = {
  element: HTMLElement;
  candidate: FairyGuideCandidate;
  rect: FairyRect;
  visibleRect: FairyRect;
};

type Resolution = {
  pathname: string;
  candidateId: string | null;
  hint: FairyStepCopy;
  ring: FairyRect | null;
  point: FairyPoint | null;
  obstacleKey: string;
  canScroll: boolean;
  placed: boolean;
  viewport: FairySize;
};

const VIEWPORT_RECT = (): FairyRect => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

function toRect(rect: DOMRect): FairyRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function roundedRect(rect: FairyRect | null): FairyRect | null {
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function sameRect(a: FairyRect | null, b: FairyRect | null): boolean {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function samePoint(a: FairyPoint | null, b: FairyPoint | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y;
}

function makeObstacleKey(rects: readonly FairyRect[]): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  return rects.map((rect) => [rect.left, rect.top, rect.width, rect.height].map(round).join(',')).join('|');
}

function baseFairySize(viewport: FairySize): FairySize {
  // 同 CSS 嘅 responsive 寬度一致；統一用 458:768 等比例縮放，唔會拉扁造型。
  const w = viewport.h <= 560 ? 60 : viewport.w <= 480 ? 66 : Math.min(86, Math.max(66, viewport.w * 0.0625));
  return { w, h: w * 768 / 458 };
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  return (
    a.pathname === b.pathname &&
    a.candidateId === b.candidateId &&
    a.hint.title === b.hint.title &&
    a.hint.body === b.hint.body &&
    a.canScroll === b.canScroll &&
    a.placed === b.placed &&
    a.viewport.w === b.viewport.w &&
    a.viewport.h === b.viewport.h &&
    a.obstacleKey === b.obstacleKey &&
    samePoint(a.point, b.point) &&
    sameRect(a.ring, b.ring)
  );
}

/** 只等真正進場元素嘅有限位移；直播燈等 infinite 動畫及卡片 hover 唔會阻住導覽。 */
function hasUnsettledEntranceMotion(): boolean {
  if (typeof document.getAnimations !== 'function') return false;
  return document.getAnimations().some((animation) => {
    if (animation.playState === 'finished' || animation.playState === 'idle' || animation.playState === 'paused') return false;
    const effect = animation.effect;
    if (effect?.getTiming().iterations === Infinity) return false;
    const target = effect && 'target' in effect ? (effect as KeyframeEffect).target : null;
    if (!(target instanceof Element) || !target.matches('main .reveal, main .lr-enter, main .hero-enter')) return false;
    // 完全離屏嘅 reveal（例如下方橫向牆）唔會改變而家可見目標，唔應令全站精靈無故閃避。
    if (!intersectRect(toRect(target.getBoundingClientRect()), VIEWPORT_RECT())) return false;
    if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition) {
      return animation.transitionProperty === 'transform';
    }
    return true;
  });
}

function isRendered(element: Element, includeAriaHidden = false): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  // aria-hidden 只係無障礙樹語義，裝飾浮卡仍然肉眼可見；只有 obstacle 收集會豁免，target 唔會放寬。
  if (element.closest(includeAriaHidden ? '[inert]' : '[inert], [aria-hidden="true"]')) return false;
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    current = current.parentElement;
  }
  return element.getClientRects().length > 0;
}

function isActionable(element: HTMLElement): boolean {
  if (!isRendered(element) || element.closest('header, [data-fairy-guide-root]')) return false;
  if (element.matches(':disabled, [aria-disabled="true"]')) return false;
  return window.getComputedStyle(element).pointerEvents !== 'none';
}

/** 真可見唔只係 rect 喺畫面入面：中心及四個採樣點至少一點冇被其他層遮住。 */
function isUnoccluded(element: HTMLElement, visible: FairyRect): boolean {
  if (typeof document.elementsFromPoint !== 'function') return true;
  const insetX = Math.min(6, visible.width / 4);
  const insetY = Math.min(6, visible.height / 4);
  const left = visible.left + insetX;
  const right = visible.left + visible.width - insetX;
  const top = visible.top + insetY;
  const bottom = visible.top + visible.height - insetY;
  const cx = visible.left + visible.width / 2;
  const cy = visible.top + visible.height / 2;
  const points = [
    [cx, cy],
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
  return points.some(([x, y]) => {
    const stack = document.elementsFromPoint(x, y);
    const hit = stack.find((item) => !item.closest('[data-fairy-guide-root]'));
    return !!hit && (hit === element || element.contains(hit));
  });
}

function readTryOnSignals(): Omit<TryOnSignals, 'shareActed' | 'purchaseActed'> {
  const statusEl = document.querySelector('.tryon-result-section .tryon-job-status');
  const status = statusEl?.getAttribute('data-status') ?? '';
  return {
    hasPhoto: !!document.querySelector('.tryon-photo-panel .tryon-photo-preview'),
    selectionCount: document.querySelectorAll('.tryon-product-card[data-selected="true"]').length,
    jobPresent: !!statusEl,
    jobActive: status === 'queued' || status === 'processing',
    jobCompleted: status === 'completed',
    purchasePresent: !!document.querySelector('[data-testid="tryon-purchase"]'),
  };
}

function collectElements(selectors: readonly string[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        result.push(element);
      }
    }
  }
  return result;
}

const NAV_OBSTACLE_SELECTORS = [
  'header.sticky.top-0',
  '.btn-whatsapp',
  '.btn-messenger',
  '[aria-label="安裝 RedCode App 提示"]',
  'body .fixed.bottom-0',
] as const;

const CONTROL_OBSTACLE_SELECTOR =
  'main button, main a[href], main input, main select, main textarea, main [role="radio"], main [role="tab"]';

const MEDIA_OBSTACLE_SELECTORS = [
  'main article img',
  'main [class*="product"] img',
  'main [class*="gallery"] img',
  'main .duotone img',
  'main .overflow-x-auto img',
  // Home hero 浮卡用 MovingPhoto（video＋poster），冇 product/gallery/duotone class；成張旋轉卡都要避。
  'main [aria-hidden="true"].absolute.rounded-2xl',
  'main .tryon-result-frame',
  'main .tryon-source-comparison',
  'main .tryon-photo-stage',
  // 抽獎公告卡包含日期、得主及獎品，唔只係裝飾框；全張卡都唔可以畀精靈冚住。
  'main .lr-card',
] as const;

// 標題、商品資料同段落唔係可撳控制，但公仔或氣泡冚住都礙眼；FAQ 中文段落名係 span，所以一併涵蓋。
const CONTENT_OBSTACLE_SELECTOR =
  'main h1, main h2, main h3, main h4, main p, main figcaption, main blockquote, main dt, main dd, main .faq-kicker-cn, main header > p.script';

/**
 * 標題元素通常係全寬 block；直接用元素外框會將文字右邊嘅空白都當禁區，
 * 令窄屏完全冇位放精靈。Range 只量實際文字行，既避開字，又保留可用空白。
 */
function collectContentObstacles(viewport: FairyRect): FairyRect[] {
  const result: FairyRect[] = [];
  for (const element of collectElements([CONTENT_OBSTACLE_SELECTOR])) {
    if (!isRendered(element)) continue;
    const range = document.createRange();
    range.selectNodeContents(element);
    for (const rect of Array.from(range.getClientRects())) {
      const visible = intersectRect(toRect(rect), viewport);
      if (visible) result.push(expandRect(visible, 5));
    }
    range.detach();
  }
  return result;
}

function collectObstacles(): { all: FairyRect[]; critical: FairyRect[] } {
  const viewport = VIEWPORT_RECT();
  const critical: FairyRect[] = [];
  const all: FairyRect[] = [];
  const seen = new Set<HTMLElement>();
  const add = (elements: Iterable<HTMLElement>, target: FairyRect[]) => {
    for (const element of elements) {
      if (seen.has(element) && target === all) continue;
      if (!isRendered(element, true)) continue;
      const visible = intersectRect(toRect(element.getBoundingClientRect()), viewport);
      if (visible) target.push(expandRect(visible, element.tagName === 'HEADER' ? 8 : 5));
      if (target === all) seen.add(element);
    }
  };
  add(collectElements(NAV_OBSTACLE_SELECTORS), critical);
  add(collectElements(NAV_OBSTACLE_SELECTORS), all);
  add(collectElements([CONTROL_OBSTACLE_SELECTOR, ...MEDIA_OBSTACLE_SELECTORS]), all);
  all.push(...collectContentObstacles(viewport));
  return { all, critical };
}

function hasBlockingLayer(): boolean {
  return collectElements([
    '[aria-modal="true"]',
    'nav[aria-label="手機導航"]',
    '[role="status"][aria-label="頁面載入中"]',
  ]).some((element) => isRendered(element));
}

export default function GlobalFairyGuide() {
  const { pathname } = useLocation();
  const pageVisible = usePageVisible();
  const isAdmin = pathname.startsWith('/admin');
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(FAIRY_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  const [denied, setDenied] = useState(false);
  const [signals, setSignals] = useState<TryOnSignals>(EMPTY_TRYON_SIGNALS);
  const [bubblePos, setBubblePos] = useState<FairyPoint | null>(null);
  const [bubbleMode, setBubbleMode] = useState<'full' | 'short' | 'compact' | 'micro'>('full');
  const [fairyAction, setFairyAction] = useState<FairyAction>('wave');
  const [actionReplay, setActionReplay] = useState(0);
  const [resolution, setResolution] = useState<Resolution>(() => ({
    pathname,
    candidateId: null,
    hint: getFairyRouteGuide(pathname).fallback,
    ring: null,
    point: null,
    obstacleKey: '',
    canScroll: false,
    placed: false,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  }));

  const fairyRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef<FairyPoint | null>(null);
  const sizeRef = useRef<FairySize>({ w: 76, h: 128 });
  const bubbleObstaclesRef = useRef<FairyRect[]>([]);
  const pendingTargetRef = useRef<CandidateTarget | null>(null);
  const signalsRef = useRef<TryOnSignals>(EMPTY_TRYON_SIGNALS);
  const shareActedRef = useRef(false);
  const purchaseActedRef = useRef(false);
  const prevCompletedRef = useRef(false);
  const openRef = useRef(false);
  const positionedRef = useRef(false);
  const scheduledRafRef = useRef(0);
  const refreshTimerRef = useRef(0);
  const revealRafRef = useRef(0);
  const focusTimerRef = useRef(0);
  const scrollSettleTimerRef = useRef(0);
  const motionRetryTimerRef = useRef(0);
  const deniedTimerRef = useRef(0);
  const scrollingRef = useRef(false);
  const scrollTargetRef = useRef<EventTarget | null>(null);
  const scrollRafRef = useRef(0);
  const scrollEndCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // 動作播放器會喺目前動畫真正可顯示後先起計完整循環；scroll 唔會暫停動作。
  const completeFairyAction = useCallback((completed: FairyAction) => {
    setFairyAction((current) => current === completed ? nextFairyAction(current) : current);
  }, []);

  useEffect(() => {
    shareActedRef.current = false;
    purchaseActedRef.current = false;
    prevCompletedRef.current = false;
    pendingTargetRef.current = null;
    signalsRef.current = EMPTY_TRYON_SIGNALS;
    positionRef.current = null;
    positionedRef.current = false;
    if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current);
    if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
    revealRafRef.current = 0;
    deniedTimerRef.current = 0;
    // transform／transition 完全由呢個元件嘅 DOM ref 擁有，React 唔再重寫同一組屬性。
    if (fairyRef.current) fairyRef.current.style.transition = 'none';
    setSignals(EMPTY_TRYON_SIGNALS);
    setOpen(false);
    setDenied(false);
    setBubblePos(null);
    setBubbleMode('full');
  }, [pathname]);

  const cancelScheduled = useCallback(() => {
    scrollEndCleanupRef.current?.();
    scrollEndCleanupRef.current = null;
    if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    if (scheduledRafRef.current) cancelAnimationFrame(scheduledRafRef.current);
    if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current);
    if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    if (scrollSettleTimerRef.current) window.clearTimeout(scrollSettleTimerRef.current);
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    if (motionRetryTimerRef.current) window.clearTimeout(motionRetryTimerRef.current);
    if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
    refreshTimerRef.current = 0;
    scheduledRafRef.current = 0;
    revealRafRef.current = 0;
    focusTimerRef.current = 0;
    scrollSettleTimerRef.current = 0;
    scrollRafRef.current = 0;
    motionRetryTimerRef.current = 0;
    deniedTimerRef.current = 0;
    scrollingRef.current = false;
    scrollTargetRef.current = null;
  }, []);

  /** 唯一 layout 讀取入口；scroll 中每個 rAF 都量真位置，停滾只做最後复核。 */
  const refresh = useCallback((): void => {
    if (document.hidden || dismissed || isAdmin) return;
    if (hasUnsettledEntranceMotion()) {
      if (openRef.current) setOpen(false);
      setDenied(false);
      // 進場位移期間照樣用當下幾何放精靈；唔再先藏起。非 scroll 時以短 retry 跟到動畫完。
      if (!scrollingRef.current && !motionRetryTimerRef.current) {
        motionRetryTimerRef.current = window.setTimeout(() => {
          motionRetryTimerRef.current = 0;
          refresh();
        }, 50);
      }
    } else {
      if (motionRetryTimerRef.current) window.clearTimeout(motionRetryTimerRef.current);
      motionRetryTimerRef.current = 0;
    }
    const viewportSize = { w: window.innerWidth, h: window.innerHeight };
    const viewportRect: FairyRect = { left: 0, top: 0, width: viewportSize.w, height: viewportSize.h };
    const fairy = fairyRef.current;
    const naturalSize = baseFairySize(viewportSize);
    sizeRef.current = naturalSize;

    if (pathname === '/try-on') {
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
      const changed = (Object.keys(next) as Array<keyof TryOnSignals>).some(
        (key) => next[key] !== signalsRef.current[key],
      );
      if (changed) {
        signalsRef.current = next;
        setSignals(next);
      }
    }

    const step = computeTryOnStep(signalsRef.current);
    const guide = getFairyRouteGuide(pathname, step, {
      tryOnAccess: !!document.querySelector('main .tryon-access-card'),
      walletPayment: !!document.querySelector('#wallet-pay-panel'),
    });
    const blocked = hasBlockingLayer();
    let active: CandidateTarget | null = null;
    let pending: CandidateTarget | null = null;
    let unavailable: CandidateTarget | null = null;

    if (!blocked) {
      for (const candidate of guide.candidates) {
        const elements = collectElements(candidate.selectors);
        for (const element of elements) {
          if (!isActionable(element)) continue;
          const rect = toRect(element.getBoundingClientRect());
          if (rect.width <= 0 || rect.height <= 0) continue;
          const visibleRect = visibleActionRect(rect, viewportSize);
          const target: CandidateTarget = { element, candidate, rect, visibleRect: visibleRect ?? rect };
          if (!unavailable) unavailable = target;
          if (visibleRect && isUnoccluded(element, visibleRect)) {
            active = { ...target, visibleRect };
            break;
          }
          // 可見但被其他層遮住唔係「捲過去」就解決；只有真離屏先提供帶我去。
          if (!visibleRect && !pending) pending = target;
        }
        if (active) break;
      }
    }
    pendingTargetRef.current = active ? null : pending;

    const obstacles = collectObstacles();
    // 使用者撳開都唔係豁免：氣泡同精靈一樣避開商品、TryOn 媒體、真控制、公告及實際文字。
    bubbleObstaclesRef.current = obstacles.all;
    let placement: ReturnType<typeof chooseFairyPlacement> = null;
    if (!blocked) {
      // 原尺寸真係完全無安全位時，先逐級等比例縮細再重掃；所有商品、文字及控制碰撞照舊。
      // 44px 係最細互動寬度，唔會為咗硬塞而變成難以點擊嘅裝飾點。
      const widths = [...new Set([naturalSize.w, 66, 56, 48, 44].filter((width) => width <= naturalSize.w))];
      for (const width of widths) {
        const size = { w: width, h: width * 768 / 458 };
        const candidate = chooseFairyPlacement({
          viewport: viewportSize,
          fairy: size,
          target: active?.visibleRect ?? null,
          obstacles: obstacles.all,
          current: positionRef.current,
        });
        if (!candidate) continue;
        placement = candidate;
        sizeRef.current = size;
        if (fairy) {
          const nextWidth = width === naturalSize.w ? '' : `${width}px`;
          if (fairy.style.width !== nextWidth) fairy.style.width = nextWidth;
        }
        break;
      }
    }

    if (placement && fairy) {
      positionRef.current = placement.point;
      fairy.style.transform = `translate3d(${Math.round(placement.point.x)}px, ${Math.round(placement.point.y)}px, 0)`;
      if (!positionedRef.current) {
        positionedRef.current = true;
        revealRafRef.current = requestAnimationFrame(() => {
          revealRafRef.current = 0;
          if (fairyRef.current) fairyRef.current.style.transition = '';
        });
      }
    }

    // 失去安全位會收埋氣泡，之後恢復時唔可以無使用者操作又自動彈出。
    if ((blocked || !placement) && openRef.current) setOpen(false);
    const ring = placement && active
      ? roundedRect(intersectRect(expandRect(active.visibleRect, 5), viewportRect))
      : null;
    const hint = active?.candidate ?? unavailable?.candidate ?? guide.fallback;
    const next: Resolution = {
      pathname,
      candidateId: (active ?? unavailable)?.candidate.id ?? null,
      hint: { title: hint.title, body: hint.body },
      ring,
      point: placement ? { x: Math.round(placement.point.x), y: Math.round(placement.point.y) } : null,
      obstacleKey: makeObstacleKey(obstacles.all),
      canScroll: !!placement && !active && !!pending,
      placed: !!placement,
      viewport: viewportSize,
    };
    setResolution((previous) => {
      // 氣泡收起時，純障礙物座標變化唔需要令 React 每幀重繪；真正位置／ring 改變仍即時更新。
      const comparable = openRef.current ? next : { ...next, obstacleKey: previous.obstacleKey };
      return sameResolution(previous, comparable) ? previous : next;
    });
  }, [dismissed, isAdmin, pathname]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current || scheduledRafRef.current || document.hidden) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = 0;
      scheduledRafRef.current = requestAnimationFrame(() => {
        scheduledRafRef.current = 0;
        refresh();
      });
    }, 120);
  }, [refresh]);

  const settleScroll = useCallback(() => {
    if (scrollSettleTimerRef.current) window.clearTimeout(scrollSettleTimerRef.current);
    scrollSettleTimerRef.current = 0;
    if (!scrollingRef.current) return;
    scrollingRef.current = false;
    scrollTargetRef.current = null;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = 0;
    // 停滾前每幀已經更新；呢下只係最後全量复核，唔係先消失再喺新位置出現。
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (dismissed || isAdmin) return;
    if (!pageVisible) {
      setDenied(false);
      return;
    }
    refresh();
    const observer = new MutationObserver((mutations) => {
      // scroll rAF 已經逐幀量度；呢段時間唔再額外排 120ms observer refresh。
      if (scrollingRef.current) return;
      if (mutations.some((mutation) => !(mutation.target instanceof Element && mutation.target.closest('[data-fairy-guide-root]')))) {
        scheduleRefresh();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-status', 'data-selected', 'data-active', 'aria-expanded', 'aria-hidden', 'disabled'],
    });
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    resizeObserver.observe(document.body);
    const isDocumentScrollTarget = (target: EventTarget | null) => (
      target === document || target === window || target === document.scrollingElement
    );
    const isDocumentScroll = (event: Event) => isDocumentScrollTarget(event.target);
    const isGuideScroll = (event: Event) => (
      event.target instanceof Element && !!event.target.closest('[data-fairy-guide-root]')
    );
    const guideIntersectsScroller = (event: Event): boolean => {
      if (!(event.target instanceof HTMLElement)) return true;
      const scrollerRect = intersectRect(toRect(event.target.getBoundingClientRect()), VIEWPORT_RECT());
      if (!scrollerRect) return false;
      const ring = document.querySelector<HTMLElement>('[data-fairy-guide-root] [data-fairy-target-ring]');
      return [fairyRef.current, ring, bubbleRef.current].some((element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        return !!intersectRect(toRect(element.getBoundingClientRect()), scrollerRect);
      });
    };
    const trackScrollFrame = () => {
      scrollRafRef.current = 0;
      if (!scrollingRef.current || document.hidden) return;
      // 每個瀏覽器繪圖幀都更新精靈、真目標 ring 同安全位；scroll 期間唔設 placed=false。
      refresh();
      if (scrollingRef.current) scrollRafRef.current = requestAnimationFrame(trackScrollFrame);
    };
    const beginScrollSettle = (event: Event) => {
      scrollingRef.current = true;
      scrollTargetRef.current = event.target;
      // 氣泡內容會隨流程改變，滚动時先收起；精靈本體及動作一直保持可見。
      if (openRef.current) setOpen(false);
      setDenied(false);
      if (!scrollRafRef.current) scrollRafRef.current = requestAnimationFrame(trackScrollFrame);
      if (scrollSettleTimerRef.current) window.clearTimeout(scrollSettleTimerRef.current);
      // scrollend 係主路徑；計時器涵蓋未支援 scrollend 嘅瀏覽器及連續滾動。
      scrollSettleTimerRef.current = window.setTimeout(settleScroll, 180);
    };
    const onScroll = (event: Event) => {
      // 氣泡自己嘅內層閱讀滾動唔可以令氣泡卸載；其他相關滾動即時逐幀追位。
      if (isGuideScroll(event)) return;
      const documentScroll = isDocumentScroll(event);
      const sameChannel = scrollingRef.current && (
        scrollTargetRef.current === event.target ||
        (documentScroll && isDocumentScrollTarget(scrollTargetRef.current))
      );
      // 無關 carousel 保持精靈原樣；文件滾動或相交內層滾動都唔再主動 hide。
      if (documentScroll || sameChannel || guideIntersectsScroller(event)) beginScrollSettle(event);
    };
    const onScrollEnd = (event: Event) => {
      if (isGuideScroll(event) || !scrollingRef.current) return;
      if (
        scrollTargetRef.current === event.target ||
        (isDocumentScroll(event) && isDocumentScrollTarget(scrollTargetRef.current))
      ) settleScroll();
    };
    const isEntranceMotion = (event: Event) => {
      if (!(event.target instanceof Element)) return false;
      // start 事件都要即時排除離屏元素；唔可以只靠之後 refresh 嘅動畫掃描，否則可見精靈會閃一下。
      if (!intersectRect(toRect(event.target.getBoundingClientRect()), VIEWPORT_RECT())) return false;
      if (event.type === 'transitionrun') {
        return event.target.matches('main .reveal') && (event as TransitionEvent).propertyName === 'transform';
      }
      if (event.type === 'animationstart') return event.target.matches('main .lr-enter, main .hero-enter');
      return event.target.matches('main .reveal, main .lr-enter, main .hero-enter');
    };
    const onEntranceMotionStart = (event: Event) => {
      if (!isEntranceMotion(event)) return;
      if (openRef.current) setOpen(false);
      setDenied(false);
      // reveal 常常由 scroll 觸發；呢度只排更新，唔再制造另一條閃退路徑。
      scheduleRefresh();
    };
    const onEntranceMotionEnd = (event: Event) => {
      if (isEntranceMotion(event)) scheduleRefresh();
    };
    window.addEventListener('resize', scheduleRefresh);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('scrollend', onScrollEnd, true);
    document.addEventListener('transitionrun', onEntranceMotionStart, true);
    document.addEventListener('transitionend', onEntranceMotionEnd, true);
    document.addEventListener('transitioncancel', onEntranceMotionEnd, true);
    document.addEventListener('animationstart', onEntranceMotionStart, true);
    document.addEventListener('animationend', onEntranceMotionEnd, true);
    document.addEventListener('animationcancel', onEntranceMotionEnd, true);
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleRefresh);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('scrollend', onScrollEnd, true);
      document.removeEventListener('transitionrun', onEntranceMotionStart, true);
      document.removeEventListener('transitionend', onEntranceMotionEnd, true);
      document.removeEventListener('transitioncancel', onEntranceMotionEnd, true);
      document.removeEventListener('animationstart', onEntranceMotionStart, true);
      document.removeEventListener('animationend', onEntranceMotionEnd, true);
      document.removeEventListener('animationcancel', onEntranceMotionEnd, true);
      cancelScheduled();
    };
  }, [cancelScheduled, dismissed, isAdmin, pageVisible, pathname, refresh, scheduleRefresh, settleScroll]);

  useEffect(() => {
    if (pathname !== '/try-on' || dismissed || isAdmin || !pageVisible) return;
    const onGuideAction = (event: Event) => {
      const action = parseTryOnGuideAction(event instanceof CustomEvent ? event.detail : null);
      if (action === 'share') shareActedRef.current = true;
      if (action === 'purchase') purchaseActedRef.current = true;
      if (action) scheduleRefresh();
    };
    window.addEventListener(TRYON_GUIDE_EVENT, onGuideAction);
    return () => window.removeEventListener(TRYON_GUIDE_EVENT, onGuideAction);
  }, [dismissed, isAdmin, pageVisible, pathname, scheduleRefresh]);

  useEffect(() => cancelScheduled, [cancelScheduled]);

  useLayoutEffect(() => {
    if (!open || !resolution.placed || !resolution.point) {
      setBubblePos(null);
      return;
    }
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const fairyPoint = resolution.point;
    const size = { w: bubble.offsetWidth, h: bubble.offsetHeight };
    const point = computeBubbleLayout(
      fairyPoint,
      sizeRef.current,
      size,
      resolution.viewport,
      bubbleObstaclesRef.current,
    );
    if (!point) {
      // 原尺寸真係冇位時，先用同一套碰撞規則逐級試可內部滾動嘅矮版、緊湊版及微型版；
      // 唔放寬任何商品、文字或控制碰撞。每步都喺 paint 前完成，唔會閃出舊氣泡。
      if (bubbleMode !== 'micro') {
        setBubblePos(null);
        setBubbleMode(bubbleMode === 'full' ? 'short' : bubbleMode === 'short' ? 'compact' : 'micro');
        return;
      }
      // 最細安全版本都冇位先真正收埋，唔留 aria-expanded=true 嘅假開啟狀態。
      setBubblePos(null);
      setOpen(false);
      setDenied(true);
      if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
      deniedTimerRef.current = window.setTimeout(() => {
        deniedTimerRef.current = 0;
        setDenied(false);
      }, 1600);
      return;
    }
    setDenied(false);
    setBubblePos(point);
  }, [open, resolution, bubbleMode]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (fairyRef.current?.contains(target) || bubbleRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      fairyRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  if (dismissed || isAdmin) return null;

  const step = computeTryOnStep(signals);
  const routeFallback = getFairyRouteGuide(pathname, step).fallback;
  const hint = resolution.pathname === pathname ? resolution.hint : routeFallback;
  const showGuide = resolution.placed && resolution.pathname === pathname;
  // 原造型隻手向右；只有真實可見目標先轉向，冇 ring 時唔會假裝指位。
  const pointingDirection = showGuide && resolution.ring && resolution.point
    ? resolution.ring.left + resolution.ring.width / 2 < resolution.point.x + sizeRef.current.w / 2
      ? 'left'
      : 'right'
    : null;

  const dismissForSession = () => {
    try {
      window.sessionStorage.setItem(FAIRY_DISMISS_KEY, '1');
    } catch {
      // 私密模式寫唔入都照收；重新整理先再出現。
    }
    if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
    deniedTimerRef.current = 0;
    setOpen(false);
    setDenied(false);
    setDismissed(true);
  };

  const goToPendingTarget = () => {
    const target = pendingTargetRef.current?.element;
    if (!target?.isConnected) return;
    setOpen(false);
    cancelScheduled();
    const cleanup = () => {
      window.removeEventListener('scrollend', focusTarget);
      if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = 0;
      scrollEndCleanupRef.current = null;
    };
    const focusTarget = () => {
      cleanup();
      if (target.isConnected) target.focus({ preventScroll: true });
      scheduleRefresh();
    };
    scrollEndCleanupRef.current = cleanup;
    window.addEventListener('scrollend', focusTarget, { once: true });
    // scrollend 支援實際完成時間；舊瀏覽器有 fallback，唔再用固定 520ms 估長距離捲動。
    focusTimerRef.current = window.setTimeout(focusTarget, reducedMotion ? 60 : 1400);
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
  };

  return (
    <div
      className={`fairy-guide-root${pageVisible ? '' : ' is-paused'}`}
      data-fairy-guide-root=""
      data-route={pathname}
    >
      {showGuide && resolution.ring && (
        <div
          aria-hidden="true"
          className="fairy-guide-ring"
          data-fairy-target-ring={resolution.candidateId ?? ''}
          style={{
            width: resolution.ring.width,
            height: resolution.ring.height,
            transform: `translate3d(${resolution.ring.left}px, ${resolution.ring.top}px, 0)`,
          }}
        />
      )}

      <button
        ref={fairyRef}
        type="button"
        className="fairy-guide-button"
        data-pointing={pointingDirection ?? undefined}
        tabIndex={showGuide ? 0 : -1}
        aria-expanded={open}
        aria-controls="glo-guide-bubble"
        aria-label={`${hint.title}。撳 Glo Glo 睇導覽提示`}
        onClick={() => {
          if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
          deniedTimerRef.current = 0;
          setDenied(false);
          setFairyAction('wave');
          setActionReplay((value) => value + 1);
          if (!open) setBubbleMode('full');
          setOpen((value) => !value);
        }}
        style={{
          visibility: showGuide ? 'visible' : 'hidden',
          pointerEvents: showGuide ? 'auto' : 'none',
        }}
      >
        <span className="fairy-guide-float" aria-hidden="true">
          <FairyActionAnimation
            action={fairyAction}
            animate={pageVisible && !reducedMotion}
            replay={actionReplay}
            onHoldComplete={completeFairyAction}
          />
        </span>
      </button>

      {showGuide && denied && resolution.point && (
        <span
          className="fairy-guide-denied"
          role="status"
          aria-label="呢度太密，安全提示暫時收起"
          style={{
            transform: `translate3d(${resolution.point.x}px, ${resolution.point.y}px, 0)`,
          }}
        >
          提示收起
        </span>
      )}

      {showGuide && open && (
        <div
          ref={bubbleRef}
          id="glo-guide-bubble"
          role="group"
          aria-label="Glo Glo 導覽提示"
          className={`fairy-guide-bubble${bubbleMode === 'full' ? '' : ` is-${bubbleMode}`}`}
          data-bubble-layout={bubbleMode}
          style={{
            visibility: bubblePos ? 'visible' : 'hidden',
            transform: `translate3d(${bubblePos?.x ?? 12}px, ${bubblePos?.y ?? 12}px, 0)`,
          }}
        >
          <div className="fairy-guide-bubble-heading">
            <strong>{hint.title}</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="收埋導覽提示">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <p>{hint.body}</p>
          <div className="fairy-guide-bubble-actions">
            {resolution.canScroll && (
              <button type="button" className="fairy-guide-go" onClick={goToPendingTarget}>
                帶我去真按鈕位置
              </button>
            )}
            <button type="button" className="fairy-guide-dismiss" onClick={dismissForSession}>
              今次唔使
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
