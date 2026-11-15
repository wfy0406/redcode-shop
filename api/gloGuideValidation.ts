/**
 * Glo Glo 精選配搭指南——純邏輯校驗／閘口模組（唔掂 DB、唔掂 network）。
 *
 * SPEC v1 硬閘（iteration 4 更新）：
 * ─ 文章 NFC＋控制字元清理；title 4–80、body 150–300 Unicode code points（空白唔計）、theme 2–80。
 * ─ themeKey 對最近 8 篇非 archived 文章不可重複。
 * ─ 最少 2 件不重複商品（手動指定冇上限；自動／無指定先隨機抽 2–3 件）。
 * ─ 圖片唔再設全局 3–5 數量閘：每件已選商品最少一張 completed＋source-drift-safe
 *   （approve 時仲要逐張人工 approved＋reviewer/time 齊）嘅圖；每張圖逐張過閘。
 * ─ 所有圖片路徑只准 /uploads/glo-guide/；短期 Fashn CDN URL 絕不入公開 DTO。
 *
 * WMS handler（gloGuideWms.ts）、service（gloGuideService.ts）、公開 DTO（gloGuidePublic.ts）、
 * AI 生成驗證（gloGuideAi.ts）全部共用呢度嘅規則；測試直接抽純函數驗。
 */

import { gloGuideRichTextPlain, parseGloGuideRichText } from "@contracts/gloGuideRichText";

// ──────────────────────────── 共用錯誤型 ────────────────────────────

/**
 * Glo Glo 業務錯誤（真錯誤訊息＋HTTP status）：service／商品選擇模組 throw，
 * WMS handler／admin router 映射做 {ok:false}／tRPC code。絕不假成功。
 * 原本住喺 gloGuideService.ts；搬落純模組等商品選擇線（gloGuideProductSelection.ts）
 * 唔使同 service 循環依賴。service 仍然 re-export，舊 import 唔使改。
 */
export class GloGuideError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "GloGuideError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}


// ──────────────────────────── 文字清理／字數 ────────────────────────────

/** 控制字元：C0（\u0000–\u001F）＋DEL＋C1（\u007F–\u009F）。body 保留 \n／\t，其餘全剝。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CONTROL_CHARS_STRICT = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFC＋剝控制字元＋trim。body 用（保留換行／tab）；唔做 HTML escape——輸出端先 escape。 */
export function sanitizeGloGuideBody(value: string): string {
  return value.normalize("NFC").replace(CONTROL_CHARS, "").trim();
}

/** NFC＋剝晒控制字元（包括換行）＋trim。title／theme 用（單行欄位）。 */
export function sanitizeGloGuideLine(value: string): string {
  return value.normalize("NFC").replace(CONTROL_CHARS_STRICT, "").trim();
}

/** body 字數：先移除受控格式標記，再以 Unicode code points 計；空白唔計。 */
export function countBodyCodePoints(body: string): number {
  let n = 0;
  for (const ch of gloGuideRichTextPlain(body)) {
    if (!/\s/u.test(ch)) n++;
  }
  return n;
}

export const GLO_GUIDE_TITLE_MIN = 4;
export const GLO_GUIDE_TITLE_MAX = 80;
export const GLO_GUIDE_BODY_MIN = 150;
export const GLO_GUIDE_BODY_MAX = 300;
export const GLO_GUIDE_THEME_MIN = 2;
export const GLO_GUIDE_THEME_MAX = 80;

/** title 校驗（傳入已清理字串）；合格返 null，唔合格返中文錯誤。 */
export function validateGloGuideTitle(title: string): string | null {
  const len = [...title].length;
  if (len < GLO_GUIDE_TITLE_MIN || len > GLO_GUIDE_TITLE_MAX) {
    return `標題要 ${GLO_GUIDE_TITLE_MIN}–${GLO_GUIDE_TITLE_MAX} 字`;
  }
  return null;
}

