/**
 * 全站 Glo Glo 導覽——純資料、流程及幾何邏輯。
 *
 * 呢個版本唔再有大型五步面板、首頁事件彈窗或離屏假指。DOM 查詢、可見性及
 * observer 全喺 GlobalFairyGuide.tsx；呢度嘅路由目錄只描述現有真控制，
 * 幾何函數保證精靈完整留喺 viewport，並避開 header、浮鈕、商品及真控制。
 */

export type FairyStepId = 'photo' | 'product' | 'generate' | 'share' | 'purchase' | 'cart';

export const FAIRY_STEP_ORDER: readonly FairyStepId[] = [
  'photo',
  'product',
  'generate',
  'share',
  'purchase',
  'cart',
];

export const FAIRY_TARGET_ATTR = 'data-fairy-target';

/** 每一步都指向真按鈕／連結，唔再指成塊 panel 或生成結果圖。 */
export const FAIRY_STEP_TARGET_SELECTORS: Record<FairyStepId, readonly string[]> = {
  photo: [
    `[${FAIRY_TARGET_ATTR}="photo"] button`,
    '.tryon-photo-panel .tryon-camera-controls button',
  ],
  product: [
    `[${FAIRY_TARGET_ATTR}="product"] .tryon-product-card`,
    '.tryon-product-panel .tryon-contact-sheet .tryon-product-card',
  ],
  generate: [
    `[${FAIRY_TARGET_ATTR}="generate"]`,
    '.tryon-submit-zone .tryon-generate-button',
    '.tryon-failed .tryon-primary-button',
  ],
  share: [
    `[${FAIRY_TARGET_ATTR}="share"] button`,
    `[${FAIRY_TARGET_ATTR}="share"] a[href]`,
    '.tryon-share-actions button',
    '.tryon-share-actions a[href]',
  ],
  purchase: [
    `[${FAIRY_TARGET_ATTR}="purchase"] .tryon-purchase-cart`,
    `[${FAIRY_TARGET_ATTR}="purchase"] .tryon-purchase-add-one`,
    `[${FAIRY_TARGET_ATTR}="purchase"] .tryon-purchase-buy`,
  ],
  cart: [
    `[${FAIRY_TARGET_ATTR}="purchase"] a.tryon-purchase-view-cart[href="/cart"]`,
  ],
};

export interface TryOnSignals {
  hasPhoto: boolean;
  selectionCount: number;
  jobPresent: boolean;
  jobActive: boolean;
  jobCompleted: boolean;
  shareActed: boolean;
  purchasePresent: boolean;
  purchaseActed: boolean;
}

export const EMPTY_TRYON_SIGNALS: TryOnSignals = {
  hasPhoto: false,
  selectionCount: 0,
  jobPresent: false,
  jobActive: false,
  jobCompleted: false,
  shareActed: false,
  purchasePresent: false,
  purchaseActed: false,
};

/** 流程只由真 DOM 訊號及明確成功事件推出，唔用容器 click 估進度。 */
export function computeTryOnStep(signals: TryOnSignals): FairyStepId {
  if (!signals.hasPhoto) return 'photo';
  if (signals.selectionCount < 1 && !signals.jobPresent) return 'product';
  if (!signals.jobPresent || signals.jobActive) return 'generate';
  // 批量 job 可以已有成功商品及購買區，但今次仍未完成；失敗／重試一定優先於購買。
  if (!signals.jobCompleted) return 'generate';
  // 加車成功之後指去真「查看購物車」連結，唔再循環推同一件購買控制。
  if (signals.purchaseActed) return 'cart';
  if (!signals.shareActed) return 'share';
  if (signals.purchasePresent) return 'purchase';
  return 'share';
}

export interface FairyStepCopy {
  title: string;
  body: string;
}

export const FAIRY_STEP_COPY: Record<FairyStepId, FairyStepCopy> = {
  photo: {
    title: '先準備一張全身相',
    body: '用前鏡、後鏡或相簿都得。頭到腳企直、光線平均；未確認生成前唔會用額度。',
  },
  product: {
    title: '揀想試嘅商品',
    body: '撳商品卡就揀到；想試兩件，要揀不同穿著部位。每件會分開生成。',
  },
  generate: {
    title: '相片同款齊咗，先確認生成',
    body: '檢查好就由你親自撳生成掣。我只係指路，唔會代你提交或用額度。',
  },
  share: {
    title: '效果完成，可以下載或分享',
    body: '下載 PNG 會帶 RedCode 水印；WhatsApp 分享唔會自動附加你嘅私人結果圖。',
  },
  purchase: {
    title: '鍾意先帶佢返屋企',
    body: '可以逐件加車或即買。AI 試穿只係視覺預覽，尺寸同數量由你親自核對。',
  },
  cart: {
    title: '已加車，下一步核對購物車',
    body: '呢度去購物車睇返商品、尺寸同數量。確認無誤後，結帳資料仍由你親自填寫。',
  },
};

export interface FairyGuideCandidate extends FairyStepCopy {
  id: string;
  selectors: readonly string[];
}

export interface FairyRouteGuide {
  candidates: readonly FairyGuideCandidate[];
  fallback: FairyStepCopy;
  /** 結帳／付款等敏感流程只留守角落，唔主動圈控制。 */
  quiet: boolean;
}

export interface FairyRouteContext {
  tryOnAccess?: boolean;
  walletPayment?: boolean;
}

