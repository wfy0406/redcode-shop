import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";
import {
  injectPublicSeoContent,
  LUCKY_EVENT_SEO,
  PUBLIC_PAGES,
  stripPublicSeoContent,
} from "./publicSeo";

type App = Hono<{ Bindings: HttpBindings }>;

// 公開頁 meta／無 JS 內容統一由 publicSeo.ts 提供；server 首口 HTML 同 sitemap
// 使用同一路由事實來源，避免 canonical、sitemap 同實際頁面互相打架。

// 私人/工具頁：唔入搜尋索引，robots 改 noindex, nofollow（title/description 照預設）
const NOINDEX_EXACT = [
  "/cart",
  "/checkout",
  "/account",
  "/orders",
  "/payment",
  "/login",
  "/register",
  "/vip-verify",
  "/guest-checkout",
  "/guest-payment",
  "/wallet-topup",
  "/try-on/history",
];

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  // 2026-07-29 快取策略修復（首頁中段隱形嘅根因）：
  // 之前所有回應都冇 Cache-Control，瀏覽器會用 heuristic caching 長期揸住舊 index.html
  // → 舊 HTML 指去舊 bundle → 舊 reveal bug 喺用戶部機「自癒唔到」，點刷新都係舊版。
  // 而家：任何 HTML 回應一律 no-cache（每次同 server 對版，有新即攞）；
  // Vite build 出嚟嘅 /assets/* 檔名帶內容 hash，名唔變即內容唔變，安心 immutable 長 cache。
  app.use("*", async (c, next) => {
    await next();
    // llms.txt 係輔助內容地圖，唔係要出現喺搜尋結果嘅文件。
    if (c.req.path === "/llms.txt") {
      c.header("X-Robots-Tag", "noindex");
    }
    if (c.req.path === "/sw.js") {
      // Service Worker 更新唔可以等 heuristic cache；每次都同 server 對版。
      c.header("Cache-Control", "no-cache, must-revalidate");
    } else if (c.req.path.startsWith("/assets/")) {
      // 2026-08-04 白屏根治：存在嘅 hash 檔 → immutable；**唔存在嘅（404）→ no-store**。
      // 之前舊部署消失咗嘅 chunk 會落入 notFound 回 index.html（200）＋被呢度加 immutable，
      // 瀏覽器將「HTML 扮 JS」cache 足一年 → 部署後白屏點刷新都唔好嘅真正根因。
      if (c.res.status === 404) {
        c.header("Cache-Control", "no-store");
      } else {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    } else if ((c.res.headers.get("Content-Type") ?? "").includes("text/html")) {
      c.header("Cache-Control", "no-cache, must-revalidate");
    }
  });

  app.use("*", serveStatic({ root: "./dist/public" }));

  app.notFound(async (c) => {
    // 2026-08-04 白屏根治：靜態資源路徑（/assets/* 或常見資源副檔名）搵唔到 →
    // 回真 404，**絕對唔好回 index.html**。否則瀏覽器攞舊 chunk 時會收到 HTML（200），
    // 當 JS 執行即 SyntaxError 全黑，仲會將呢個壞回應 cache 埋。
    const reqPath = c.req.path;
    if (
      reqPath.startsWith("/assets/") ||
      /\.(js|mjs|css|map|png|jpe?g|webp|svg|gif|woff2?|ttf|otf|ico)$/i.test(reqPath)
    ) {
      return c.json({ error: "Not Found" }, 404);
    }
    const accept = c.req.header("accept") ?? "";
    // 2026-07-29 FB 分享灰盒根因：Facebook/WhatsApp 等 crawler 送嘅 Accept 係 */*
    // （唔係 text/html），舊檢查會回 404 JSON → FB 讀唔到 OG，淨係顯示域名。
    // 而家 */* 同冇 Accept 都照出 HTML；淨係明確非 HTML 嘅請求先回 JSON 404。
    if (accept && !accept.includes("text/html") && !accept.includes("*/*")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    let content = fs.readFileSync(indexPath, "utf-8");
    // 2026-07-29 白頁根因：build 出嚟嘅 HTML 用相對路徑（./assets/...，為 static
    // preview 而設），喺兩段以上路徑（如 /products/24）會解錯做 /products/assets
    // → JS/CSS 404 → 全白頁。加 <base href="/"> 令相對路徑由根目錄起計；
    // 淨係改 server 出嘅 HTML，source index.html 唔郁，static preview 唔受影響。
    content = content.replace("<head>", `<head>\n    <base href="/" />`);
    // index.html 自帶首頁無 JS 摘要；落入路由 fallback 就先移除，再按實際頁面注入。
    content = stripPublicSeoContent(content);
    // 2026-07-29 商品分享 OG：App 係 HashRouter（#/products/123），但 Facebook 等
    // crawler 收唔到 hash 後面嘅嘢，所以分享連結用正式路徑 /products/123。
    // 喺度見到呢條 path 就注入該商品嘅 OG meta；人類訪客入到嚟，
    // main.tsx 會即刻轉返 hash 路由，照常顯示商品頁。
    const productMatch = c.req.path.match(/^\/products\/(\d+)\/?$/);
    if (productMatch) {
      const { injectProductOg, injectRouteMeta } = await import("./og");
      // Render 反向代理後面 c.req.url 係 http://，OG 圖必須 https 先會被 FB 接受：
      // 用 x-forwarded-proto/host 還原訪客真正嘅 origin
      const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
      const injected = await injectProductOg(content, Number(productMatch[1]), `${proto}://${host}`);
      if (injected === null) {
        // 2026-10-27 Search Console 軟 404 根治：商品**確定唔存在**（DB 查詢成功、零行，
        // 例如已刪嘅 /products/94）——之前回 200＋首頁 title/canonical，Google 當軟 404。
        // 而家回真 404 狀態＋noindex；HTML 照出 SPA，前端 ProductDetail 會顯示
        // 「搵唔到呢件商品」頁，人類訪客體驗唔變。
        // DB 一時故障 injectProductOg 會回未注入嘅 html（唔係 null），在架商品唔會被誤 404。
        const notFoundHtml = injectRouteMeta(content, {
          title: "搵唔到呢件商品｜RedCode Fashion Design",
          description: "呢件商品可能已經賣晒或落架，去全部貨品睇最新直播精選女裝。",
          noindex: true,
        });
        return c.html(notFoundHtml, 404);
      }
      content = injected;
    } else {
      // 公開頁注入專屬 meta＋無 JS 內容；私人／有時限分享頁 noindex；
      // 未知路徑回真 404，避免任何字串都變成首頁嘅軟 404。
      const { injectRouteMeta } = await import("./og");
      const normPath = reqPath.length > 1 ? reqPath.replace(/\/+$/, "") : reqPath;
      const isLuckyEvent = /^\/lucky-results\/\d+$/.test(normPath);
      const publicPath = isLuckyEvent ? "/lucky-results" : normPath;
      const pageSeo = isLuckyEvent ? LUCKY_EVENT_SEO : PUBLIC_PAGES[publicPath];
      if (normPath === "/products") {
        // 直播節目頁保留有效日期／場次嘅專屬 canonical；無效參數唔反射入 HTML。
        const { liveRouteMeta } = await import("./liveSeo");
        const q = new URL(c.req.url).searchParams;
        const liveMeta = liveRouteMeta(q.get("liveDate"), q.get("liveSession"));
        content = injectRouteMeta(content, liveMeta ?? { ...PUBLIC_PAGES["/products"], path: "/products" });
        content = injectPublicSeoContent(content, "/products");
        if (!liveMeta) {
          try {
            const { injectPublicCatalog, listPublicCatalog } = await import("./catalogSeo");
            content = injectPublicCatalog(content, await listPublicCatalog());
          } catch {
            // DB 一時故障照出通用公開摘要；唔好將在架商品頁誤報做空目錄或 404。
          }
        }
      } else if (pageSeo) {
        content = injectRouteMeta(content, { ...pageSeo, path: normPath });
        content = injectPublicSeoContent(content, publicPath);
      } else if (
        NOINDEX_EXACT.includes(normPath) ||
        normPath.startsWith("/receipt/") ||
        /^\/try-on\/shared\/[^/]+$/.test(normPath) ||
        normPath === "/admin" ||
        normPath.startsWith("/admin/")
      ) {
        content = injectRouteMeta(content, { noindex: true });
      } else {
        content = injectRouteMeta(content, {
          title: "搵唔到呢頁｜RedCode Fashion Design",
          description: "呢個網址唔存在，返回 RedCode 首頁或去全部貨品睇最新直播精選女裝。",
          noindex: true,
        });
        return c.html(content, 404);
      }
    }
    return c.html(content);
  });
}
