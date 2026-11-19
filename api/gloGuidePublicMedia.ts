/**
 * Glo Glo 指南——公開圖片存取閘（GET /uploads/glo-guide/:file）。
 *
 * /uploads/glo-guide/ 唔係公開目錄：知道檔名都唔准直讀未批內容。
 * 每個 request 逐次 DB join path→image→article，用 evaluatePublicMediaAccess 判定：
 * article published＋image completed/approved/未刪＋path 合法先出圖；
 * 其餘一律 404（唔分「唔存在」同「未批」，防窺探審批進度）＋ X-Robots-Tag noindex ＋ no-store。
 *
 * R05 多尺寸 derivative（2026-11-19）：
 * ─ `?w=<320|480|768|1080|1600>&fmt=<avif|webp>` 出 derivative；冇 query 出原圖（向後相容）。
 * ─ 參數白名單由 @contracts/gloGuide parseGloGuideDerivativeQuery 收口；非法 → 同 404。
 * ─ **權限閘永遠先行**：derivative 同原圖行同一個 evaluatePublicMediaAccess；撤稿／落閘後
 *   一律 404＋no-store，304 亦只會喺閘通過之後先出現（fail-closed 唔受 validator 影響）。
 * ─ 衍生檔 disk cache 喺 UPLOADS_DIR/glo-guide/.deriv/（uuid 檔名即內容版本，唔使失效機制）；
 *   tmp＋rename 原子寫入，同檔並發請求共用同一份生成 promise。
 * ─ sharp 失敗（壞圖／缺依賴）唔會 500：log 完落回原圖 bytes，可用性優先。
 *
 * Cache 策略（撤稿安全版「合理 cache」）：成功回應 no-cache, must-revalidate＋弱 ETag——
 * 瀏覽器／CDN 可以 cache 但每個 view 都要同 server 對版（304 慳頻寬），撤稿即時 404，
 * 唔會有 max-age 窗口期內洩漏未授權媒體。拒絕回應一律 no-store。
 * WMS 內部預覽行另一條路：POST /api/wms/glo-guide 嘅 image.read action（secret 閘）。
 */
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import pathModule from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { gloGuideArticles, gloGuideImages } from "@db/schema";
import {
  parseGloGuideDerivativeQuery,
  type GloGuideDerivativeSpec,
} from "@contracts/gloGuide";
import {
  evaluatePublicMediaAccess,
  GLO_GUIDE_PATH_PREFIX,
} from "./gloGuideValidation";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const DERIVATIVE_MIME: Record<GloGuideDerivativeSpec["format"], string> = {
  avif: "image/avif",
  webp: "image/webp",
};

/** 衍生檔子目錄（公開閘只放單層檔名，呢個目錄永遠唔會被直讀） */
const DERIVATIVE_DIRNAME = ".deriv";

/** 同一张 derivative 嘅並發請求共用一次生成（server 重啟自然清零，唔使持久鎖） */
const inflightDerivatives = new Map<string, Promise<void>>();

function deny(c: Context) {
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  return c.json({ error: "Not Found" }, 404);
}

/**
 * 確保 derivative 檔存在：命中 disk cache 即用；否則 sharp 由原圖縮放轉碼
 * （rotate 食 EXIF、withoutEnlargement 唔放大），tmp＋rename 原子落盤。
 * 回傳 null 代表「生成唔到」（caller 落回原圖）；異常會喺度 log 唔會向上 throw。
 */
