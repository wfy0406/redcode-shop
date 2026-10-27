import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation } from 'react-router';
import { X } from 'lucide-react';
import { usePageVisible } from '@/hooks/usePageVisible';
import FairyActionAnimation from '@/components/FairyActionAnimation';
import { isFairyIdleAction, nextFairyAction, type FairyAction } from '@/components/fairyActions';
import {
  EMPTY_TRYON_SIGNALS,
  FAIRY_DISMISS_KEY,
  FAIRY_DRAG_RETURN_MS,
  FAIRY_FLIGHT_STALL_WINDOW_FRAMES,
  TRYON_GUIDE_EVENT,
  advanceFairyFlight,
  chooseFairyPlacement,
  clampFairyPosition,
  computeBubbleLayout,
  computeTryOnStep,
  expandRect,
  fairyEscapeTarget,
  fairyPointSafe,
  getFairyRouteGuide,
  intersectRect,
  parseTryOnGuideAction,
  shouldStartFairyDrag,
  shouldStopStalledFlight,
  visibleActionRect,
  type FairyFlightStallWindow,
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
  blocked: boolean;
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
    a.blocked === b.blocked &&
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
  // Chromium／新 Safari 用原生一次性檢查，避免每個可見元素都逐層 getComputedStyle。
  if (typeof element.checkVisibility === 'function') {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  } else {
    let current: HTMLElement | null = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      current = current.parentElement;
    }
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
    // 長頁大部分文字都離屏；先用一個外框排除，唔好為每段文字建 Range 同逐層讀 style。
    const elementRect = toRect(element.getBoundingClientRect());
    if (!intersectRect(elementRect, viewport)) continue;
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
      const visible = intersectRect(toRect(element.getBoundingClientRect()), viewport);
      // 離屏商品唔需要逐層 getComputedStyle；只有真入 viewport 先檢查完整可見性。
      if (!visible) continue;
      if (!isRendered(element, true)) continue;
      target.push(expandRect(visible, element.tagName === 'HEADER' ? 8 : 5));
      if (target === all) seen.add(element);
    }
  };
  // 導覽列及浮鈕只量一次，同時放入 critical／all；舊版每次 refresh 都重複查詢及讀 rect。
  for (const element of collectElements(NAV_OBSTACLE_SELECTORS)) {
    const visible = intersectRect(toRect(element.getBoundingClientRect()), viewport);
    if (!visible || !isRendered(element, true)) continue;
    const rect = expandRect(visible, element.tagName === 'HEADER' ? 8 : 5);
    critical.push(rect);
    all.push(rect);
    seen.add(element);
  }
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
  const [isScrolling, setIsScrolling] = useState(false);
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
    blocked: false,
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
  const lastScrollRefreshRef = useRef(0);
  // positionRef 係最新安全目標；renderedPositionRef 係用家真正見到嘅連續位置。
  const renderedPositionRef = useRef<FairyPoint | null>(null);
  const flightTargetRef = useRef<FairyPoint | null>(null);
  const flightObstaclesRef = useRef<readonly FairyRect[]>([]);
  const flightViewportRef = useRef<FairySize>({ w: window.innerWidth, h: window.innerHeight });
  const flightRafRef = useRef(0);
  const flightLastTimeRef = useRef(0);
  const flightGeometryKeyRef = useRef('');
  const flightStallKeyRef = useRef<string | null>(null);
  const pointingRingRef = useRef<FairyRect | null>(null);
  // scroll 中流動幾何唔會即時 retarget：記低現有飛行嘅模式及候選，幾何唔變就只更新障礙物。
  const lastFlightModeRef = useRef<'target' | 'rest' | null>(null);
  const lastFlightCandidateRef = useRef<string | null>(null);
  // 拖曳放開 5 秒後要強制由肉眼位置重新揀安全休息位，唔畀 currentSafe 留喺drop點。
  const forceReplaceRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const dragPointerRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    grabDX: number;
    grabDY: number;
    active: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const dragReturnTimerRef = useRef(0);
  // 放開後 5000ms freeze window：普通 refresh 保持肉眼 drop 位置，timer 到先強制重揀安全休息位。
  const dragReturnPendingRef = useRef(false);

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
  // point／scared 由指引／拖曳狀態即時控制，hold 到時唔會當閒置動作輪轉。
  const completeFairyAction = useCallback((completed: FairyAction) => {
    if (!isFairyIdleAction(completed)) return;
    setFairyAction((current) => current === completed ? nextFairyAction(current) : current);
  }, []);

  useEffect(() => {
    shareActedRef.current = false;
    purchaseActedRef.current = false;
    prevCompletedRef.current = false;
    pendingTargetRef.current = null;
    signalsRef.current = EMPTY_TRYON_SIGNALS;
    positionRef.current = null;
    // 換頁只作廢舊目標；保留肉眼所見位置，新頁有安全位時繼續飛，唔再重新瞬移出場。
    flightTargetRef.current = null;
    if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);
    flightRafRef.current = 0;
    flightLastTimeRef.current = 0;
    flightGeometryKeyRef.current = '';
    flightStallKeyRef.current = null;
    lastFlightModeRef.current = null;
    lastFlightCandidateRef.current = null;
    forceReplaceRef.current = false;
    dragPointerRef.current = null;
    suppressClickRef.current = false;
    draggingRef.current = false;
    dragReturnPendingRef.current = false;
    setDragging(false);
    if (dragReturnTimerRef.current) window.clearTimeout(dragReturnTimerRef.current);
    dragReturnTimerRef.current = 0;
    pointingRingRef.current = null;
    fairyRef.current?.removeAttribute('data-pointing');
    if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current);
    if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
    revealRafRef.current = 0;
    deniedTimerRef.current = 0;
    // transform／transition 完全由呢個元件嘅 DOM ref 擁有，React 唔再重寫同一組屬性。
    if (fairyRef.current && !positionedRef.current) fairyRef.current.style.transition = 'none';
    setSignals(EMPTY_TRYON_SIGNALS);
    setOpen(false);
    setIsScrolling(false);
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
    if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);
    if (motionRetryTimerRef.current) window.clearTimeout(motionRetryTimerRef.current);
    if (deniedTimerRef.current) window.clearTimeout(deniedTimerRef.current);
    if (dragReturnTimerRef.current) window.clearTimeout(dragReturnTimerRef.current);
    dragReturnTimerRef.current = 0;
    dragReturnPendingRef.current = false;
    refreshTimerRef.current = 0;
    scheduledRafRef.current = 0;
    revealRafRef.current = 0;
    focusTimerRef.current = 0;
    scrollSettleTimerRef.current = 0;
    scrollRafRef.current = 0;
    flightRafRef.current = 0;
    flightLastTimeRef.current = 0;
    flightTargetRef.current = null;
    flightGeometryKeyRef.current = '';
    flightStallKeyRef.current = null;
    lastScrollRefreshRef.current = 0;
    motionRetryTimerRef.current = 0;
    deniedTimerRef.current = 0;
    scrollingRef.current = false;
    scrollTargetRef.current = null;
    setIsScrolling(false);
  }, []);

  const syncPointing = useCallback((point: FairyPoint | null) => {
    const fairy = fairyRef.current;
    if (!fairy) return;
    const ring = pointingRingRef.current;
    if (!point || !ring) {
      fairy.removeAttribute('data-pointing');
      return;
    }
    // 指向要以用家而家見到嘅位置計，唔可以用幾百毫秒後嘅飛行終點。
    const direction = ring.left + ring.width / 2 < point.x + sizeRef.current.w / 2 ? 'left' : 'right';
    fairy.setAttribute('data-pointing', direction);
  }, []);

  // reduced-motion 中途切換：即停飛行 rAF 並 snap 到最新安全目標；唔等下一帧先停。
  useEffect(() => {
    if (!reducedMotion) return;
    if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);
    flightRafRef.current = 0;
    flightLastTimeRef.current = 0;
    flightTargetRef.current = null;
    flightStallKeyRef.current = null;
    const target = positionRef.current;
    if (target && positionedRef.current && !draggingRef.current) {
      renderedPositionRef.current = { ...target };
      if (fairyRef.current) {
        fairyRef.current.style.transform = `translate3d(${target.x.toFixed(2)}px, ${target.y.toFixed(2)}px, 0)`;
      }
      syncPointing(target);
    }
  }, [reducedMotion, syncPointing]);

  /** DOM transform 專用飛行 loop；layout 重讀同畫面更新分開，手機滾動唔會再被離散座標拉住跳。 */
  const startFlight = useCallback((
    target: FairyPoint,
    obstacles: readonly FairyRect[],
    viewport: FairySize,
    geometryKey: string,
  ) => {
    const fairy = fairyRef.current;
    if (!fairy) return;
    const size = sizeRef.current;
    const flightKey = [
      geometryKey,
      `${target.x.toFixed(2)},${target.y.toFixed(2)}`,
      `${viewport.w},${viewport.h}`,
      `${size.w.toFixed(2)},${size.h.toFixed(2)}`,
    ].join('|');
    flightTargetRef.current = { ...target };
    flightObstaclesRef.current = obstacles;
    flightViewportRef.current = viewport;
    flightGeometryKeyRef.current = flightKey;
    const write = (point: FairyPoint) => {
      if (!fairyRef.current) return;
      fairyRef.current.style.transform = `translate3d(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px, 0)`;
      syncPointing(point);
    };
    if (!renderedPositionRef.current || reducedMotion || !positionedRef.current) {
      if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);
      flightRafRef.current = 0;
      flightLastTimeRef.current = 0;
      flightStallKeyRef.current = null;
      renderedPositionRef.current = { ...target };
      positionedRef.current = true;
      flightTargetRef.current = null;
      write(target);
      return;
    }
    // 同一組幾何真係完全無路行，就停低等新目標／新障礙物；唔好用 60/120Hz 永久空轉。
    // 但精靈而家仲撞緊內容（unsafe）就唔准用呢個理由停——一定要繼續脫困。
    if (flightStallKeyRef.current === flightKey) {
      const current = renderedPositionRef.current;
      const unsafe = !!current && !fairyPointSafe(current, size, flightObstaclesRef.current, viewport);
      if (!unsafe) {
        flightTargetRef.current = null;
        return;
      }
    }
    flightStallKeyRef.current = null;
    if (flightRafRef.current || document.hidden) return;
    flightLastTimeRef.current = 0;
    const flightStart = renderedPositionRef.current;
    let stallWindow: FairyFlightStallWindow = {
      frames: 0,
      start: flightStart ? { ...flightStart } : { ...target },
      startTargetDistance: flightStart ? Math.hypot(target.x - flightStart.x, target.y - flightStart.y) : 0,
    };
    // 脫困救援：一開始位置已碰撞（例如拖放上商品）即入 rescue 模式——
    // 直線連續飛去已驗證 freeAt 嘅安全位，期間唔被一般障礙物截停；
    // 呢段係用家拖入障礙物後嘅短暫救援，唔係正常飛行穿牆。free 咗即刻恢復正常碰撞飛行。
    let escapeMode = !!flightStart && !fairyPointSafe(flightStart, sizeRef.current, flightObstaclesRef.current, flightViewportRef.current);
    const escapeTried: FairyPoint[] = [];
    let lastGeometryKey = flightKey;
    const frame = (now: number) => {
      flightRafRef.current = 0;
      const destination = flightTargetRef.current;
      const current = renderedPositionRef.current;
      if (!destination || !current || document.hidden) {
        flightLastTimeRef.current = 0;
        return;
      }
      if (lastGeometryKey !== flightGeometryKeyRef.current) {
        lastGeometryKey = flightGeometryKeyRef.current;
        stallWindow = {
          frames: 0,
          start: { ...current },
          startTargetDistance: Math.hypot(destination.x - current.x, destination.y - current.y),
        };
      }
      const deltaMs = flightLastTimeRef.current ? now - flightLastTimeRef.current : 16.67;
      flightLastTimeRef.current = now;
      const next = advanceFairyFlight({
        current,
        target: destination,
        viewport: flightViewportRef.current,
        fairy: sizeRef.current,
        obstacles: escapeMode ? [] : flightObstaclesRef.current,
        deltaMs,
        maxSpeed: window.innerWidth <= 480 ? 960 : 1200,
      });
      stallWindow.frames += 1;
      renderedPositionRef.current = next;
      write(next);
      const stillUnsafe = !fairyPointSafe(next, sizeRef.current, flightObstaclesRef.current, flightViewportRef.current);
      if (escapeMode && !stillUnsafe) {
        // 脫困成功：恢復正常碰撞飛行，stall 偵測重新開窗。
        escapeMode = false;
        stallWindow = {
          frames: 0,
          start: { ...next },
          startTargetDistance: Math.hypot(destination.x - next.x, destination.y - next.y),
        };
      }
      const remaining = Math.hypot(destination.x - next.x, destination.y - next.y);
      if (remaining > 0.5) {
        // 窗口制 stall 偵測：「安全但不可達」目標會令每帧 ±幾 px 來回震盪，
        // 單帧郁動永遠大過門檻；N 帧窗口內淨位移同接近目標都無實質進展先停，
        // 等幾何改變先再試。rescue 模式直線飛行唔會 stall。
        if (!escapeMode && shouldStopStalledFlight(stallWindow, next, remaining)) {
          if (!stillUnsafe) {
            // 已經喺安全位：真 stall 先停，唔再震盪。
            flightStallKeyRef.current = flightGeometryKeyRef.current;
            flightTargetRef.current = null;
            flightLastTimeRef.current = 0;
            return;
          }
          // 仍然碰撞（例如拖曳放上商品）：唔准停喺碰撞位。
          // 入 rescue 模式直線飛去已驗證 freeAt 安全位；
          // 呢段係用家拖入障礙物後嘅短暫救援，唔係正常穿牆。
          escapeMode = true;
          if (!fairyPointSafe(destination, sizeRef.current, flightObstaclesRef.current, flightViewportRef.current)) {
            escapeTried.push({ ...destination });
            const escape = escapeTried.length <= 8
              ? fairyEscapeTarget(next, escapeTried, flightViewportRef.current, sizeRef.current, flightObstaclesRef.current)
              : null;
            if (!escape) {
              // 極密頁面所有候選都唔 free：停低等幾何改變，唔好用 60Hz 永久空轉。
              flightTargetRef.current = null;
              flightLastTimeRef.current = 0;
              return;
            }
            flightTargetRef.current = escape;
          }
          const resumeTarget = flightTargetRef.current ?? destination;
          stallWindow = {
            frames: 0,
            start: { ...next },
            startTargetDistance: Math.hypot(resumeTarget.x - next.x, resumeTarget.y - next.y),
          };
          flightRafRef.current = requestAnimationFrame(frame);
          return;
        }
        if (stallWindow.frames >= FAIRY_FLIGHT_STALL_WINDOW_FRAMES) {
          // 窗口有實質進展：以而家位置開新窗口繼續觀察，唔會誤停長距離飛行。
          stallWindow = { frames: 0, start: { ...next }, startTargetDistance: remaining };
        }
        flightRafRef.current = requestAnimationFrame(frame);
      } else {
        renderedPositionRef.current = { ...destination };
        flightTargetRef.current = null;
        flightStallKeyRef.current = null;
        flightLastTimeRef.current = 0;
        write(destination);
      }
    };
    flightRafRef.current = requestAnimationFrame(frame);
  }, [reducedMotion, syncPointing]);

  /** 唯一 layout 讀取入口；scroll 中定時重量真位置，飛行 loop 則每個繪圖幀更新。 */
  const refresh = useCallback((): void => {
    if (document.hidden || dismissed || isAdmin) return;
    // scroll 中高頻掃 document.getAnimations() 會同飛行爭主線程；
    // 停滾後嘅全量 refresh 仍會處理進場動畫及自癒重試。
    if (!scrollingRef.current && hasUnsettledEntranceMotion()) {
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
    const headerBottom = document.querySelector<HTMLElement>('header.sticky.top-0')?.getBoundingClientRect().bottom ?? 0;
    const contentTop = Math.max(0, Math.min(viewportSize.h, headerBottom + 6));
    const contentViewport: FairyRect = {
      left: 0,
      top: contentTop,
      width: viewportSize.w,
      height: Math.max(0, viewportSize.h - contentTop),
    };
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
          const visibleRect = visibleActionRect(rect, viewportSize, contentViewport);
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
    const obstacleKey = makeObstacleKey(obstacles.all);
    // 使用者撳開都唔係豁免：氣泡同精靈一樣避開商品、TryOn 媒體、真控制、公告及實際文字。
    bubbleObstaclesRef.current = obstacles.all;
    let placement: ReturnType<typeof chooseFairyPlacement> = null;
    if (!blocked && !draggingRef.current) {
      // 原尺寸真係完全無安全位時，先逐級等比例縮細再重掃；所有商品、文字及控制碰撞照舊。
      // 44px 係最細互動寬度，唔會為咗硬塞而變成難以點擊嘅裝飾點。
      // 錨點用肉眼真正見到嘅連續位置（唔係幾百毫秒後嘅飛行終點），逃脫時唔會左右反覆。
      const anchor = forceReplaceRef.current
        ? null
        : renderedPositionRef.current ?? positionRef.current;
      forceReplaceRef.current = false;
      const widths = [...new Set([naturalSize.w, 66, 56, 48, 44].filter((width) => width <= naturalSize.w))];
      for (const width of widths) {
        const size = { w: width, h: width * 768 / 458 };
        const candidate = chooseFairyPlacement({
          viewport: viewportSize,
          fairy: size,
          target: active?.visibleRect ?? null,
          obstacles: obstacles.all,
          current: anchor,
          // 冇可見目標要指時唔再長期停喺內容中間；返回右下安全待命位。
          // 有 off-screen 指引時一樣先待命，使用者撳「帶我去」先再出發。
          // 拖曳放開後 5 秒 freeze window 內例外：保持肉眼 drop 位置，唔提前返回。
          preferRest: !active && !dragReturnPendingRef.current,
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
      const flightObstacles = active?.visibleRect
        ? [...obstacles.all, expandRect(active.visibleRect, 5)]
        : obstacles.all;
      const flightMode: 'target' | 'rest' = active?.visibleRect ? 'target' : 'rest';
      const flightCandidate = active?.candidate.id ?? null;
      const existingTarget = flightTargetRef.current;
      // scroll 中流動幾何唔即時 retarget：模式同候選不變、現有飛行目標喺新幾何下仍安全，
      // 就只更新障礙物／viewport 資料，等飛行 loop 繼續去原目標，唔會因重排左右震盪。
      const keepFlight =
        !!existingTarget &&
        flightMode === lastFlightModeRef.current &&
        flightCandidate === lastFlightCandidateRef.current &&
        fairyPointSafe(existingTarget, sizeRef.current, flightObstacles, viewportSize);
      lastFlightModeRef.current = flightMode;
      lastFlightCandidateRef.current = flightCandidate;
      const needsReveal = !positionedRef.current;
      if (keepFlight && existingTarget) {
        positionRef.current = { ...existingTarget };
        flightObstaclesRef.current = flightObstacles;
        flightViewportRef.current = viewportSize;
      } else {
        positionRef.current = placement.point;
        const activeKey = active?.visibleRect ? makeObstacleKey([expandRect(active.visibleRect, 5)]) : '';
        startFlight(placement.point, flightObstacles, viewportSize, `${obstacleKey}|${activeKey}`);
      }
      if (needsReveal && !revealRafRef.current) {
        revealRafRef.current = requestAnimationFrame(() => {
          revealRafRef.current = 0;
          if (fairyRef.current) fairyRef.current.style.transition = '';
        });
      }
    }

    // 失去安全位會收埋氣泡，之後恢復時唔可以無使用者操作又自動彈出。
    if ((blocked || !placement) && openRef.current) setOpen(false);
    const ring = placement && active
      ? roundedRect(intersectRect(expandRect(active.visibleRect, 5), contentViewport))
      : null;
    pointingRingRef.current = scrollingRef.current ? null : ring;
    syncPointing(renderedPositionRef.current);
    const hint = active?.candidate ?? unavailable?.candidate ?? guide.fallback;
    const next: Resolution = {
      pathname,
      candidateId: (active ?? unavailable)?.candidate.id ?? null,
      hint: { title: hint.title, body: hint.body },
      ring,
      point: placement ? { x: Math.round(placement.point.x), y: Math.round(placement.point.y) } : null,
      obstacleKey,
      canScroll: !!placement && !active && !!pending,
      placed: !!placement,
      blocked,
      viewport: viewportSize,
    };
    setResolution((previous) => {
      // 氣泡收起時，純障礙物座標變化唔需要令 React 每幀重繪；真正位置／ring 改變仍即時更新。
      const comparable = openRef.current ? next : { ...next, obstacleKey: previous.obstacleKey };
      return sameResolution(previous, comparable) ? previous : next;
    });
  }, [dismissed, isAdmin, pathname, startFlight, syncPointing]);

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
    setIsScrolling(false);
    scrollTargetRef.current = null;
    lastScrollRefreshRef.current = 0;
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
      // 幾何重讀限制約 12.5Hz；實際飛行 transform 由獨立 loop 按每個繪圖幀更新。
      // 若慢機每幀已超過 40ms，舊 40ms 門檻會令每幀都做全量重讀，形成越窒越讀嘅反饋。
      // 80ms 留空畫面幀畀合成器；停滾仍會即時做一次全量复核。
      const now = performance.now();
      if (!lastScrollRefreshRef.current || now - lastScrollRefreshRef.current >= 80) {
        lastScrollRefreshRef.current = now;
        refresh();
      }
      if (scrollingRef.current) scrollRafRef.current = requestAnimationFrame(trackScrollFrame);
    };
    const beginScrollSettle = (event: Event) => {
      const beginsScrollChannel = !scrollingRef.current;
      if (beginsScrollChannel) lastScrollRefreshRef.current = 0;
      scrollingRef.current = true;
      pointingRingRef.current = null;
      fairyRef.current?.removeAttribute('data-pointing');
      setIsScrolling(true);
      scrollTargetRef.current = event.target;
      // 氣泡內容會隨流程改變，滚动時先收起；精靈本體及動作一直保持可見。
      // ring 只喺停滾後按新幾何顯示，唔會以舊座標圈住滾動中嘅其他商品。
      if (openRef.current) setOpen(false);
      setDenied(false);
      // 每段滑動嘅第一次碰撞檢查即時做，唔等下一個 rAF／80ms 窗口先起步。
      if (beginsScrollChannel) {
        lastScrollRefreshRef.current = performance.now();
        refresh();
      }
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
    const onResize = () => {
      if (document.hidden) return;
      // viewport 縮細時，舊座標可能即刻超出畫面。先喺同一個 resize 更新內夾返入可見範圍，
      // 再即時重讀幾何；唔等 120ms timer 令精靈似消失，亦唔由舊屏外座標 clamp 成一次長跳。
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      if (scheduledRafRef.current) cancelAnimationFrame(scheduledRafRef.current);
      refreshTimerRef.current = 0;
      scheduledRafRef.current = 0;
      const current = renderedPositionRef.current;
      if (current && positionedRef.current) {
        const viewport = { w: window.innerWidth, h: window.innerHeight };
        const visible = clampFairyPosition(current, viewport, baseFairySize(viewport));
        if (!samePoint(current, visible)) {
          renderedPositionRef.current = { ...visible };
          positionRef.current = { ...visible };
          if (fairyRef.current) {
            fairyRef.current.style.transform = `translate3d(${visible.x.toFixed(2)}px, ${visible.y.toFixed(2)}px, 0)`;
          }
          syncPointing(visible);
        }
      }
      refresh();
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
    window.addEventListener('resize', onResize);
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
      window.removeEventListener('resize', onResize);
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
  }, [cancelScheduled, dismissed, isAdmin, pageVisible, pathname, refresh, scheduleRefresh, settleScroll, syncPointing]);

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
  const sameRoute = resolution.pathname === pathname;
  const hint = sameRoute ? resolution.hint : routeFallback;
  // 換頁或滾動中某一幾何幀暫時搵唔到新安全位，都保留肉眼所見位置並等下一個目標；
  // 唔再 hidden→visible 拆掉合成層。真正 modal／手機選單等阻塞層仍然會暫停精靈。
  const hasRenderedPosition = !!(positionedRef.current && renderedPositionRef.current);
  const showGuide = !resolution.blocked && (resolution.placed || hasRenderedPosition);
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

  const clearDragReturnTimer = () => {
    if (dragReturnTimerRef.current) window.clearTimeout(dragReturnTimerRef.current);
    dragReturnTimerRef.current = 0;
  };

  /** 滑鼠／觸控拖曳：pointer capture 由按下開始，超過 6px 先進入拖曳，唔會擋正常 click。 */
  const onFairyPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const fairy = fairyRef.current;
    const position = renderedPositionRef.current;
    if (!fairy || !position || !positionedRef.current) return;
    // 新一次按下即清上一輪殘留狀態：pointercancel 後唔會有 click 被誤吞，
    // 亦重新計 5 秒 freeze window。
    suppressClickRef.current = false;
    dragReturnPendingRef.current = false;
    clearDragReturnTimer();
    dragPointerRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabDX: event.clientX - position.x,
      grabDY: event.clientY - position.y,
      active: false,
    };
    try {
      fairy.setPointerCapture(event.pointerId);
    } catch {
      // 舊瀏覽器冇 capture 都照樣用 move/up 事件拖。
    }
  };

  const onFairyPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragPointerRef.current;
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.active) {
      if (!shouldStartFairyDrag(
        { x: drag.startX, y: drag.startY },
        { x: event.clientX, y: event.clientY },
      )) return;
      drag.active = true;
      draggingRef.current = true;
      setDragging(true);
      // 拖曳進入即停現有飛行：以肉眼位置接手，精靈唔會閃走或被 flight loop 拉走。
      if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);
      flightRafRef.current = 0;
      flightLastTimeRef.current = 0;
      flightTargetRef.current = null;
      if (openRef.current) setOpen(false);
    }
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const point = clampFairyPosition(
      { x: event.clientX - drag.grabDX, y: event.clientY - drag.grabDY },
      viewport,
      sizeRef.current,
    );
    renderedPositionRef.current = point;
    positionRef.current = point;
    if (fairyRef.current) {
      fairyRef.current.style.transform = `translate3d(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px, 0)`;
    }
  };

  const endFairyDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const drag = dragPointerRef.current;
    if (!drag || event.pointerId !== drag.id) return;
    dragPointerRef.current = null;
    try {
      fairyRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // capture 可能已自動釋放。
    }
    if (!drag.active) return;
    // 只有真放開先壓制跟住嘅 click；pointercancel 唔會有 click，
    // 殘留 suppress 會吞咗下一次真 tap。
    if (!cancelled) suppressClickRef.current = true;
    draggingRef.current = false;
    setDragging(false);
    // 放開（包括 cancel 掉喺障礙物上）如果撞內容，即時由肉眼位置連續飛去最近安全位；
    // 唔瞬移、唔提前返回 rest。
    const drop = renderedPositionRef.current;
    if (drop) {
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      // 拖放安全檢查要連真指引目標（ring）都當障礙物，唔准脫困後仍冚住目標。
      const dropObstacles = pointingRingRef.current
        ? [...bubbleObstaclesRef.current, pointingRingRef.current]
        : bubbleObstaclesRef.current;
      if (!fairyPointSafe(drop, sizeRef.current, dropObstacles, viewport)) {
        const safe = chooseFairyPlacement({
          viewport,
          fairy: sizeRef.current,
          obstacles: dropObstacles,
          current: drop,
        });
        if (safe) {
          positionRef.current = safe.point;
          startFlight(
            safe.point,
            dropObstacles,
            viewport,
            `drag-drop|${makeObstacleKey(dropObstacles)}`,
          );
        }
      }
    }
    // 放開約 5 秒 freeze window：期間普通 refresh 保持肉眼 drop 位置；
    // timer 到先由肉眼位置連續返回安全休息位（有真指引目標就去目標旁，否則右下）。
    dragReturnPendingRef.current = true;
    clearDragReturnTimer();
    dragReturnTimerRef.current = window.setTimeout(() => {
      dragReturnTimerRef.current = 0;
      dragReturnPendingRef.current = false;
      forceReplaceRef.current = true;
      refresh();
    }, FAIRY_DRAG_RETURN_MS);
  };

  // 平時閒置循環（shy 喺 ORDER 入面）；有真可見指引目標就 point；拖曳時 scared。
  const displayedAction: FairyAction = dragging
    ? 'scared'
    : showGuide && sameRoute && !isScrolling && resolution.ring
      ? 'point'
      : fairyAction;

  return (
    <div
      className={`fairy-guide-root${pageVisible ? '' : ' is-paused'}`}
      data-fairy-guide-root=""
      data-route={pathname}
    >
      {showGuide && sameRoute && !isScrolling && resolution.ring && (
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
        tabIndex={showGuide ? 0 : -1}
        aria-expanded={open}
        aria-controls="glo-guide-bubble"
        aria-label={`${hint.title}。撳 Glo Glo 睇導覽提示`}
        data-dragging={dragging ? 'true' : undefined}
        onPointerDown={onFairyPointerDown}
        onPointerMove={onFairyPointerMove}
        onPointerUp={(event) => endFairyDrag(event, false)}
        onPointerCancel={(event) => endFairyDrag(event, true)}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          const visiblePoint = renderedPositionRef.current;
          if (visiblePoint) {
            // 使用者撳嘅係而家呢個位置：停低飛行並以實際位置開氣泡，唔會即刻又飛走留低舊氣泡。
            if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);
            flightRafRef.current = 0;
            flightLastTimeRef.current = 0;
            flightTargetRef.current = null;
            positionRef.current = { ...visiblePoint };
            setResolution((previous) => ({ ...previous, point: { ...visiblePoint } }));
          }
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
            action={displayedAction}
            animate={pageVisible && !reducedMotion}
            replay={actionReplay}
            onHoldComplete={completeFairyAction}
          />
        </span>
      </button>

      {showGuide && sameRoute && denied && resolution.point && (
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

      {showGuide && sameRoute && open && (
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
