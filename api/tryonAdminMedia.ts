import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { tryOnJobs, users } from "@db/schema";
import { userFromAuthHeader } from "./auth";
import { logAudit } from "./audit";
import { env } from "./lib/env";
import {
  readTryOnAdminArchive,
  tryOnAdminArchiveAvailable,
  verifyTryOnAdminArchiveSignature,
} from "./tryonAdminArchive";
import {
  detectTryOnImageMime,
  tryOnOutputForDisplay,
  type TryOnMediaKind,
} from "./tryonMedia";

function notFound(c: Context): Response {
  return c.json({ error: "Not Found" }, 404);
}

function imageResponse(c: Context, publicId: string, kind: TryOnMediaKind, bytes: Buffer): Response {
  const contentType = detectTryOnImageMime(bytes);
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": contentType,
    // 後台私人副本：絕唔可以入任何 cache（browser／CDN／shared proxy）
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Disposition": `inline; filename="tryon-admin-${publicId}-${kind}.${contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"}"`,
  });
}

/**
 * 後台 30 日私人副本查看（supervisor／admin 專用，2026-10-27）
 * ────────────────────────────────────────────────────────
 * GET /api/admin/tryon-media/:publicId/:kind?e=...&s=...
 *
 * 每個 request 全部重新核對，冇任何一關可以靠 cache／舊狀態：
 * 1. admin-archive 專用 HMAC（scope 同客戶私人／分享完全分開；不含 userId，最長 15 分鐘）
 * 2. Bearer JWT 登入
 * 3. 以 PK 即時查 DB 最新 role——只 supervisor／admin 放行；
 *    staff／member／未登入／已降職（JWT role 同 DB 唔符）全部拒絕
 * 4. 30 日保留只按 tryOnJobs.createdAt：createdAt + 30 日 > now 先睇到，到期一律 410；
 *    完全唔掛客戶嘅 expiresAt／mediaDeletedAt——客戶刪除咗私人圖，後台副本照樣睇到
 * 5. output 回應時即場加展示水印（stored 乾淨副本唔改寫）；成功讀圖寫 audit
 */
export async function tryOnAdminMedia(c: Context): Promise<Response> {
  const publicId = c.req.param("publicId") ?? "";
  const rawKind = c.req.param("kind") ?? "";
  if (rawKind !== "input" && rawKind !== "output") return notFound(c);
  const kind: TryOnMediaKind = rawKind;

  // ① admin-archive scope HMAC（錯簽名／過期／異常時效一律 404，唔洩露存在性）
  const expires = Number(c.req.query("e"));
  const supplied = c.req.query("s") ?? "";
  if (
    !verifyTryOnAdminArchiveSignature({
      publicId,
      kind,
      expires,
      supplied,
      secret: env.appSecret,
    })
  ) {
    return notFound(c);
  }

  // ② Bearer JWT
  const user = await userFromAuthHeader(c.req.header("authorization"));
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = getDb();

  // ③ 每 request 以 PK 查 DB 最新 role（唔信 JWT 快照）：帳號已刪 → 401；
  //    role 有變（降職／改職）→ 403；最終只有 supervisor／admin 可以睇私人副本。
  const [account] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, user.userId))
    .limit(1);
  if (!account) return c.json({ error: "Unauthorized" }, 401);
  const dbRole = account.role as typeof user.role;
  if (dbRole !== user.role) return c.json({ error: "帳號權限已變更，請重新登入" }, 403);
  if (dbRole !== "supervisor" && dbRole !== "admin") {
    return c.json({ error: "需要主管或管理員權限" }, 403);
  }

  // ④ 30 日保留 boundary：只按 createdAt，唔睇客戶 expiresAt／mediaDeletedAt
  const [job] = await db
    .select({ id: tryOnJobs.id, createdAt: tryOnJobs.createdAt })
    .from(tryOnJobs)
    .where(eq(tryOnJobs.publicId, publicId))
    .limit(1);
  if (!job) return notFound(c);
  if (!tryOnAdminArchiveAvailable(job.createdAt)) {
    return c.json({ error: "Media expired" }, 410);
  }

  // ⑤ 讀後台副本；output 即場加展示水印。副本唔存在（從未備份／已被 sweeper 清走）→ 404。
  try {
    const storedBytes = await readTryOnAdminArchive(publicId, kind);
    const bytes = kind === "output" ? await tryOnOutputForDisplay(storedBytes) : storedBytes;
    await logAudit({
      actorId: user.userId,
      actorRole: dbRole,
      action: "tryon.adminMediaView",
      targetType: "tryonJob",
      targetId: publicId,
      detail: `後台查看試穿${kind === "input" ? "原相" : "生成圖"}（30 日私人副本，job #${job.id}）`,
    });
    return imageResponse(c, publicId, kind, bytes);
  } catch {
    return notFound(c);
  }
}