async function ensureGloGuideDerivative(
  originalAbsolute: string,
  file: string,
  spec: GloGuideDerivativeSpec,
): Promise<{ absolute: string; mime: string } | null> {
  const mime = DERIVATIVE_MIME[spec.format];
  const parsed = pathModule.parse(file);
  const name = `${parsed.name}-w${spec.width}.${spec.format}`;
  const dir = pathModule.join(pathModule.dirname(originalAbsolute), DERIVATIVE_DIRNAME);
  const absolute = pathModule.join(dir, name);
  // 雙重保險：衍生檔位置唔准溢出 .deriv 目錄
  if (pathModule.dirname(absolute) !== dir) return null;

  try {
    const cached = await stat(absolute);
    if (cached.isFile() && cached.size > 0) return { absolute, mime };
  } catch {
    // 未生成——下面補
  }

  let inflight = inflightDerivatives.get(absolute);
  if (!inflight) {
    inflight = (async () => {
      const sharp = (await import("sharp")).default;
      let pipeline = sharp(originalAbsolute, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: spec.width, withoutEnlargement: true });
      pipeline =
        spec.format === "avif"
          ? pipeline.avif({ quality: 50, effort: 3 })
          : pipeline.webp({ quality: 78 });
      const data = await pipeline.toBuffer();
      await mkdir(dir, { recursive: true });
      const tmp = pathModule.join(dir, `.tmp-${randomUUID()}-${name}`);
      try {
        await writeFile(tmp, data, { mode: 0o644 });
        await rename(tmp, absolute);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    })().finally(() => {
      inflightDerivatives.delete(absolute);
    });
    inflightDerivatives.set(absolute, inflight);
  }

  try {
    await inflight;
    return { absolute, mime };
  } catch (error) {
    console.error("[glo-guide] derivative 生成失敗（落回原圖）:", error);
    return null;
  }
}

export async function gloGuidePublicMedia(c: Context) {
  const file = c.req.param("file") ?? "";
  // param 單段；再驗一次完整 path 合法性（擋 traversal／子目錄／奇怪副檔名）
  const fullPath = `${GLO_GUIDE_PATH_PREFIX}${file}`;
  const ext = pathModule.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return deny(c);
  // derivative query 白名單：非法一律當 404（唔分「唔存在」同「參數錯」）
  const derivative = parseGloGuideDerivativeQuery(c.req.query("w"), c.req.query("fmt"));
  if (derivative === null) return deny(c);

  try {
    const db = getDb();
    const image = await db.query.gloGuideImages.findFirst({
      where: and(eq(gloGuideImages.path, fullPath), isNull(gloGuideImages.deletedAt)),
    });
    const article = image
      ? await db.query.gloGuideArticles.findFirst({
          where: eq(gloGuideArticles.id, image.articleId),
          columns: { id: true, status: true },
        })
      : null;
    if (
      !evaluatePublicMediaAccess({
        path: fullPath,
        image: image
          ? { status: image.status, reviewStatus: image.reviewStatus, deletedAt: image.deletedAt }
          : null,
        article: article ? { status: article.status } : null,
      })
    ) {
      return deny(c);
    }
  } catch (e) {
    // DB 故障 fail-closed：唔會因為查唔到而放行未批內容
    console.error("[glo-guide] 公開圖片閘查詢失敗:", e);
    return deny(c);
  }

  const dir = process.env.UPLOADS_DIR || "uploads";
  const originalAbsolute = pathModule.join(dir, "glo-guide", file);
  let serveAbsolute = originalAbsolute;
  let serveMime = mime;
  if (derivative) {
    const derived = await ensureGloGuideDerivative(originalAbsolute, file, derivative);
    if (derived) {
      serveAbsolute = derived.absolute;
      serveMime = derived.mime;
    }
    // 生成失敗 → serveAbsolute 維持原圖（上面已 log），可用性優先
  }

  try {
    // 弱 ETag（size＋mtime）：內容版本由 uuid 檔名保證，mtime 只係 validator。
    // 304 只喺權限閘通過之後先到——撤稿後同一 ETag 都會被閘截落 404。
    const fileStat = await stat(serveAbsolute);
    if (!fileStat.isFile()) return deny(c);
    const etag = `W/"${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}"`;
    const headers: Record<string, string> = {
      // 成功都唔准長 cache：archive／撤回批准後下一個 request 即刻擋；
      // ETag 令對版變 304，頻寬慳返但撤稿零窗口期。
      "Cache-Control": "no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      ETag: etag,
    };
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, headers);
    }
    const data = await readFile(serveAbsolute);
    return c.body(new Uint8Array(data), 200, {
      ...headers,
      "Content-Type": serveMime,
    });
  } catch {
    return deny(c);
  }
}
