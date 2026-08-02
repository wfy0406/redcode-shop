import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appRouter } from "./router";
import { createContext } from "./context";
import { userFromAuthHeader } from "./auth";
import { exportDaily } from "./exportDaily";
import { wmsReviewCallback } from "./wmsSync";
import { serveEmptyCartOverride, serveGlogloBannerOverride, siteAssetsStatus, uploadSiteAsset } from "./adminAssets";
import { env } from "./lib/env";

const app = new Hono<{ Bindings: HttpBindings }>();

// 上傳目錄：Render Persistent Disk 會 mount 去 /app/uploads（Docker WORKDIR 係 /app，
// 預設相對路徑 "uploads" 啱啱好對應；如需其他路徑用 UPLOADS_DIR 環境變數覆寫）
const UPLOAD_DIR = process.env.UPLOADS_DIR || "uploads";
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// 每日營運數據導出（xlsx 下載）——註冊喺 tRPC mount 前，確保唔會跌入 SPA fallback
app.get("/api/export/daily", exportDaily);

// WMS → 官網審批回調（shared secret 驗證；同樣喺 tRPC mount 前註冊）
app.post("/api/wms/review-callback", wmsReviewCallback);

// 網站資產管理（staff/admin）—— 後台直接上傳 empty-cart.png / ops-template.xlsx / gloglo-3.jpg
app.get("/api/admin/site-assets", siteAssetsStatus);
app.post("/api/admin/upload-asset", uploadSiteAsset);

// 資產 runtime override：disk 有上傳版就 serve disk 版，冇就跌落 dist 靜態版
app.get("/empty-cart.png", serveEmptyCartOverride);
app.get("/gloglo-3.jpg", serveGlogloBannerOverride);

app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});

// Image upload (payment screenshots etc.) — requires Bearer JWT
app.post("/api/upload", async (c) => {
  const user = await userFromAuthHeader(c.req.header("authorization"));
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  const ext = ALLOWED_IMAGE_TYPES[file.type];
  if (!ext) {
    return c.json({ error: "Only jpg/png/webp images are allowed" }, 400);
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return c.json({ error: "File too large (max 10MB)" }, 400);
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(`${UPLOAD_DIR}/${filename}`, buffer);
  return c.json({ path: `/uploads/${filename}` });
});

// Serve uploaded files（自訂 route，支援絕對路徑 UPLOAD_DIR，兼擋 path traversal）
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
app.get("/uploads/:file", async (c) => {
  const file = c.req.param("file");
  if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return c.json({ error: "Not Found" }, 404);
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = UPLOAD_CONTENT_TYPES[ext];
  if (!contentType) {
    return c.json({ error: "Not Found" }, 404);
  }
  try {
    const data = await readFile(path.join(UPLOAD_DIR, file));
    return c.body(data, 200, { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" });
  } catch {
    return c.json({ error: "Not Found" }, 404);
  }
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  const { ensureDatabase } = await import("./boot-migrate");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // 開機自動建表 + 種子數據（失敗唔會冧 server，淨係 log）
  ensureDatabase().catch((e) => console.error("[boot-migrate] failed:", e));

  // 待付款訂單 3 天未傳付款截圖 → 自動取消（開機掃一次，之後每 30 分鐘掃；失敗淨係 log）
  const { startOrderSweeper } = await import("./orderSweeper");
  startOrderSweeper();
}