/** theme 校驗（已清理）；合格返 null。 */
export function validateGloGuideTheme(theme: string): string | null {
  const len = [...theme].length;
  if (len < GLO_GUIDE_THEME_MIN || len > GLO_GUIDE_THEME_MAX) {
    return `主題要 ${GLO_GUIDE_THEME_MIN}–${GLO_GUIDE_THEME_MAX} 字`;
  }
  return null;
}

/** body 校驗（已清理）：格式標記先過結構閘，再計 150–300 個純文字 code points。 */
export function validateGloGuideBody(body: string): string | null {
  const markupError = parseGloGuideRichText(body).error;
  if (markupError) return `內文格式錯誤：${markupError}`;
  const len = countBodyCodePoints(body);
  if (len < GLO_GUIDE_BODY_MIN || len > GLO_GUIDE_BODY_MAX) {
    return `內文要 ${GLO_GUIDE_BODY_MIN}–${GLO_GUIDE_BODY_MAX} 字（空白唔計，而家 ${len} 字）`;
  }
  return null;
}

// ──────────────────────────── 主題去重 ────────────────────────────

/**
 * themeKey：NFC＋小寫＋剝走空白／標點／符號。換字重用（加空格、改標點、大小寫）會撞 key。
 * 係「換字」唔係「換詞」——語意改寫靠 prompt 提供近 8 主題及內容開頭避開（service 層做）。
 */
