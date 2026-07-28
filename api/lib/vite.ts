import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  // 2026-07-29 快取策略修復（首頁中段隱形嘅根因）：
  // 之前所有回應都冇 Cache-Control，瀏覽器會用 heuristic caching 長期揸住舊 index.html
  // → 舊 HTML 指去舊 bundle → 舊 reveal bug 喺用戶部機「自癒唔到」，點刷新都係舊版。
  // 而家：任何 HTML 回應一律 no-cache（每次同 server 對版，有新即攞）；
  // Vite build 出嚟嘅 /assets/* 檔名帶內容 hash，名唔變即內容唔變，安心 immutable 長 cache。
  app.use("*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    } else if ((c.res.headers.get("Content-Type") ?? "").includes("text/html")) {
      c.header("Cache-Control", "no-cache, must-revalidate");
    }
  });

  app.use("*", serveStatic({ root: "./dist/public" }));

  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    const content = fs.readFileSync(indexPath, "utf-8");
    return c.html(content);
  });
}