const GENERIC_COPY: FairyStepCopy = {
  title: '我係 Glo Glo，全站導覽員',
  body: '我會指出而家真正撳到嘅位置。想知呢頁點用，隨時撳我；我唔會代你購買、付款或刪除嘢。',
};

const TRYON_ACCESS_GUIDE: FairyRouteGuide = {
  quiet: false,
  fallback: {
    title: '登入後開始 AI 試穿',
    body: '試穿需要會員權限。登入後我會按你嘅真實進度，逐步指出影相、揀款同分享位置。',
  },
  candidates: [
    {
      id: 'tryon-login',
      selectors: ['main .tryon-access-card a.tryon-primary-link'],
      title: '先登入會員',
      body: '呢粒掣去登入頁；完成後返嚟，就可以準備全身相同揀款。',
    },
  ],
};

const QUIET_PAYMENT_GUIDE: FairyRouteGuide = {
  quiet: true,
  candidates: [],
  fallback: {
    title: '結帳資料由你親自核對',
    body: '我會靜靜哋留守，唔會圈付款掣或代你操作。地址、金額同付款資料確認好先繼續。',
  },
};

/** route-aware 目錄：selector 全部對應現有 DOM，冇為導覽加新頁面屬性。 */
export function getFairyRouteGuide(
  pathname: string,
  tryOnStep: FairyStepId = 'photo',
  context: FairyRouteContext = {},
): FairyRouteGuide {
  if (pathname === '/try-on') {
    if (context.tryOnAccess) return TRYON_ACCESS_GUIDE;
    const copy = FAIRY_STEP_COPY[tryOnStep];
    return {
      quiet: false,
      fallback: copy,
      candidates: [{ id: `tryon-${tryOnStep}`, selectors: FAIRY_STEP_TARGET_SELECTORS[tryOnStep], ...copy }],
    };
  }

  if (pathname === '/') {
    return {
      quiet: false,
      fallback: GENERIC_COPY,
      candidates: [
        {
          id: 'home-tryon',
          selectors: ['main [data-fairy-target="home-cta"]'],
          title: '想即刻試新造型？',
          body: '呢度入 AI 試穿；之後我會按你嘅真實進度，逐步指出有用掣。',
        },
        {
          id: 'home-shop',
          selectors: ['main [data-home-cta="shop"]'],
          title: '先去睇心水款',
          body: '由商品開始揀都得；入到詳情頁，合資格商品可以直接去 AI 試穿。',
        },
      ],
    };
  }

  if (pathname === '/products') {
    return {
      quiet: false,
      fallback: {
        title: '搜尋、篩選，再撳商品卡',
        body: '可以打品名或貨號、揀類別，再入商品詳情睇尺寸同價錢。',
      },
      candidates: [
        {
          id: 'products-search',
          selectors: ['main input[aria-label="搜尋商品"]'],
          title: '有名或貨號？直接搜尋',
          body: '喺呢度輸入關鍵字，商品清單會即時收窄。',
        },
        {
          id: 'products-category',
          selectors: ['main [role="group"][aria-label="商品類別篩選"] button'],
          title: '用類別快速篩款',
          body: '撳一個類別，就睇到相關商品；再撳商品卡入詳情。',
        },
      ],
    };
  }

  if (/^\/products\/[^/]+/.test(pathname)) {
    return {
      quiet: false,
      fallback: {
        title: '先睇清楚尺寸同商品資料',
        body: '合資格商品可以先試穿；購買前記得核對尺寸、數量同價錢。',
      },
      candidates: [
        {
          id: 'product-tryon',
          selectors: ['main a[href^="/try-on?productId="]'],
          title: '想睇著上身效果？',
          body: '呢粒掣會帶呢件商品去 AI 試穿，準備好全身相就可以開始。',
        },
        {
          id: 'product-size',
          selectors: ['main [role="radiogroup"] button[role="radio"]'],
          title: '購買前先揀尺寸',
          body: 'AI 試穿只係視覺預覽；實際尺寸以尺寸表同實物為準。',
        },
      ],
    };
  }

  if (pathname === '/cart') {
    return {
      quiet: false,
      fallback: {
        title: '購物車入面先核對商品',
        body: '數量、尺寸同總計確認好，再去結帳；未開帳號都可以用訪客流程。',
      },
      candidates: [
        {
          id: 'cart-checkout',
          selectors: ['main a[href="/checkout"]', 'main a[href="/guest-checkout"]'],
          title: '核對好就可以去結帳',
          body: '下一步填取貨同付款資料。我只係指路，資料仍由你親自確認。',
        },
        {
          id: 'cart-empty',
          selectors: ['main a[href="/products"]'],
          title: '購物車仲係空？',
          body: '呢度返商品頁，揀好心水款再返嚟結帳。',
        },
      ],
    };
  }

  if (pathname === '/faq') {
    return {
      quiet: false,
      fallback: GENERIC_COPY,
      candidates: [
        {
          id: 'faq-question',
          selectors: ['main .faq-q[aria-expanded]'],
          title: '撳問題展開答案',
          body: '通知、試穿、權限、訂單同私隱問題，都可以喺呢度逐條睇。',
        },
        {
          id: 'faq-tab',
          selectors: ['main .faq-tab[role="tab"]'],
          title: '先揀問題分類',
          body: '用分類收窄問題，再撳題目睇完整答案。',
        },
      ],
    };
  }

  if (pathname === '/lucky-results' || pathname.startsWith('/lucky-results/')) {
    return {
      quiet: false,
      fallback: {
        title: '公開中獎公告',
        body: '每場會列明預定或實際抽獎日；未開獎都唔會用建立日期冒充抽獎日。',
      },
      candidates: [
        {
          id: 'lucky-event',
          selectors: ['main a.lr-event-link[href^="/lucky-results/"]'],
          title: '撳一場睇完整名單',
          body: '入去可以睇抽獎日、獎品同公開得獎資料。',
        },
        {
          id: 'lucky-share',
          selectors: ['main button.lr-cta-share'],
          title: '複製公告連結',
          body: '呢度只會複製公開公告網址，方便你分享俾朋友核對。',
        },
        {
          id: 'lucky-tryon',
          selectors: ['main a.lr-cta-pink[href="/try-on"]'],
          title: '順便試新造型',
          body: '呢度去 AI 試穿，我會按你嘅真實流程繼續帶路。',
        },
      ],
    };
  }

  if (pathname === '/wallet-topup') {
    if (context.walletPayment) {
      return {
        quiet: true,
        candidates: [],
        fallback: {
          title: '充值單已開，請核對付款資料',
          body: '我會留守唔干擾。金額、收款資料同截圖都由你親自核對同上傳。',
        },
      };
    }
    return {
      quiet: false,
      fallback: {
        title: '會員購物金充值',
        body: '先揀套票，再由你確認開單；開單後請核對金額同付款期限。',
      },
      candidates: [
        {
          id: 'wallet-login',
          selectors: ['main a[href="/login"].btn-primary'],
          title: '充值前先登入',
          body: '購物金係會員專屬，登入後先可以揀套票。',
        },
        {
          id: 'wallet-package',
          selectors: ['main button.wallet-package-card[aria-pressed]'],
          title: '先揀充值套票',
          body: '撳一個套票睇清楚金額同贈送；未開單前仍可更改選擇。',
        },
      ],
    };
  }

  if (pathname === '/login') {
    return {
      quiet: false,
      fallback: {
        title: '會員登入',
        body: '用電話同密碼登入；唔記得密碼可以用 Email 收重設碼。',
      },
      candidates: [
        {
          id: 'login-reset',
          selectors: ['main #reset-code'],
          title: '輸入 Email 收到嘅重設碼',
          body: '核對重設碼同新密碼，再由你親自提交。',
        },
        {
          id: 'login-forgot',
          selectors: ['main #forgot-email'],
          title: '用會員 Email 收重設碼',
          body: '輸入登記過嘅 Email，重設碼會送去你嘅信箱。',
        },
        {
          id: 'login-phone',
          selectors: ['main #login-phone'],
          title: '先輸入會員電話',
          body: '再填密碼就可以登入；新會員可以由下面連結開戶。',
        },
      ],
    };
  }

  if (pathname === '/register') {
    return {
      quiet: false,
      fallback: GENERIC_COPY,
      candidates: [
        {
          id: 'register-name',
          selectors: ['main #reg-name'],
          title: '由姓名開始開戶',
          body: '再填電話、Email 同密碼；通知偏好可以按自己需要選擇。',
        },
      ],
    };
  }

  if (pathname === '/live') {
    return {
      quiet: false,
      fallback: GENERIC_COPY,
      candidates: [
        {
          id: 'live-replay',
          selectors: ['main button.btn-replay'],
          title: '重溫直播場次',
          body: '撳場次睇回顧；想問款，仍可以用 WhatsApp 搵真人。',
        },
      ],
    };
  }

  if (
    pathname === '/checkout' ||
    pathname === '/guest-checkout' ||
    pathname === '/payment' ||
    pathname === '/guest-payment' ||
    pathname.startsWith('/receipt/')
  ) {
    return QUIET_PAYMENT_GUIDE;
  }

  return { quiet: true, candidates: [], fallback: GENERIC_COPY };
}