export function normalizeThemeKey(theme: string): string {
  return theme
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 最近 8 篇非 archived 文章嘅 themeKey 入面有冇撞；recentKeys 由 caller 喺 DB 攞。 */
export function themeKeyConflicts(themeKey: string, recentKeys: readonly string[]): boolean {
  return recentKeys.includes(themeKey);
}

// ──────────────────────────── 商品／圖片閘 ────────────────────────────

export const GLO_GUIDE_PRODUCT_MIN = 2;
/** 隨機抽貨上限（auto／week／date／session 無指定 productIds 時抽 2–3 件）；手動指定冇上限 */
export const GLO_GUIDE_PRODUCT_MAX = 3;

/** 服飾／飾品類（配搭指南只揀呢啲；lifestyle/skincare/other 唔入） */
export const GLO_GUIDE_CATEGORIES = ["top", "pants", "dress", "shoes", "accessory"] as const;

/** 商品揀選：最少 2 件、唔准重複 id、正整數；手動指定**冇上限**（隨機抽貨上限喺 pickRandomTwoThree）。合格返 null。 */
export function validateProductSelection(productIds: readonly number[]): string | null {
  if (productIds.length < GLO_GUIDE_PRODUCT_MIN) {
    return `最少要揀 ${GLO_GUIDE_PRODUCT_MIN} 件商品`;
  }
  if (new Set(productIds).size !== productIds.length) return "商品唔可以重複";
  for (const id of productIds) {
    if (!Number.isSafeInteger(id) || id < 1) return "商品 id 無效";
  }
  return null;
}

/** 圖片閘用嘅最小圖片事實（service 由 DB 行 map 出嚟） */
export interface GateImageFacts {
  productId: number | null;
  path: string | null;
  /** 生成嗰刻嘅商品圖 snapshot */
  sourceProductImage: string | null;
  status: string; // queued | processing | completed | failed
  reviewStatus: string; // pending | approved | rejected
  /** 圖像素尺寸（sharp 實測）；無效尺寸唔准發布（首口 aspect-ratio 會出假資料） */
  width: number | null;
  height: number | null;
  reviewedById: number | null;
  reviewedAt: Date | null;
  deletedAt: Date | null;
}

/** 商品閘用嘅最小商品事實（現行 DB 行；已刪商品 caller 唔會放入嚟） */
export interface GateProductFacts {
  id: number;
  image: string;
  isActive: boolean;
  stock: number;
  /** caller 計好：delistEnabled && delistAt && delistAt <= now（已到期自動下架） */
  delisted: boolean;
}

/**
 * 發布／提交閘：計晒所有硬條件，返錯誤字串陣列（空＝合格）。
 * options.requireImageApproval：submit 時主管可能仲未逐張批，approve 一定要 true。
 * 全部輸入由 caller 喺**同一個 transaction 重讀**攞嚟——呢度純計算。
 * input.linkedCount＝DB 關聯行數；products 淨係仲存在嘅商品——兩者唔等即係有貨被刪。
 */
export function evaluateGloGuideGate(
  input: {
    title: string;
    body: string;
    theme: string;
    status: string;
    /** 關聯行數（連已刪商品嘅行都計） */
    linkedCount: number;
    /** 已連結兼仲存在嘅商品（連現行圖／上架／庫存狀態） */
    products: readonly GateProductFacts[];
    /** 未刪圖片全部 */
    images: readonly GateImageFacts[];
  },
  options: { requireImageApproval: boolean },
): string[] {
  const errors: string[] = [];
  const titleErr = validateGloGuideTitle(input.title);
  if (titleErr) errors.push(titleErr);
  const bodyErr = validateGloGuideBody(input.body);
  if (bodyErr) errors.push(bodyErr);
  const themeErr = validateGloGuideTheme(input.theme);
  if (themeErr) errors.push(themeErr);

  // ≥2 件不重複商品（手動指定冇上限；DB unique(articleId,productId) 擋咗重複，呢度再保險）
  if (input.products.length !== input.linkedCount) {
    errors.push("有商品已被刪除，請先更新指南商品");
  }
  if (input.products.length < GLO_GUIDE_PRODUCT_MIN) {
    errors.push(`最少要連結 ${GLO_GUIDE_PRODUCT_MIN} 件商品`);
  }
  if (new Set(input.products.map((p) => p.id)).size !== input.products.length) {
    errors.push("商品唔可以重複");
  }
  // 現行商品狀態閘：上架中、有貨、未到期自動下架（刪貨／落架／缺貨都唔准發布）
  for (const p of input.products) {
    if (!p.isActive) errors.push("有商品已下架");
    if (p.delisted) errors.push("有商品已到自動下架時間");
    if (p.stock <= 0) errors.push("有商品已缺貨");
  }

  // 圖片閘（iteration 4 新用戶規則，取代舊 3–5 張全局數量閘）：
  // ─ 每件已選商品最少一張 completed＋drift-safe（approve 時仲要已人工批准）嘅圖；
  // ─ 每張圖逐張過閘（連結已選商品／path 白名單／實測尺寸／approve 時逐張 approved）；
  // ─ 未刪但未完成嘅圖唔准殘留。總張數唔再設全局上下限。
  const live = input.images.filter((img) => !img.deletedAt);
  const completed = live.filter((img) => img.status === "completed" && img.path);
  // 未刪但未完成嘅圖（failed/queued/processing）唔准殘留——唔係會令人以為「等緊就得」
  const unfinished = live.filter((img) => img.status !== "completed" || !img.path);
  if (unfinished.length > 0) {
    errors.push("有未完成／失敗嘅圖片，請先刪除或重生");
  }

  const productIds = new Set(input.products.map((p) => p.id));
  const productImageById = new Map(input.products.map((p) => [p.id, p.image]));
  const covered = new Set<number>();
  for (const img of completed) {
    // 每張圖連結其中一件已選商品
    if (img.productId === null || !productIds.has(img.productId)) {
      errors.push("有圖片冇連結已選商品");
      continue;
    }
    // source snapshot drift：商品現行圖改咗 → 呢張圖要重生（唔計入該商品嘅有效覆蓋）
    const currentImage = productImageById.get(img.productId);
    const driftSafe = !!img.sourceProductImage && img.sourceProductImage === currentImage;
    if (!driftSafe) {
      errors.push("商品原圖已更改，對應生成圖要重生");
    }
    // 圖片路徑只准站內 glo-guide 持久路徑
    if (!isGloGuideImagePath(img.path)) {
      errors.push("圖片路徑唔係站內 /uploads/glo-guide/ 持久路徑");
    }
    // 尺寸必須係實測正數（唔准出 0×0 假資料）
    if (!img.width || !img.height || img.width <= 0 || img.height <= 0) {
      errors.push("有圖片缺有效尺寸，請重生或重新上傳");
    }
    let approved = true;
    if (options.requireImageApproval) {
      // 逐張人工 approved＋reviewer/time 齊先算數
      approved = false;
      if (img.reviewStatus !== "approved") {
        errors.push("有圖片未通過人工一致性審批");
      } else if (img.reviewedById === null || !img.reviewedAt) {
        errors.push("有圖片缺審批人／審批時間紀錄");
      } else {
        approved = true;
      }
    }
    if (driftSafe && approved) covered.add(img.productId);
  }
  // 每件商品最少一張有效圖（完成＋drift-safe；approve 時要已批）
  for (const p of input.products) {
    if (!covered.has(p.id)) errors.push("每件商品最少要有一張完成圖");
  }
  return [...new Set(errors)];
}

// ──────────────────────────── 圖片路徑白名單 ────────────────────────────

/** 指南圖片唯一合法持久前綴（短期 Fashn CDN URL 永遠唔入庫／唔入 DTO） */
export const GLO_GUIDE_PATH_PREFIX = "/uploads/glo-guide/";

// ──────────────────────────── 模特兒原圖（後台管理）────────────────────────────

/**
 * 模特兒原圖唯一合法持久前綴：/uploads/glo-guide-models/<uuid>.<ext>。
 * ⚠️ 呢個目錄絕對唔公開——boot.ts 只閘 /uploads/glo-guide/:file（published 先放行），
 * 通用 /uploads/:file 又只准單層檔名，所以 glo-guide-models/* 公開永遠 404；
 * 員工預覽行 JWT tRPC base64（service readModelImageForPreview）。
 */
export const GLO_GUIDE_MODEL_IMAGE_PREFIX = "/uploads/glo-guide-models/";

/** 後台模特兒原圖上限（備用相數量；Fashn 每次淨係用預設嗰一張） */
export const GLO_GUIDE_MODEL_IMAGE_MAX = 8;

/**
 * 係咪合法嘅模特兒原圖持久路徑：<前綴><uuid>.<png|jpg|jpeg|webp>。
 * 檔名一定要係 server 產生嘅 uuid（36 字符 hex＋連字號）——唔准任意檔名／子目錄／traversal，
 * 由根本擋住「隨便指個站內路徑當模特兒相」嘅打鑊。
 */
export function isGloGuideModelImagePath(path: string | null | undefined): boolean {
  if (typeof path !== "string") return false;
  if (!path.startsWith(GLO_GUIDE_MODEL_IMAGE_PREFIX)) return false;
  const rest = path.slice(GLO_GUIDE_MODEL_IMAGE_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp)$/i.test(
    rest,
  );
}

/**
 * generateArticle 嘅 job 參數（純函數，方便測試接線）：
 * 手動 → source manual＋kind full＋key full:<publicId>；
 * 排程必須用 options 落 source auto＋kind scheduled＋slot unique key（唔係 scheduler 每 5 分鐘會重複開文）。
 */
export function resolveGenerateJobParams(
  publicId: string,
  options?: { source?: "manual" | "auto"; jobKind?: "full" | "scheduled"; idempotencyKey?: string },
): { source: "manual" | "auto"; jobKind: "full" | "scheduled"; idempotencyKey: string } {
  return {
    source: options?.source ?? "manual",
    jobKind: options?.jobKind ?? "full",
    idempotencyKey: options?.idempotencyKey ?? `full:${publicId}`,
  };
}

/** 文章可編輯狀態規則：published 指南唔准直接破壞（刪圖／改圖審批／加圖會即時令公開文缺圖）。 */
export function isArticleEditable(status: string): boolean {
  return status !== "published";
}

/**
 * published 圖片 mutation 統一閘（review/delete/upload/generate/regenerate 共用）：
 * published → 返中文錯誤訊息（caller throw 409）；其他狀態 → null 放行。
 */
export function gloGuidePublishedMutationError(action: string, status: string): string | null {
  return status === "published" ? `指南已發布，唔可以${action}；請先落架（archive）` : null;
}

/**
 * archive 狀態閘（純函數）：只有 published 可以落架；
 * 其他狀態返清楚 conflict 訊息（draft/rejected 未公開過，唔使落架；pending_review 請先 reject）。
 */
export function archiveArticleError(status: string): string | null {
  if (status === "published") return null;
  if (status === "archived") return "指南已經落咗架";
  if (status === "pending_review") return "指南仲喺審批中，請先拒絕（reject）";
  return "只有已發布（published）嘅指南可以落架";
}

/**
 * Postgres unique violation 判定（L9：用 code=23505＋constraint 名，唔齋靠 message 字串）。
 * node-pg error 有 .code／.constraint；drizzle 有時包住 original error（.cause）。
 */
export function isUniqueViolation(e: unknown, constraint: string): boolean {
  const candidates: unknown[] = [e, (e as { cause?: unknown })?.cause];
  for (const c of candidates) {
    const err = c as { code?: unknown; constraint?: unknown; message?: unknown } | null;
    if (!err || err.code !== "23505") continue;
    const name = typeof err.constraint === "string" ? err.constraint : String(err.message ?? "");
    if (name.includes(constraint)) return true;
  }
  return false;
}

/**
 * 生成結果寫入閘（H2）：published／archived 文章唔准俾背景生成冚——
 * 舊 queued job recovery 重跑都唔會換咗已發布文嘅 title/body/theme 或改佢 status。
 * 只准由 draft/pending_review/rejected 套用。
 */
export function shouldApplyGenerationToArticle(status: string): boolean {
  return status === "draft" || status === "pending_review" || status === "rejected";
}

/**
 * Job 原子認領閘（M3）：只准 queued → working（DB UPDATE ... WHERE status='queued'
 * RETURNING 做原子 claim）；in-memory set 只係額外保險，DB 先係權威。
 */
export function canClaimJobStatus(status: string): boolean {
  return status === "queued";
}

/** 係咪合法嘅站內 glo-guide 持久路徑（唔准 https://…CDN、唔准其他目錄、唔准 traversal） */
export function isGloGuideImagePath(path: string | null | undefined): boolean {
  if (typeof path !== "string") return false;
  if (!path.startsWith(GLO_GUIDE_PATH_PREFIX)) return false;
  const rest = path.slice(GLO_GUIDE_PATH_PREFIX.length);
  // 只准單層檔名（uuid.png 等），唔准再入子目錄／..／反斜線
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) return false;
  return /^[\w.-]{1,120}\.(?:png|jpe?g|webp)$/i.test(rest);
}

