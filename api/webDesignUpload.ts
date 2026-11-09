/**
 * 網站設計服務——訪客付款證明圖片上傳 REST handler（v2026.11.09）。
 * Lead 會喺 boot 註冊：`app.post("/api/web-design/upload", webDesignProofUpload)`（正式路徑凍結）。
 *
 * tokenless 三欄核實（orderNo＋完整姓名＋電話）先准上傳：
 * - rate limit：同一 IP 每小時 10 次（契約 v1.0 寬鬆口徑）；
 * - 5MB 上限；淨收 jpg／png／webp；唔信 client MIME——sharp 讀真檔頭驗圖，re-encode 剝 metadata；
 * - 隨機不可猜檔名（randomUUID）；寫死喺 UPLOAD_DIR 根目錄，path traversal 無從入手；
 * - 三欄唔啱 → 統一 404 訊息（防單號枚舉）。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { webDesignOrders } from "@db/schema";
import { RateLimiter, clientIpFromRequest } from "./guestUtils";
import {
  WEB_DESIGN_LOOKUP_FAIL_MESSAGE,
  isWebDesignOrderNo,
  validateLookupInput,
} from "./webDesignCore";

const UPLOAD_DIR = process.env.UPLOADS_DIR || "uploads";
const MAX_PROOF_SIZE = 5 * 1024 * 1024; // 5MB（契約）
const uploadLimiter = new RateLimiter(10, 60 * 60 * 1000);

export async function webDesignProofUpload(c: Context) {
  if (!uploadLimiter.allow(clientIpFromRequest(c.req.raw))) {
    return c.json({ error: "操作太頻密，請一個鐘後再試" }, 429);
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "需要 multipart/form-data" }, 400);
  }
  const orderNo = String(form.get("orderNo") ?? "").trim();
  const name = String(form.get("name") ?? "");
  const phone = String(form.get("phone") ?? "");
  // 三欄格式／前綴基本檢查（唔通都係統一 404，唔分開話邊欄錯）
  const id = validateLookupInput(name, phone);
  if (!id || !isWebDesignOrderNo(orderNo)) {
    return c.json({ error: WEB_DESIGN_LOOKUP_FAIL_MESSAGE }, 404);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  if (file.size > MAX_PROOF_SIZE) {
    return c.json({ error: "圖片太大（上限 5MB）" }, 400);
  }
  const raw = Buffer.from(await file.arrayBuffer());
  // sharp 讀檔頭驗真身（limitInputPixels 擋解壓炸彈）；動態 import，同 /api/upload 一致
  let verified: { pipeline: import("sharp").Sharp; format: string } | null = null;
  try {
    const sharp = (await import("sharp")).default;
    const pipeline = sharp(raw, { limitInputPixels: 25_000_000 });
    const format = (await pipeline.metadata()).format ?? "";
    if (format === "jpeg" || format === "png" || format === "webp") {
      verified = { pipeline, format };
    }
  } catch {
    verified = null;
  }
  if (!verified) {
    return c.json({ error: "檔案唔係有效圖片（只接受 jpg／png／webp）" }, 400);
  }

  // 三欄核實：orderNo＋完整姓名＋normalized 電話全中先收圖（統一 404 防枚舉）
  const db = getDb();
  const order = await db.query.webDesignOrders.findFirst({
    where: and(
      eq(webDesignOrders.orderNo, orderNo),
      eq(webDesignOrders.name, id.name),
      eq(webDesignOrders.phone, id.phone),
    ),
    columns: { id: true, status: true, paymentStatus: true },
  });
  if (!order) {
    return c.json({ error: WEB_DESIGN_LOOKUP_FAIL_MESSAGE }, 404);
  }
  if (order.status === "cancelled") {
    return c.json({ error: "呢張訂單已取消，唔可以再上傳付款證明" }, 409);
  }
  if (order.paymentStatus !== "pending" && order.paymentStatus !== "rejected") {
    return c.json({ error: "呢張訂單而家唔係待付款狀態" }, 409);
  }

  const { pipeline, format } = verified;
  const outExt = format === "jpeg" ? ".jpg" : format === "png" ? ".png" : ".webp";
  let out: Buffer;
  try {
    // rotate() 跟 EXIF 轉正；re-encode 順便剝走 EXIF／GPS metadata
    const oriented = pipeline.rotate();
    out =
      format === "jpeg"
        ? await oriented.jpeg({ quality: 85 }).toBuffer()
        : format === "png"
          ? await oriented.png({ compressionLevel: 9 }).toBuffer()
          : await oriented.webp({ quality: 85 }).toBuffer();
  } catch {
    return c.json({ error: "圖片處理失敗，請轉做 jpg／png 再試" }, 400);
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `wdproof-${randomUUID()}${outExt}`;
  await writeFile(path.join(UPLOAD_DIR, filename), out);
  return c.json({ path: `/uploads/${filename}` });
}
