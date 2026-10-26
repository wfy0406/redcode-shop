/**
 * 全域小精靈導覽 —— 純邏輯層（無 DOM / 無 React，node 環境可直接測試）。
 *
 * 由 GlobalFairyGuide.tsx 呼叫；所有 DOM 查詢、rAF、observer 都喺組件入面，
 * 呢度淨係：步驟狀態機、目標選擇器合約、位置夾取、飛行逼近、面板擺位、文案。
 *
 * ■ data-attribute 合約（畀 lead 之後 instrument TryOn / Home 用，可選）：
 *   - `data-fairy-target="photo|product|generate|share|purchase|home-cta"`
 *     加喺想小精靈飛去嘅「可動作元素」上；存在時優先於內建 TryOn class 選擇器。
 *   內建 fallback 選擇器直接對應而家 TryOn.tsx / TryOnPurchase.tsx DOM：
 *     photo    → .tryon-photo-panel .tryon-camera-controls
 *     product  → .tryon-product-panel .tryon-contact-sheet
 *     generate → .tryon-submit-zone .tryon-generate-button
 *     share    → .tryon-share-actions
 *     purchase → [data-testid="tryon-purchase"] .tryon-purchase-buy
 *   狀態偵測用現有 DOM 訊號，唔使 TryOn 加嘢都work：
 *     有相    → .tryon-photo-preview 出現
 *     已揀款  → .tryon-product-card[data-selected='true'] 數量
 *     生成中  → .tryon-job-status[data-status='queued'|'processing'|...]
 *     完成    → .tryon-job-status[data-status='completed']
 *     分享區  → .tryon-share-actions（真・成功先當 done，由 TRYON_GUIDE_EVENT 'share' 記）
 *     購買區  → [data-testid="tryon-purchase"]（真・加車/即買成功先當 done，由 'purchase' 記）
 *   2026-10-26 第二輪：廢除 capture-phase click 推測（容器空白 click 會誤記＝假進度），
 *   一律改用 TRYON_GUIDE_EVENT 明確成功事件。
 */

export type FairyStepId = 'photo' | 'product' | 'generate' | 'share' | 'purchase';
export type FairyStepStatus = 'done' | 'current' | 'todo';

/** 五步順序固定；computeTryOnStep 回傳嘅一定係呢條鏈入面其中一步。 */
export const FAIRY_STEP_ORDER: readonly FairyStepId[] = [
  'photo',
  'product',
  'generate',
  'share',
  'purchase',
];

/** data-fairy-target 合約值（home-cta 淨係目標，唔係步驟）。 */
export const FAIRY_TARGET_ATTR = 'data-fairy-target';

/**
 * 每一步嘅目標選擇器，排頭優先。第一步永遠係 data-attribute 合約；
 * 之後係而家 TryOn DOM 實際 class（2026-10-26 核對過 TryOn.tsx / TryOnPurchase.tsx）。
 */
export const FAIRY_STEP_TARGET_SELECTORS: Record<FairyStepId, readonly string[]> = {
  photo: [
    `[${FAIRY_TARGET_ATTR}="photo"]`,
    '.tryon-photo-panel .tryon-camera-controls',
    '.tryon-photo-panel',
  ],
  product: [
    `[${FAIRY_TARGET_ATTR}="product"]`,
    '.tryon-product-panel .tryon-contact-sheet',
    '.tryon-product-panel',
  ],
  generate: [
    `[${FAIRY_TARGET_ATTR}="generate"]`,
    '.tryon-submit-zone .tryon-generate-button',
    '.tryon-submit-zone',
  ],
  share: [
    `[${FAIRY_TARGET_ATTR}="share"]`,
    '.tryon-share-actions',
    '.tryon-result-section',
  ],
  purchase: [
    `[${FAIRY_TARGET_ATTR}="purchase"]`,
    '[data-testid="tryon-purchase"] .tryon-purchase-buy',
    '[data-testid="tryon-purchase"]',
  ],
};