/**
 * 公開圖片存取閘（純函數）：/uploads/glo-guide/:file 唔係公開目錄——
 * 逐次 DB join path→image→article 之後用呢個決定放唔放行：
 * article 必須 published＋image completed/approved/未刪＋path 合法先出圖；
 * 否則一律 404（唔分「唔存在」同「未批」，防窺探審批進度）。
 */
export function evaluatePublicMediaAccess(input: {
  /** 由 URL param 砌返嘅完整 path（/uploads/glo-guide/<file>） */
  path: string;
  image: { status: string; reviewStatus: string; deletedAt: Date | null } | null;
  article: { status: string } | null;
}): boolean {
  if (!isGloGuideImagePath(input.path)) return false;
  if (!input.image || !input.article) return false;
  if (input.article.status !== "published") return false;
  if (input.image.deletedAt) return false;
  if (input.image.status !== "completed") return false;
  if (input.image.reviewStatus !== "approved") return false;
  return true;
}

// ──────────────────────────── 模特兒原圖預設規則（純函數）────────────────────────────

/** 後台列表用嘅最小模特兒相事實（service 由 DB 行 map 出嚟；淨係未刪行） */
export interface ModelImageFacts {
  id: number;
  path: string;
  isDefault: boolean;
  createdAt: Date;
}

