import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { products } from "@db/schema";

/** HTML attribute escape：品名/描述入面嘅 & " < > 會整爛 meta tag */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 商品頁分享預覽（Facebook / WhatsApp / Telegram 全靠 OG meta）：
 * App 用 HashRouter（#/products/123），但 hash 後面嘅嘢 crawler 永遠收唔到，
 * 所以分享連結用正式路徑 /products/123，由 server 喺 index.html 注入呢件商品嘅
 * og:title / og:description / og:image。 crawler 唔行 JS，一定要 server 出。
 * 搵唔到商品或 DB 出错：原封不動回 html（OG 失敗唔可以阻正常出頁）。
 */
export async function injectProductOg(html: string, id: number, origin: string): Promise<string> {
  try {
    const db = getDb();
    const [p] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!p) return html;

    const pageUrl = `${origin}/products/${p.id}`;
    const imageUrl = p.image.startsWith("http") ? p.image : `${origin}${p.image}`;
    const price = p.discountPrice ?? p.price;
    const descSrc =
      p.description?.trim() ||
      `${p.name}｜HK$${price}｜RedCode 香港女裝直播，每晚為你揀選星空下最閃嘅衫。`;
    const desc = descSrc.length > 120 ? `${descSrc.slice(0, 117)}…` : descSrc;
    const title = `${p.name}｜RedCode`;

    const tags = [
      `<meta property="og:type" content="product" />`,
      `<meta property="og:site_name" content="RedCode" />`,
      `<meta property="og:title" content="${esc(title)}" />`,
      `<meta property="og:description" content="${esc(desc)}" />`,
      `<meta property="og:image" content="${esc(imageUrl)}" />`,
      `<meta property="og:url" content="${esc(pageUrl)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${esc(title)}" />`,
      `<meta name="twitter:description" content="${esc(desc)}" />`,
      `<meta name="twitter:image" content="${esc(imageUrl)}" />`,
    ].join("\n    ");

    // 抽走 index.html 入面嘅預設 og:/twitter: meta（首頁通用版），換上呢件商品嘅
    let out = html.replace(/[ \t]*<meta\s+(?:property|name)="(?:og:|twitter:)[^>]*\/>\s*\n?/g, "");
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
    out = out.replace("</head>", `    ${tags}\n  </head>`);
    return out;
  } catch {
    return html;
  }
}