export interface FairyPoint {
  x: number;
  y: number;
}

export interface FairySize {
  w: number;
  h: number;
}

export interface FairyRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function validRect(rect: FairyRect): boolean {
  return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

export function rectFromPoint(point: FairyPoint, size: FairySize): FairyRect {
  return { left: point.x, top: point.y, width: size.w, height: size.h };
}

export function fairyOverlapsRect(point: FairyPoint, size: FairySize, rect: FairyRect): boolean {
  const a = rectFromPoint(point, size);
  return a.left < rect.left + rect.width && a.left + a.width > rect.left && a.top < rect.top + rect.height && a.top + a.height > rect.top;
}

export function expandRect(rect: FairyRect, padding: number): FairyRect {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

/** viewport 細過精靈時至少夾到 0；正常尺寸會保留完整安全邊距。 */
export function clampFairyPosition(
  point: FairyPoint,
  viewport: FairySize,
  fairy: FairySize,
  margin = 12,
): FairyPoint {
  const mx = Math.max(0, Math.min(margin, (viewport.w - fairy.w) / 2));
  const my = Math.max(0, Math.min(margin, (viewport.h - fairy.h) / 2));
  const maxX = Math.max(mx, viewport.w - fairy.w - mx);
  const maxY = Math.max(my, viewport.h - fairy.h - my);
  return {
    x: Math.min(Math.max(point.x, mx), maxX),
    y: Math.min(Math.max(point.y, my), maxY),
  };
}

export function restPosition(viewport: FairySize, fairy: FairySize, margin = 16): FairyPoint {
  return clampFairyPosition(
    { x: viewport.w - fairy.w - margin, y: viewport.h - fairy.h - margin * 4 },
    viewport,
    fairy,
    margin,
  );
}

export function intersectRect(a: FairyRect, b: FairyRect): FairyRect | null {
  if (!validRect(a) || !validRect(b)) return null;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** 目標至少要有足夠真實可見面積；完全離屏或只露少少都唔會被當可指。 */
export function visibleActionRect(rect: FairyRect, viewport: FairySize, bounds?: FairyRect): FairyRect | null {
  const visible = intersectRect(
    rect,
    bounds ?? { left: 0, top: 0, width: viewport.w, height: viewport.h },
  );
  if (!visible) return null;
  const minW = Math.min(32, rect.width);
  const minH = Math.min(28, rect.height);
  const ratio = (visible.width * visible.height) / (rect.width * rect.height);
  return visible.width >= minW && visible.height >= minH && ratio >= 0.35 ? visible : null;
}

/**
 * 飛行目的地喺新幾何下是否仍然安全：完整喺 viewport 內（唔需要 clamp 移位）
 * 而且唔撞任何障礙物。scroll 中流動幾何重讀時，仍安全嘅現有目標唔會被重排。
 */
export function fairyPointSafe(
  point: FairyPoint,
  fairy: FairySize,
  obstacles: readonly FairyRect[],
  viewport: FairySize,
): boolean {
  const clamped = clampFairyPosition(point, viewport, fairy);
  if (Math.abs(clamped.x - point.x) > 0.01 || Math.abs(clamped.y - point.y) > 0.01) return false;
  return freeAt(point, fairy, obstacles);
}

/**
 * 飛行 stall 偵測：以窗口淨位移＋目標距離進展判斷，唔係單幀郁唔郁。
 * 「安全但不可達」目標會令 advanceFairyFlight 每帧 ±幾 px 左右震盪——
 * 單帧郁動大過 0.01 所以舊 stalledFrames 永遠唔觸發；窗口內淨位移同
 * 接近目標距離都無實質進展，先係真 stall。
 */
export const FAIRY_FLIGHT_STALL_WINDOW_FRAMES = 24;
export const FAIRY_FLIGHT_STALL_MIN_PROGRESS_PX = 8;

export interface FairyFlightStallWindow {
  frames: number;
  start: FairyPoint;
  startTargetDistance: number;
}

export function shouldStopStalledFlight(
  window: FairyFlightStallWindow,
  current: FairyPoint,
  targetDistance: number,
  minFrames = FAIRY_FLIGHT_STALL_WINDOW_FRAMES,
  minProgressPx = FAIRY_FLIGHT_STALL_MIN_PROGRESS_PX,
): boolean {
  if (window.frames < minFrames) return false;
  const netMoved = Math.hypot(current.x - window.start.x, current.y - window.start.y);
  const approached = window.startTargetDistance - targetDistance;
  return netMoved < minProgressPx && approached < minProgressPx;
}

/**
 * stall 後仍碰撞嘅脫困目標：由肉眼位置揀最近嘅真 freeAt 安全位，
 * 排除已試過嘅目標，逐個方向試，唔會停喺仍然碰撞嘅位置。
 * 全部候選都唔 free 先回 null（極密頁面接受停留，等幾何改變）。
 */
export function fairyEscapeTarget(
  current: FairyPoint,
  exclude: readonly FairyPoint[],
  viewport: FairySize,
  fairy: FairySize,
  obstacles: readonly FairyRect[],
): FairyPoint | null {
  const isExcluded = (point: FairyPoint) =>
    exclude.some((tried) => Math.hypot(tried.x - point.x, tried.y - point.y) < 24);
  const candidates: FairyPoint[] = [];
  const seen = new Set<string>();
  const push = (raw: FairyPoint) => {
    const point = clampFairyPosition(raw, viewport, fairy);
    const key = `${Math.round(point.x)},${Math.round(point.y)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(point);
  };
  // 常用 dock 先試（右下休息位優先），再掃 32px 網格。
  push(restPosition(viewport, fairy, 16));
  push({ x: 16, y: viewport.h * 0.56 - fairy.h / 2 });
  push({ x: viewport.w - fairy.w - 16, y: viewport.h * 0.48 - fairy.h / 2 });
  push({ x: 16, y: 96 });
  push({ x: viewport.w - fairy.w - 16, y: 96 });
  const min = clampFairyPosition({ x: 12, y: 12 }, viewport, fairy);
  const max = clampFairyPosition({ x: viewport.w - fairy.w - 12, y: viewport.h - fairy.h - 12 }, viewport, fairy);
  for (let y = min.y; y <= max.y; y += 32) {
    for (let x = min.x; x <= max.x; x += 32) push({ x, y });
  }
  push(max);
  const viable = candidates
    .filter((point) => !isExcluded(point))
    .filter((point) => freeAt(point, fairy, obstacles))
    .sort((a, b) => Math.hypot(a.x - current.x, a.y - current.y) - Math.hypot(b.x - current.x, b.y - current.y));
  return viable[0] ?? null;
}

/** 拖曳：超過 6px 先當拖曳，唔會擋住正常 click；放開約 5 秒後連續飛返安全休息位。 */
export const FAIRY_DRAG_THRESHOLD_PX = 6;
export const FAIRY_DRAG_RETURN_MS = 5000;

export function shouldStartFairyDrag(
  start: FairyPoint,
  current: FairyPoint,
  threshold = FAIRY_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

function gapBetweenRects(a: FairyRect, b: FairyRect): number {
  const dx = Math.max(a.left - (b.left + b.width), b.left - (a.left + a.width), 0);
  const dy = Math.max(a.top - (b.top + b.height), b.top - (a.top + a.height), 0);
  return Math.hypot(dx, dy);
}

function freeAt(point: FairyPoint, fairy: FairySize, obstacles: readonly FairyRect[]): boolean {
  const right = point.x + fairy.w;
  const bottom = point.y + fairy.h;
  // 呢個函數喺飛行及掃位內層會行幾千次；共用外框、唔逐個障礙物建物件。
  for (const obstacle of obstacles) {
    if (
      point.x < obstacle.left + obstacle.width && right > obstacle.left &&
      point.y < obstacle.top + obstacle.height && bottom > obstacle.top
    ) return false;
  }
  return true;
}

/**
 * 細步飛行都要檢查成段路徑，唔可以只驗終點就穿過商品或文字。
 * 如果舊位置啱啱被滾動中嘅內容撞上，可以穿過「起點已碰撞」嘅障礙物連續脫困；
 * 但唔准因此撞入新障礙物。完全脫離後，同一段路徑亦唔可以再撞返入去。
 */
function clearFlightStep(
  from: FairyPoint,
  to: FairyPoint,
  fairy: FairySize,
  obstacles: readonly FairyRect[],
): boolean {
  // Broadphase：只保留呢段線嘅 swept bounds 真係可能碰到嘅障礙物。
  // 規則本身不變，但密集商品頁唔再每個候選細步都掃全頁所有文字及圖片。
  const sweepLeft = Math.min(from.x, to.x);
  const sweepTop = Math.min(from.y, to.y);
  const sweepRight = Math.max(from.x, to.x);
  const sweepBottom = Math.max(from.y, to.y);
  const relevant = obstacles.filter((obstacle) => {
    const config = flightConfigRect(obstacle, fairy);
    return config.left < sweepRight && config.left + config.width > sweepLeft &&
      config.top < sweepBottom && config.top + config.height > sweepTop;
  });
  // 唔好再用局部碰撞面積升降決定方向，否則多段文字或部分包圍時，
  // 會揀一條永遠出唔到去嘅向左細步。未碰撞障礙物用精確線段測試，
  // 連少於 6px 嘅角位擦撞都唔會漏；起點已碰撞嘅凸矩形則准許沿直線離開。
  for (const obstacle of relevant) {
    if (fairyOverlapsRect(from, fairy, obstacle)) continue;
    if (segmentRectEntry(from, to, flightConfigRect(obstacle, fairy)) !== null) return false;
  }
  return true;
}

function flightConfigRect(obstacle: FairyRect, fairy: FairySize, padding = 0): FairyRect {
  return {
    left: obstacle.left - fairy.w - padding,
    top: obstacle.top - fairy.h - padding,
    width: obstacle.width + fairy.w + padding * 2,
    height: obstacle.height + fairy.h + padding * 2,
  };
}

/** 回傳線段真正穿過矩形嘅進入比例；只擦到起點／角位唔當阻擋。 */
function segmentRectEntry(from: FairyPoint, to: FairyPoint, rect: FairyRect): number | null {
  let enter = 0;
  let exit = 1;
  const axes = [
    { origin: from.x, delta: to.x - from.x, min: rect.left, max: rect.left + rect.width },
    { origin: from.y, delta: to.y - from.y, min: rect.top, max: rect.top + rect.height },
  ];
  for (const axis of axes) {
    if (Math.abs(axis.delta) < 0.0000001) {
      if (axis.origin < axis.min || axis.origin > axis.max) return null;
      continue;
    }
    const a = (axis.min - axis.origin) / axis.delta;
    const b = (axis.max - axis.origin) / axis.delta;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  const start = Math.max(0, enter);
  const end = Math.min(1, exit);
  return end - start > 0.0001 ? start : null;
}

function flightSegmentClear(
  from: FairyPoint,
  to: FairyPoint,
  fairy: FairySize,
  obstacles: readonly FairyRect[],
): boolean {
  const left = Math.min(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const right = Math.max(from.x, to.x);
  const bottom = Math.max(from.y, to.y);
  for (const obstacle of obstacles) {
    const config = flightConfigRect(obstacle, fairy);
    if (
      config.left >= right || config.left + config.width <= left ||
      config.top >= bottom || config.top + config.height <= top
    ) continue;
    if (segmentRectEntry(from, to, config) !== null) return false;
  }
  return true;
}

/**
 * 直線穿過商品／文字時，搵第一個阻擋矩形嘅可見角位做臨時 waypoint。
 * 每次只處理最近阻擋物，唔會喺每幀為全頁幾百個障礙物建大型 path graph。
 */
function flightDetourWaypoint(
  current: FairyPoint,
  target: FairyPoint,
  viewport: FairySize,
  fairy: FairySize,
  obstacles: readonly FairyRect[],
): FairyPoint | null {
  if (!freeAt(current, fairy, obstacles)) return null;
  let blocker: FairyRect | null = null;
  let blockerEntry = Infinity;
  for (const obstacle of obstacles) {
    const entry = segmentRectEntry(current, target, flightConfigRect(obstacle, fairy));
    if (entry !== null && entry < blockerEntry) {
      blocker = obstacle;
      blockerEntry = entry;
    }
  }
  if (!blocker) return null;
  const bounds = flightConfigRect(blocker, fairy, 2);
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const corners: FairyPoint[] = [
    { x: bounds.left, y: bounds.top },
    { x: right, y: bounds.top },
    { x: bounds.left, y: bottom },
    { x: right, y: bottom },
  ];
  const viableCorners = corners
    .map((raw) => clampFairyPosition(raw, viewport, fairy))
    .filter((point) => freeAt(point, fairy, obstacles));
  let best: { point: FairyPoint; score: number } | null = null;
  for (const point of viableCorners) {
    const approach = Math.hypot(point.x - current.x, point.y - current.y);
    if (approach <= 1 || !clearFlightStep(current, point, fairy, obstacles)) continue;
    let remaining = flightSegmentClear(point, target, fairy, obstacles)
      ? Math.hypot(target.x - point.x, target.y - point.y)
      : Infinity;
    if (!Number.isFinite(remaining)) {
      // 近側角位之後通常仲要沿底邊／頂邊去遠側角位；將呢段計入成本，
      // 否則會喺近側角位附近前後拉鋸，永遠行唔過件商品。
      for (const next of viableCorners) {
        const leg = Math.hypot(next.x - point.x, next.y - point.y);
        if (leg <= 1) continue;
        if (!flightSegmentClear(point, next, fairy, obstacles)) continue;
        if (!flightSegmentClear(next, target, fairy, obstacles)) continue;
        remaining = Math.min(remaining, leg + Math.hypot(target.x - next.x, target.y - next.y));
      }
    }
    if (!Number.isFinite(remaining)) continue;
    const score = approach + remaining;
    if (!best || score < best.score) best = { point, score };
  }
  return best?.point ?? null;
}

export interface FairyFlightInput {
  current: FairyPoint;
  target: FairyPoint;
  viewport: FairySize;
  fairy: FairySize;
  obstacles?: readonly FairyRect[];
  deltaMs: number;
  maxSpeed?: number;
}

/**
 * 時間制連續飛行：高刷新率電話會行更多細步，唔再用整點瞬移。
 * 直線受阻時試細角度繞行／沿邊滑動；完全無安全細步就停留等下一次幾何更新。
 */
export function advanceFairyFlight(input: FairyFlightInput): FairyPoint {
  const { current, target, viewport, fairy } = input;
  const obstacles = input.obstacles ?? [];
  const distance = Math.hypot(target.x - current.x, target.y - current.y);
  if (distance < 0.25) return { ...current };
  const deltaMs = Math.max(0, Math.min(40, input.deltaMs));
  if (deltaMs === 0) return { ...current };
  const maxSpeed = input.maxSpeed ?? 1080;
  const speed = Math.min(maxSpeed, Math.max(220, distance * 7.5));
  const destination = flightDetourWaypoint(current, target, viewport, fairy, obstacles) ?? target;
  const destinationDistance = Math.hypot(destination.x - current.x, destination.y - current.y);
  if (destinationDistance < 0.05) return { ...current };
  const step = Math.min(destinationDistance, speed * deltaMs / 1000);
  const baseAngle = Math.atan2(destination.y - current.y, destination.x - current.x);
  const angleOffsets = [0, 12, -12, 24, -24, 40, -40, 60, -60, 82, -82, 105, -105, 140, -140, 180];
  let best: { point: FairyPoint; score: number } | null = null;
  for (const stepScale of [1, 0.5, 0.25]) {
    for (const offset of angleOffsets) {
      const angle = baseAngle + offset * Math.PI / 180;
      const intendedStep = step * stepScale;
      const clamped = clampFairyPosition(
        {
          x: current.x + Math.cos(angle) * intendedStep,
          y: current.y + Math.sin(angle) * intendedStep,
        },
        viewport,
        fairy,
      );
      // 精靈尺寸恢復或 viewport 改變時，clamp 可能額外加入安全邊距修正。
      // 將修正後向量按比例縮回本帧步幅，唔好令 margin correction 同飛行距離叠加成超步。
      const clampedDistance = Math.hypot(clamped.x - current.x, clamped.y - current.y);
      const candidate = clampedDistance > intendedStep && clampedDistance > 0
        ? {
            x: current.x + (clamped.x - current.x) * intendedStep / clampedDistance,
            y: current.y + (clamped.y - current.y) * intendedStep / clampedDistance,
          }
        : clamped;
      if (Math.hypot(candidate.x - current.x, candidate.y - current.y) < 0.05) continue;
      if (!clearFlightStep(current, candidate, fairy, obstacles)) continue;
      // 直線安全時立即行；受阻時唔再取「第一個唔撞」嘅後退步，
      // 而係取最能縮短目標距離嘅細步，避免喺障礙物前左右／上下來回震盪。
      if (offset === 0 && stepScale === 1) return candidate;
      const remaining = Math.hypot(destination.x - candidate.x, destination.y - candidate.y);
      const score = remaining + (1 - stepScale) * 0.001 + Math.abs(offset) * 0.000001;
      if (!best || score < best.score - 0.000000001) best = { point: candidate, score };
    }
  }
  return best?.point ?? { ...current };
}

export interface FairyPlacementInput {
  viewport: FairySize;
  fairy: FairySize;
  /** 已同 viewport 取交集嘅真實可見目標；null 代表冇目標可指。 */
  target?: FairyRect | null;
  obstacles?: readonly FairyRect[];
  current?: FairyPoint | null;
  /** 冇可見導覽目標時優先返回右下休息位；被浮鈕佔用就先揀最近安全位。 */
  preferRest?: boolean;
  margin?: number;
  gap?: number;
}

export interface FairyPlacement {
  point: FairyPoint;
  nearTarget: boolean;
}

/**
 * 目標四周先揀無碰撞位；冇位就試安全 dock。所有碰撞都喺夾取後再驗，
 * 唔會出現「原本啱位、clamp 後冚粒掣」嘅假安全。
 */
export function chooseFairyPlacement(input: FairyPlacementInput): FairyPlacement | null {
  const { viewport, fairy, current } = input;
  const margin = input.margin ?? 12;
  const gap = input.gap ?? 12;
  const obstacles = input.obstacles ?? [];
  const preferRest = input.preferRest ?? false;
  const target = preferRest ? null : input.target ?? null;
  const collisions = target ? [...obstacles, expandRect(target, 5)] : obstacles;
  const idealRest = restPosition(viewport, fairy, 16);
  const currentPoint = current ? clampFairyPosition(current, viewport, fairy, margin) : null;
  const currentSafe = currentPoint && freeAt(currentPoint, fairy, collisions) ? currentPoint : null;

  // 冇目標要指時以右下休息位為首選；唔再因舊位置「冇碰撞」就永遠停喺頁面中間。
  if (preferRest && freeAt(idealRest, fairy, collisions)) {
    return { point: idealRest, nearTarget: false };
  }

  // 有導覽目標時，舊位置仍然安全就唔搬；ring 可以更新，精靈唔需要跟住每粒掣閃位。
  // 一旦真正相撞，先揀最近安全出口，再由時間制飛行 loop 連續移過去。
  if (currentSafe && !preferRest) {
    const nearTarget = !!target && gapBetweenRects(rectFromPoint(currentSafe, fairy), target) <= gap + 32;
    return { point: currentSafe, nearTarget };
  }

  if (target) {
    const midX = target.left + target.width / 2 - fairy.w / 2;
    const midY = target.top + target.height / 2 - fairy.h / 2;
    const candidates: FairyPoint[] = [
      { x: target.left - fairy.w - gap, y: midY },
      { x: target.left + target.width + gap, y: midY },
      { x: midX, y: target.top - fairy.h - gap },
      { x: midX, y: target.top + target.height + gap },
      { x: target.left - fairy.w - gap, y: target.top + target.height - fairy.h },
      { x: target.left + target.width + gap, y: target.top },
    ];
    const viable = candidates
      .map((point, index) => ({ point: clampFairyPosition(point, viewport, fairy, margin), index }))
      .filter(({ point }) => freeAt(point, fairy, collisions))
      .filter(({ point }) => gapBetweenRects(rectFromPoint(point, fairy), target) <= gap + 32)
      .sort((a, b) => {
        const da = gapBetweenRects(rectFromPoint(a.point, fairy), target) + (current ? Math.hypot(a.point.x - current.x, a.point.y - current.y) * 0.25 : 0);
        const db = gapBetweenRects(rectFromPoint(b.point, fairy), target) + (current ? Math.hypot(b.point.x - current.x, b.point.y - current.y) * 0.25 : 0);
        return da - db || a.index - b.index;
      });
    if (viable[0]) return { point: viable[0].point, nearTarget: true };
  }

  const docks: FairyPoint[] = [
    idealRest,
    { x: 16, y: viewport.h * 0.56 - fairy.h / 2 },
    { x: viewport.w - fairy.w - 16, y: viewport.h * 0.48 - fairy.h / 2 },
    { x: 16, y: 96 },
    { x: viewport.w - fairy.w - 16, y: 96 },
  ];
  const viableDocks = docks
    .map((candidate, index) => ({
      point: clampFairyPosition(candidate, viewport, fairy, margin),
      index,
    }))
    .filter(({ point }) => freeAt(point, fairy, collisions))
    .sort((a, b) => {
      const dockAnchor = preferRest ? idealRest : current;
      if (!dockAnchor) return a.index - b.index;
      const da = Math.hypot(a.point.x - dockAnchor.x, a.point.y - dockAnchor.y);
      const db = Math.hypot(b.point.x - dockAnchor.x, b.point.y - dockAnchor.y);
      return da - db || a.index - b.index;
    });
  // 初次進場先用常用 dock；已有位置被撞時，dock 只係候選之一，
  // 仲會同附近細格一同比較距離，唔會因為「有個遠 dock 可用」就即刻閃去另一邊。
  if (!current && viableDocks[0]) return { point: viableDocks[0].point, nearTarget: false };

  // 密集商品頁唔靠「放寬碰撞」硬冚內容；真係冇位仍然回 null。
  const min = clampFairyPosition({ x: margin, y: margin }, viewport, fairy, margin);
  const max = clampFairyPosition(
    { x: viewport.w - fairy.w - margin, y: viewport.h - fairy.h - margin },
    viewport,
    fairy,
    margin,
  );
  const axis = (from: number, to: number): number[] => {
    const values: number[] = [];
    for (let value = from; value < to; value += 32) values.push(value);
    values.push(to);
    return [...new Set(values)];
  };
  const anchor = preferRest ? idealRest : current ?? idealRest;
  const grid: Array<{ point: FairyPoint; distance: number }> = viableDocks.map(({ point }) => ({
    point,
    distance: Math.hypot(point.x - anchor.x, point.y - anchor.y),
  }));
  for (const y of axis(min.y, max.y)) {
    for (const x of axis(min.x, max.x)) {
      const point = { x, y };
      grid.push({ point, distance: Math.hypot(x - anchor.x, y - anchor.y) });
    }
  }
  grid.sort((a, b) => a.distance - b.distance);
  for (const { point } of grid) {
    if (freeAt(point, fairy, collisions)) return { point, nearTarget: false };
  }
  // 極密頁面如果真係搵唔到更近右下嘅位，安全舊位仍好過硬冚內容或憑空消失。
  if (currentSafe) return { point: currentSafe, nearTarget: false };
  return null;
}

/** 小氣泡同精靈分開計位；無安全位置就回 null，唔硬冚真控制。 */
export function computeBubbleLayout(
  fairy: FairyPoint,
  fairySize: FairySize,
  bubble: FairySize,
  viewport: FairySize,
  obstacles: readonly FairyRect[] = [],
  gap = 10,
): FairyPoint | null {
  const size = {
    w: Math.min(bubble.w, Math.max(0, viewport.w - 24)),
    h: Math.min(bubble.h, Math.max(0, viewport.h - 24)),
  };
  const fairyRect = expandRect(rectFromPoint(fairy, fairySize), 4);
  const collisions = [...obstacles, fairyRect];
  const candidates: FairyPoint[] = [
    { x: fairy.x + fairySize.w + gap, y: fairy.y + fairySize.h - size.h },
    { x: fairy.x - size.w - gap, y: fairy.y + fairySize.h - size.h },
    { x: fairy.x + fairySize.w / 2 - size.w / 2, y: fairy.y - size.h - gap },
    { x: fairy.x + fairySize.w / 2 - size.w / 2, y: fairy.y + fairySize.h + gap },
    // 使用者明確撳開嘅短氣泡可以多試幾個角落，避免密集頁面「撳咗無反應」。
    { x: 12, y: 12 },
    { x: viewport.w - size.w - 12, y: 12 },
    { x: 12, y: viewport.h - size.h - 12 },
    { x: viewport.w - size.w - 12, y: viewport.h - size.h - 12 },
    { x: 12, y: viewport.h / 2 - size.h / 2 },
    { x: viewport.w - size.w - 12, y: viewport.h / 2 - size.h / 2 },
  ];
  for (const candidate of candidates) {
    const point = clampFairyPosition(candidate, viewport, size, 12);
    if (freeAt(point, size, collisions)) return point;
  }

  // 常用位置全部相撞先掃完整 viewport；冇安全位仍然回 null，唔改用舊座標或硬冚商品。
  const min = clampFairyPosition({ x: 12, y: 12 }, viewport, size, 12);
  const max = clampFairyPosition(
    { x: viewport.w - size.w - 12, y: viewport.h - size.h - 12 },
    viewport,
    size,
    12,
  );
  const axis = (from: number, to: number, edges: readonly number[]): number[] => {
    const values: number[] = [];
    for (let value = from; value < to; value += 32) values.push(value);
    values.push(to);
    // 只得幾 px 容差嘅安全縫可能完全落喺 32px 網格之間。
    // 將每個障礙物四邊化成候選座標；所有點仍要過同一份完整碰撞檢查。
    for (const edge of edges) {
      if (edge >= from && edge <= to) values.push(edge);
    }
    return [...new Set(values)].sort((a, b) => a - b);
  };
  const xEdges = collisions.flatMap((rect) => [rect.left + rect.width, rect.left - size.w]);
  const yEdges = collisions.flatMap((rect) => [rect.top + rect.height, rect.top - size.h]);
  const grid: Array<{ point: FairyPoint; distance: number }> = [];
  for (const y of axis(min.y, max.y, yEdges)) {
    for (const x of axis(min.x, max.x, xEdges)) {
      grid.push({ point: { x, y }, distance: Math.hypot(x - fairy.x, y - fairy.y) });
    }
  }
  grid.sort((a, b) => a.distance - b.distance);
  for (const { point } of grid) {
    if (freeAt(point, size, collisions)) return point;
  }
  return null;
}

/** TryOn 分享／購買完成只可信明確成功事件，唔信 capture click。 */
export const TRYON_GUIDE_EVENT = 'redcode:tryon-guide';
export type TryOnGuideAction = 'share' | 'purchase';

export function parseTryOnGuideAction(detail: unknown): TryOnGuideAction | null {
  if (!detail || typeof detail !== 'object') return null;
  const action = (detail as { action?: unknown }).action;
  return action === 'share' || action === 'purchase' ? action : null;
}

export function emitTryOnGuideAction(action: TryOnGuideAction): boolean {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  return window.dispatchEvent(new CustomEvent(TRYON_GUIDE_EVENT, { detail: { action } }));
}

export const FAIRY_DISMISS_KEY = 'redcode-fairy-dismissed';