/**
 * 新文章 modelImage snapshot 規則（純函數）：
 * ─ DB 有未刪相 → 用 isDefault 嗰張嘅 path（DB 唯一預設由 partial unique index 保證；
 *   萬一資料異常多過一張 default，取最早建立嗰張，結果穩定）；
 * ─ DB 有相但冇 default（異態，正常流程唔會出現）→ 取最早建立嗰張，source 仍係 "db"；
 * ─ DB 一張都冇 → 沿用 envRef（ENV 第一項／內建 /gloglo-3.jpg，由 caller 計），向後相容。
 * 入參 rows 必須係未刪行；回傳 ref 保證係 DB 行 path 或 envRef，唔會係空字串
 * （envRef 空＝caller bug，照樣原樣返俾上層閘口揚聲）。
 */
export function resolveModelImageDefault(
  rows: readonly ModelImageFacts[],
  envRef: string,
): { ref: string; source: "db" | "env"; imageId: number | null } {
  if (rows.length === 0) return { ref: envRef, source: "env", imageId: null };
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const def = sorted.find((r) => r.isDefault) ?? sorted[0]!;
  return { ref: def.path, source: "db", imageId: def.id };
}

/**
 * 刪除預設相之後嘅繼任規則（純函數）：
 * ─ 刪嘅唔係預設 → 唔使郁（null）；
 * ─ 刪嘅係預設＋仲有其他未刪相 → 最早建立嗰張自動升做預設（員工可以隨時再改）；
 * ─ 刪嘅係預設＋冇其他相 → null（之後新文章回落 ENV／內建預設，UI 會清晰標示）。
 */
