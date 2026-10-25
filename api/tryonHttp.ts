import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { tryOnJobs } from "@db/schema";
import { env } from "./lib/env";
import {
  deleteTryOnMedia,
  detectTryOnImageMime,
  readTryOnMedia,
  verifyTryOnMediaSignature,
  type TryOnMediaKind,
} from "./tryonMedia";

function notFound(c: Context): Response {
  return c.json({ error: "Not Found" }, 404);
}

/**
 * 私人原相／結果：短期 HMAC 只係通行證，DB owner＋job 狀態＋到期仍要逐次核對。
 * 唔使用公開 /uploads/:file，唔回 public cache，亦唔會將 supplier job id 暴露畀瀏覽器。
 */
export async function tryOnPrivateMedia(c: Context): Promise<Response> {
  const publicId = c.req.param("publicId") ?? "";
  const rawKind = c.req.param("kind") ?? "";
  if (rawKind !== "input" && rawKind !== "output") return notFound(c);
  const kind: TryOnMediaKind = rawKind;
  const userId = Number(c.req.query("u"));
  const expires = Number(c.req.query("e"));
  const supplied = c.req.query("s") ?? "";
  if (
    !verifyTryOnMediaSignature({
      publicId,
      kind,
      userId,
      expires,
      supplied,
      secret: env.appSecret,
    })
  ) {
    return notFound(c);
  }

  const db = getDb();
  const [job] = await db
    .select({
      id: tryOnJobs.id,
      publicId: tryOnJobs.publicId,
      status: tryOnJobs.status,
      inputImagePath: tryOnJobs.inputImagePath,
      outputImagePath: tryOnJobs.outputImagePath,
      expiresAt: tryOnJobs.expiresAt,
      mediaDeletedAt: tryOnJobs.mediaDeletedAt,
    })
    .from(tryOnJobs)
    .where(and(eq(tryOnJobs.publicId, publicId), eq(tryOnJobs.userId, userId)))
    .limit(1);
  if (!job || job.mediaDeletedAt) return notFound(c);

  if (job.expiresAt.getTime() <= Date.now()) {
    if (job.status === "completed" || job.status === "failed") {
      try {
        await deleteTryOnMedia(publicId);
        await db.update(tryOnJobs).set({ mediaDeletedAt: new Date(), updatedAt: new Date() }).where(eq(tryOnJobs.id, job.id));
      } catch {
        // 保留未刪狀態俾 sweeper 重試；呢次存取仍因到期而拒絕。
      }
    }
    return c.json({ error: "Media expired" }, 410);
  }
  if (kind === "input" && !job.inputImagePath) return notFound(c);
  if (kind === "output" && (job.status !== "completed" || !job.outputImagePath)) return notFound(c);

  try {
    const bytes = await readTryOnMedia(publicId, kind);
    const contentType = detectTryOnImageMime(bytes);
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": contentType,
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Disposition": `inline; filename="tryon-${publicId}-${kind}.${contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"}"`,
    });
  } catch {
    return notFound(c);
  }
}
