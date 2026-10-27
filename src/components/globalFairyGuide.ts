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
        {
          id: 'products-card',
          selectors: ['main article a[href^="/products/"]'],
          title: '撳商品卡睇詳情',
          body: '入去可以睇相片、尺寸同價錢；合資格商品亦有 AI 試穿入口。',
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
    { x: margin, y: viewport.h - fairy.h - margin * 4 },
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
export function visibleActionRect(rect: FairyRect, viewport: FairySize): FairyRect | null {
  const visible = intersectRect(rect, { left: 0, top: 0, width: viewport.w, height: viewport.h });
  if (!visible) return null;
  const minW = Math.min(32, rect.width);
  const minH = Math.min(28, rect.height);
  const ratio = (visible.width * visible.height) / (rect.width * rect.height);
  return visible.width >= minW && visible.height >= minH && ratio >= 0.35 ? visible : null;
}

function gapBetweenRects(a: FairyRect, b: FairyRect): number {
  const dx = Math.max(a.left - (b.left + b.width), b.left - (a.left + a.width), 0);
  const dy = Math.max(a.top - (b.top + b.height), b.top - (a.top + a.height), 0);
  return Math.hypot(dx, dy);
}

function freeAt(point: FairyPoint, fairy: FairySize, obstacles: readonly FairyRect[]): boolean {
  return obstacles.every((obstacle) => !fairyOverlapsRect(point, fairy, obstacle));
}

export interface FairyPlacementInput {
  viewport: FairySize;
  fairy: FairySize;
  /** 已同 viewport 取交集嘅真實可見目標；null 代表冇目標可指。 */
  target?: FairyRect | null;
  obstacles?: readonly FairyRect[];
  current?: FairyPoint | null;
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
  const target = input.target ?? null;
  const collisions = target ? [...obstacles, expandRect(target, 5)] : obstacles;

  // scroll 逐幀重算時，舊位置仍然安全就唔搬；目標離屏唔應無故彈去另一個 dock。
  // 一旦真正相撞，仍然行完整安全掃位，絕不為咗視覺平滑而穿过內容。
  if (!target && current) {
    const point = clampFairyPosition(current, viewport, fairy, margin);
    if (freeAt(point, fairy, collisions)) return { point, nearTarget: false };
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
        const da = gapBetweenRects(rectFromPoint(a.point, fairy), target) + (current ? Math.hypot(a.point.x - current.x, a.point.y - current.y) * 0.015 : 0);
        const db = gapBetweenRects(rectFromPoint(b.point, fairy), target) + (current ? Math.hypot(b.point.x - current.x, b.point.y - current.y) * 0.015 : 0);
        return da - db || a.index - b.index;
      });
    if (viable[0]) return { point: viable[0].point, nearTarget: true };
  }

  const docks: FairyPoint[] = [
    restPosition(viewport, fairy, 16),
    { x: 16, y: viewport.h * 0.56 - fairy.h / 2 },
    { x: viewport.w - fairy.w - 16, y: viewport.h * 0.48 - fairy.h / 2 },
    { x: viewport.w / 2 - fairy.w / 2, y: viewport.h - fairy.h - 88 },
    { x: 16, y: 96 },
    { x: viewport.w - fairy.w - 16, y: 96 },
  ];
  for (const candidate of docks) {
    const point = clampFairyPosition(candidate, viewport, fairy, margin);
    if (freeAt(point, fairy, collisions)) return { point, nearTarget: false };
  }

  // 密集商品頁唔靠「放寬碰撞」硬冚內容：最後掃一次完整 viewport 嘅細格安全位。
  // 只有六個常用 dock 全部相撞先會行呢段；真係冇位仍然回 null。
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
  const anchor = current ?? restPosition(viewport, fairy, 16);
  const grid: Array<{ point: FairyPoint; distance: number }> = [];
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