export function modelImageDefaultAfterDelete(
  rows: readonly ModelImageFacts[],
  deletedId: number,
): number | null {
  const target = rows.find((r) => r.id === deletedId);
  if (!target || !target.isDefault) return null;
  const rest = rows
    .filter((r) => r.id !== deletedId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  return rest[0]?.id ?? null;
}

// ──────────────────────────── slug／excerpt ────────────────────────────

/**
 * slug：`glo-guide-<YYYYMMDD>-<rand4>`（rand4 由 caller 俾，確保 unique 靠 DB 撞重再試）。
 * 標題係中文，唔做假拼音；日期段令 URL 可讀兼避撞。
 */
export function buildGloGuideSlug(dateYmd: string, rand: string): string {
  const cleanRand = rand.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return `glo-guide-${dateYmd}-${cleanRand || "x"}`;
}

/** 列表 excerpt：只取純文字，唔會將 [b]／[tag] 等格式標記洩到搜尋摘要。 */
export function gloGuideExcerpt(body: string, maxLen = 120): string {
  const chars = [...gloGuideRichTextPlain(body).replace(/\s+/g, " ").trim()];
  if (chars.length <= maxLen) return chars.join("");
  return `${chars.slice(0, maxLen).join("")}…`;
}

// ──────────────────────────── WMS actor／請求校驗 ────────────────────────────

/** WMS 員工角色白名單（其他→400） */
export const GLO_GUIDE_ACTOR_ROLES = ["staff", "supervisor", "admin"] as const;
export type GloGuideActorRole = (typeof GLO_GUIDE_ACTOR_ROLES)[number];

export interface GloGuideActor {
  id: number;
  name: string;
  role: GloGuideActorRole;
}

/**
 * actor 校驗：name 1–64、role 白名單（staff/supervisor/admin）。
 * id 規則：staff/supervisor 要正整數 ≥1；**id=0 僅限 role=admin**（WMS 內建管理員——
 * WMS server 係唯一砌 actor 嘅地方，client 唔准傳 role，唔係開權限洞）。
 * 合格返 actor，唔合格返 null。
 */
export function parseGloGuideActor(value: unknown): GloGuideActor | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = v.id;
  const name = typeof v.name === "string" ? v.name.trim() : "";
  const role = v.role;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id > 2147483647) {
    return null;
  }
  if (!name || name.length > 64) return null;
  if (!GLO_GUIDE_ACTOR_ROLES.includes(role as GloGuideActorRole)) return null;
  // id=0 只係內建管理員；staff/supervisor 必須係真員工 id ≥1
  if (id === 0 && role !== "admin") return null;
  if (role === "admin" && id === 0) return { id: 0, name, role: "admin" };
  if (id < 1) return null;
  return { id, name, role: role as GloGuideActorRole };
}