/** 首頁 helper 嘅飛行目標（CTA「開始 AI 試穿」）；唔存在就 perch 喺角落。 */
export const FAIRY_HOME_TARGET_SELECTORS: readonly string[] = [
  `[${FAIRY_TARGET_ATTR}="home-cta"]`,
];

/** 由 DOM 讀返嚟嘅試穿訊號（組件負責讀，呢度淨係定義形狀）。 */
export interface TryOnSignals {
  /** .tryon-photo-preview 出現＝已影好／揀好全身相 */
  hasPhoto: boolean;
  /** .tryon-product-card[data-selected='true'] 數量 */
  selectionCount: number;
  /** .tryon-result-section 已 render（即 job 存在） */
  jobPresent: boolean;
  /** .tryon-job-status[data-status] 係 queued/processing 等未完成狀態 */
  jobActive: boolean;
  /** .tryon-job-status[data-status='completed'] */
  jobCompleted: boolean;
  /** 用戶已真係下載／分享成功（DOM 讀唔到，由 TRYON_GUIDE_EVENT 'share' 成功事件記） */
  shareActed: boolean;
  /** [data-testid="tryon-purchase"] 出現（完成或失敗都會 render） */
  purchasePresent: boolean;
  /** 用戶已真係加車／即買成功（由 TRYON_GUIDE_EVENT 'purchase' 成功事件記） */
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

/**
 * 五步狀態機：唔准假進度——每一步都係由真 DOM 訊號推出嚟。
 * 規則（有先後）：
 *   未影相 → photo；未揀款 → product；未提交／生成緊 → generate；
 *   生成完成未分享 → share；有購買區 → purchase；已購買 → 仍停 purchase（面板顯示完成文案）。
 */
export function computeTryOnStep(signals: TryOnSignals): FairyStepId {
  if (!signals.hasPhoto) return 'photo';
  if (signals.selectionCount < 1 && !signals.jobPresent) return 'product';
  // job 一出現（生成中／完成／失敗）就唔會跌返 product——追加階段選擇已鎖定
  if (!signals.jobPresent) return 'generate';
  if (signals.jobActive) return 'generate';
  if (signals.jobCompleted && !signals.shareActed) return 'share';
  if (signals.purchasePresent) return 'purchase';
  // job 失敗／未有購買區：生成步未過得去，指返 generate 區（結果區有重試掣）
  if (!signals.jobCompleted) return 'generate';
  return 'share';
}

/** 五步各自狀態（面板列表用）。current 一定喺 FAIRY_STEP_ORDER 入面。 */
export function buildStepStates(current: FairyStepId): Array<{ id: FairyStepId; status: FairyStepStatus }> {
  const currentIndex = FAIRY_STEP_ORDER.indexOf(current);
  return FAIRY_STEP_ORDER.map((id, index) => ({
    id,
    status: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo',
  }));
}

export interface FairyPoint {
  x: number;
  y: number;
}

export interface FairySize {
  w: number;
  h: number;
}

/**
 * 手機夾取：小精靈（以及佢嘅目標點）永遠唔准出 viewport，
 * 保證冇橫向 overflow（overlay 本身 overflow-hidden 雙保險）。
 */
export function clampFairyPosition(
  point: FairyPoint,
  viewport: FairySize,
  fairy: FairySize,
  margin = 8,
): FairyPoint {
  const maxX = Math.max(margin, viewport.w - fairy.w - margin);
  const maxY = Math.max(margin, viewport.h - fairy.h - margin);
  return {
    x: Math.min(Math.max(point.x, margin), maxX),
    y: Math.min(Math.max(point.y, margin), maxY),
  };
}

/** 冇目標時嘅休息位：左下角（右下係 WhatsApp／Messenger 浮鈕地頭，唔好騎住）。 */
export function restPosition(viewport: FairySize, fairy: FairySize, margin = 16): FairyPoint {
  return clampFairyPosition(
    { x: margin, y: viewport.h - fairy.h - margin * 4 },
    viewport,
    fairy,
    margin,
  );
}

export interface FairyRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 小精靈（喺 point、大細 size）會唔會冚住目標 rect——DOMRect 結構相容，可直接傳入。 */
export function fairyOverlapsRect(point: FairyPoint, size: FairySize, rect: FairyRect): boolean {
  return (
    point.x < rect.left + rect.width &&
    point.x + size.w > rect.left &&
    point.y < rect.top + rect.height &&
    point.y + size.h > rect.top
  );
}

/** 唔冚目標嘅休息位：依次試左下（預設）、右上、左上、右下；全部都冚（目標大到冚晒成個
 *  viewport）先返回左下預設——呢種極端情況冇位可避，只能接受重疊。 */
export function fallbackPerch(rect: FairyRect, viewport: FairySize, fairy: FairySize, margin = 16): FairyPoint {
  const corners: FairyPoint[] = [
    restPosition(viewport, fairy, margin), // 左下（預設，遠離右下 WhatsApp／Messenger 浮鈕）
    clampFairyPosition({ x: viewport.w - fairy.w - margin, y: margin }, viewport, fairy, margin), // 右上
    clampFairyPosition({ x: margin, y: margin }, viewport, fairy, margin), // 左上
    clampFairyPosition({ x: viewport.w - fairy.w - margin, y: viewport.h - fairy.h - margin * 4 }, viewport, fairy, margin), // 右下
  ];
  for (const corner of corners) {
    if (!fairyOverlapsRect(corner, fairy, rect)) return corner;
  }
  return corners[0];
}

/**
 * 由目標 rect 計小精靈落腳點：依次試左側、右側、上方、下方四個貼邊位，
 * 每個都經 clampFairyPosition 夾入 viewport 後再驗證唔冚住目標（審碼要求：
 * 手機 clamp 後絕對唔准覆蓋實際目標按鈕）；四邊都擺唔落就返唔冚目標嘅
 * 休息位，唔會硬夾到粒掣上面。
 */
export function anchorToTarget(
  rect: FairyRect,
  viewport: FairySize,
  fairy: FairySize,
  gap = 12,
): FairyPoint {
  const midX = rect.left + rect.width / 2 - fairy.w / 2;
  const midY = rect.top + rect.height / 2 - fairy.h / 2;
  const candidates: FairyPoint[] = [
    { x: rect.left - fairy.w - gap, y: midY }, // 左側
    { x: rect.left + rect.width + gap, y: midY }, // 右側
    { x: midX, y: rect.top - fairy.h - gap }, // 上方
    { x: midX, y: rect.top + rect.height + gap }, // 下方
  ];
  for (const candidate of candidates) {
    const clamped = clampFairyPosition(candidate, viewport, fairy);
    if (!fairyOverlapsRect(clamped, fairy, rect)) return clamped;
  }
  return fallbackPerch(rect, viewport, fairy);
}

/**
 * 每幀逼近（指數平滑，framerate-independent）。
 * dt 秒；speed 越大越快（≈每秒追上嘅比例）。reduced-motion 時組件唔會call。
 */
export function approachPoint(current: FairyPoint, target: FairyPoint, dt: number, speed = 4.5): FairyPoint {
  const t = 1 - Math.exp(-Math.max(0, dt) * speed);
  return {
    x: current.x + (target.x - current.x) * t,
    y: current.y + (target.y - current.y) * t,
  };
}

/** 待機微浮動（px），疊加喺落腳點上；t 係秒。細幅度，唔會令人眼冤。 */
export function hoverDrift(t: number): FairyPoint {
  return {
    x: Math.sin(t * 0.9) * 6,
    y: Math.sin(t * 1.7) * 8,
  };
}

/** 面板擺位：預設喺小精靈右側；右邊出界就轉左；左右都擺唔落（手機）就放佢頭頂
 * （頂都唔夠位就壓底），最後夾入 viewport——總之唔會冚實小精靈本身。 */
export function computePanelLayout(
  fairy: FairyPoint,
  fairySize: FairySize,
  panel: FairySize,
  viewport: FairySize,
  gap = 10,
): FairyPoint {
  const panelW = Math.min(panel.w, viewport.w - 16);
  const panelH = Math.min(panel.h, viewport.h - 16);
  const rightX = fairy.x + fairySize.w + gap;
  const leftX = fairy.x - panelW - gap;
  if (rightX + panelW <= viewport.w - 8) {
    const y = fairy.y + fairySize.h - panelH; // 面板底對齊小精靈底
    return clampFairyPosition({ x: rightX, y: y < 8 ? fairy.y : y }, viewport, { w: panelW, h: panelH });
  }
  if (leftX >= 8) {
    const y = fairy.y + fairySize.h - panelH;
    return clampFairyPosition({ x: leftX, y: y < 8 ? fairy.y : y }, viewport, { w: panelW, h: panelH });
  }
  // 側邊唔夠位：放小精靈頭頂（優先）或者腳下，水平置中
  const aboveY = fairy.y - panelH - gap;
  const y = aboveY >= 8 ? aboveY : fairy.y + fairySize.h + gap;
  const x = fairy.x + fairySize.w / 2 - panelW / 2;
  return clampFairyPosition({ x, y }, viewport, { w: panelW, h: panelH });
}

export interface FairyStepCopy {
  title: string;
  body: string;
}

/** 五步文案（跟全站廣東話口吻；唔准寫假進度百分比）。 */
export const FAIRY_STEP_COPY: Record<FairyStepId, FairyStepCopy> = {
  photo: {
    title: '第 1 步：影低或上載全身相',
    body: '撳「前鏡自拍全身相」／「後鏡拍攝」，或者「用相簿揀相」。頭到腳企直、光線平均就最好；未按「確認生成」唔會用額度。',
  },
  product: {
    title: '第 2 步：揀一件或兩件商品',
    body: '喺右邊商品區撳想試嘅款；第一次生成前最多即場揀兩件不同部位，每件各用 1 次額度。',
  },
  generate: {
    title: '第 3 步：確認生成',
    body: '揀好就撳下面嘅生成掣。AI 生成冇可靠百分比，畫面會自動更新，唔使一直開住鏡頭。',
  },
  share: {
    title: '第 4 步：下載或分享效果',
    body: '生成完成！可以下載 PNG 或分享；圖片右上角有 RedCode 水印，分享文案會列明係 AI 試穿。',
  },
  purchase: {
    title: '第 5 步：鍾意就帶佢返屋企',
    body: '下面購買區可以逐件加購物車或即買。AI 試穿只係視覺預覽，尺寸要你自己揀返。',
  },
};

/** 已完成全部五步（撳過購買）嘅收尾文案。 */
export const FAIRY_ALL_DONE_COPY: FairyStepCopy = {
  title: '搞掂！',
  body: '已經幫你行晒五步。想試第二套，撳「開始新一套」就得；我會繼續喺度陪你。',
};

/** 首頁 helper 文案（'/' 用）。 */
export const FAIRY_HOME_COPY: FairyStepCopy = {
  title: '我係小精靈 Glo Glo',
  body: '全站我都會跟住你。想試 AI 試穿，由「開始 AI 試穿」入去，我會一步一步帶你：影相 → 揀款 → 生成 → 分享 → 購買。',
};

/** 其他頁面通用幫助文案。 */
export const FAIRY_GENERIC_COPY: FairyStepCopy = {
  title: '有咩幫到你？',
  body: '我係全站小助手。去 AI 試穿我會逐步帶路；其他問題可以睇常見問題，或者用右下 WhatsApp／Messenger 搵真人。',
};

/**
 * TryOn 真實成功事件（跨組件合約 2026-10-26 第二輪：廢除 capture-click 推測）。
 *
 * 小精靈五步進度嘅 share／purchase「已完成」只可以由真實成功時刻觸發：
 *   - TryOn.tsx downloadResult：anchor.click() 下載已開始先 dispatch 'share'
 *   - TryOn.tsx nativeShare：await navigator.share 成功先 dispatch 'share'（AbortError／失敗唔派）
 *   - TryOn.tsx WhatsApp 分享連結 onClick：真係開咗分享入口先 dispatch 'share'
 *   - TryOnPurchase.tsx addToCart：addMany 成功＋added record 更新後 dispatch 'purchase'
 *   - TryOnPurchase.tsx buyNow：validateItems＋save draft 成功、navigate 前 dispatch 'purchase'
 * 優惠碼 input、wallet switch、移出清單、容器空白位——任何 click 都唔會記做進度。
 */
export const TRYON_GUIDE_EVENT = 'redcode:tryon-guide';

export type TryOnGuideAction = 'share' | 'purchase';

/**
 * 嚴格解析 CustomEvent detail：淨係認 { action: 'share' | 'purchase' }，
 * 其他一律 null（壞資料唔可以假裝完成咗步驟）。
 */
export function parseTryOnGuideAction(detail: unknown): TryOnGuideAction | null {
  if (!detail || typeof detail !== 'object') return null;
  const action = (detail as { action?: unknown }).action;
  return action === 'share' || action === 'purchase' ? action : null;
}

/** 由成功點 dispatch 進度事件。SSR／測試環境冇 window 就靜默唔派（回傳 false）。 */
export function emitTryOnGuideAction(action: TryOnGuideAction): boolean {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  return window.dispatchEvent(new CustomEvent(TRYON_GUIDE_EVENT, { detail: { action } }));
}

/** sessionStorage key：今次唔使（關咗個 tab 先會再出現）。 */
export const FAIRY_DISMISS_KEY = 'redcode-fairy-dismissed';

/**
 * 首頁互動 → 全域小精靈聯動事件（跨組件合約 2026-10-26）。
 * 首頁互動只 dispatch，唔直接 import 全域小精靈：
 *   window.dispatchEvent(new CustomEvent('redcode:home-fairy', { detail }))
 * 小精靈收到會做可見反應（見 GlobalFairyGuide.tsx）；document.hidden／reduced-motion 會降級。
 *
 * detail 兩種詞彙都接受（首頁 trio 實際用緊 `src/lib/homeFairy.ts` 嘅版本）：
 *   - 計劃書版：{ action: 'celebrate' | 'shy', x?, y? }（x/y 係 viewport 座標，可選）
 *   - 首頁 trio 版：{ action: 'tap' | 'shy-start' | 'shy-end', source, at }
 *   對應：tap→celebrate；shy-start→shy；shy-end＝怕羞完結，唔使反應（返回 null）。
 */
export const HOME_FAIRY_EVENT = 'redcode:home-fairy';

export type HomeFairyAction = 'celebrate' | 'shy';

export interface HomeFairyReaction {
  action: HomeFairyAction;
  /** 可選：互動發生嘅 viewport 座標，小精靈可以飛埋去睇吓。 */
  x?: number;
  y?: number;
}

/**
 * 解析 CustomEvent detail（任何嚟路嘅 JSON 都可能入到嚟，所以要嚴格收窄）：
 * 認得 'celebrate'／'shy'（計劃書版）同 'tap'／'shy-start'（首頁 trio 版）；
 * 'shy-end' 係完結訊號，唔使反應；x/y 必須係 finite number 先保留。
 * 唔識嘅 detail 返回 null，組件照舊企喺度唔郁，唔會因壞資料出錯。
 */
export function parseHomeFairyReaction(detail: unknown): HomeFairyReaction | null {
  if (!detail || typeof detail !== 'object') return null;
  const raw = detail as { action?: unknown; x?: unknown; y?: unknown };
  const action: HomeFairyAction | null =
    raw.action === 'celebrate' || raw.action === 'tap'
      ? 'celebrate'
      : raw.action === 'shy' || raw.action === 'shy-start'
        ? 'shy'
        : null;
  if (!action) return null;
  const reaction: HomeFairyReaction = { action };
  if (typeof raw.x === 'number' && Number.isFinite(raw.x)) reaction.x = raw.x;
  if (typeof raw.y === 'number' && Number.isFinite(raw.y)) reaction.y = raw.y;
  return reaction;
}
