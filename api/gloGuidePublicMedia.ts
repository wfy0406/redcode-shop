/**
 * Glo Glo 指南——公開圖片存取閘（GET /uploads/glo-guide/:file）。
 *
 * /uploads/glo-guide/ 唔係公開目錄：知道檔名都唔准直讀未批內容。
 * 每個 request 逐次 DB join path→image→article，用 evaluatePublicMediaAccess 判定：
 * article published＋image completed/approved/未刪＋path 合法先出圖；
 * 其餘一律 404（唔分「唔存在」同「未批」，防窺探審批進度）＋ X-Robots-Tag noindex ＋ no-store。
 * 成功回應都係 no-cache, must-revalidate——文章 archive／圖片落閘後唔會有 cache 殘留。
 * WMS 內部預覽行另一條路：POST /api/wms/glo-guide 嘅 image.read action（secret 閘）。
 */
import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import pathModule from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { gloGuideArticles, gloGuideImages } from "@db/schema";
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

function deny(c: Context) {
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  return c.json({ error: "Not Found" }, 404);
}

export async function gloGuidePublicMedia(c: Context) {
  const file = c.req.param("file") ?? "";
  // param 單段；再驗一次完整 path 合法性（擋 traversal／子目錄／奇怪副檔名）
  const fullPath = `${GLO_GUIDE_PATH_PREFIX}${file}`;
  const ext = pathModule.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return deny(c);

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
  try {
    const data = await readFile(pathModule.join(dir, "glo-guide", file));
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": mime,
      // 成功都唔准長 cache：archive／撤回批准後下一個 request 即刻擋
      "Cache-Control": "no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    });
  } catch {
    return deny(c);
  }
}