/** 文章 approve／reject／archive 及逐圖 review 只 supervisor/admin；其他 action 三級員工皆可 */
export const GLO_GUIDE_SUPERVISOR_ACTIONS = [
  "article.approve",
  "article.reject",
  "article.archive",
  "image.review",
] as const;

export function actionNeedsSupervisor(action: string): boolean {
  return GLO_GUIDE_SUPERVISOR_ACTIONS.includes(
    action as (typeof GLO_GUIDE_SUPERVISOR_ACTIONS)[number],
  );
}

/** 合法 action 清單（白名單；唔喺度嘅 action → 400） */
export const GLO_GUIDE_ACTIONS = [
  "products.list",
  // 商品來源概覽（星期／場次選項＋合資格數；三級員工皆可查）
  "products.sources",
  "article.list",
  "article.get",
  "article.generate",
  "article.regenerate",
  "article.update",
  "article.submit",
  "article.approve",
  "article.reject",
  // 落架（只 supervisor/admin）：published → archived，公開 DTO／media／sitemap 即時停
  "article.archive",
  "image.generate",
  "image.upload",
  "image.delete",
  "image.review",
  // WMS 內部預覽：server 讀本地檔回 base64（公開 /uploads/glo-guide 只放行已發布）
  "image.read",
] as const;
export type GloGuideAction = (typeof GLO_GUIDE_ACTIONS)[number];

export function isGloGuideAction(action: unknown): action is GloGuideAction {
  return (
    typeof action === "string" &&
    (GLO_GUIDE_ACTIONS as readonly string[]).includes(action)
  );
}

// ──────────────────────────── 香港曆日／週工具（純函數）────────────────────────────

export interface HkDateParts {
  /** YYYYMMDD */
  ymd: string;
  /** 0＝週一 … 6＝週日（ISO weekday） */
  weekday: number;
  /** 0–23（香港小時） */
  hour: number;
}

/** 香港而家嘅日期／週幾／鐘點（Intl formatToParts，唔靠字串格式） */
export function hkParts(now: Date = new Date()): HkDateParts {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    ymd: `${get("year")}${get("month")}${get("day")}`,
    weekday: WEEKDAY[get("weekday")] ?? 0,
    hour: Number.parseInt(get("hour"), 10) || 0,
  };
}

/** ymd（YYYYMMDD）加 n 日；用 UTC  midday 避 DST 邊界（香港冇 DST，純日期運算） */
export function addDaysYmd(ymd: string, days: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const t = Date.UTC(y, m - 1, d, 12) + days * 86_400_000;
  const out = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${out.getUTCFullYear()}${p(out.getUTCMonth() + 1)}${p(out.getUTCDate())}`;
}

/**
 * 香港本週（週一至週日）嘅 liveDate 範圍（YYYYMMDD 字串，lexicographic 可比）。
 * 「本週貨」＝liveDate 喺 [start, end] 入面。
 */
export function hkWeekRangeYmd(now: Date = new Date()): { start: string; end: string } {
  const { ymd, weekday } = hkParts(now);
  return { start: addDaysYmd(ymd, -weekday), end: addDaysYmd(ymd, 6 - weekday) };
}

/** 排程 slot：香港週一／週五嘅指定小時（預設 09:00）；同一日遲過 slot 重啟可補跑 */
export function gloGuideSlotKey(ymd: string): string {
  return `glo-guide:scheduled:${ymd}`;
}

/** 呢刻係咪應該跑排程 slot（週一/週五 兼 香港鐘點 ≥ slot hour；同一日遲到都補） */
export function isGloGuideSlotDue(parts: HkDateParts, slotHour: number): boolean {
  return (parts.weekday === 0 || parts.weekday === 4) && parts.hour >= slotHour;
}
