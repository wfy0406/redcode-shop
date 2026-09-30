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
    // SEO（v2.2.20）：canonical 指返呢件商品（replace 原有嗰條，唔會多一條出嚟）
    out = out.replace(
      '<link rel="canonical" href="https://redcode.red/" />',
      `<link rel="canonical" href="${esc(pageUrl)}" />`,
    );
    out = out.replace("</head>", `    ${tags}\n  </head>`);

    // SEO（v2.2.20）：順手注入 Product JSON-LD（放 </head> 前）。
    // 價錢注意：products 表 price/discountPrice 係整數港元（唔係 cents——
    // cents 淨係訂單/VIP 引擎用），所以 JSON-LD price 直接 toFixed(2)，唔准 ÷100。
    // 任何一步出錯都靜靜雞 skip，唔好炸成個 injection。
    try {
      const stripText = (s: string) =>
        s
          .replace(/<[^>]*>/g, " ")
          .replace(/[\u0000-\u001f]/g, " ")
          .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
          .replace(/\s+/g, " ")
          .trim();
      const descPlain = stripText(p.description ?? "") || `${p.name}｜RedCode 香港女裝直播`;
      const jsonDesc = descPlain.length > 200 ? `${descPlain.slice(0, 197)}…` : descPlain;
      const images = (p.photos && p.photos.length ? p.photos : [p.image]).map((u) =>
        u.startsWith("http") ? u : `${origin}${u}`,
      );
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: p.name,
        image: images,
        description: jsonDesc,
        ...(p.sku ? { sku: p.sku } : {}),
        brand: { "@type": "Brand", name: "RedCode" },
        offers: {
          "@type": "Offer",
          url: pageUrl,
          priceCurrency: "HKD",
          price: price.toFixed(2),
          availability:
            p.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          itemCondition: "https://schema.org/NewCondition",
        },
      };
      // 防 </script> 截斷：JSON 入面所有 < 換做 \u003c
      const jsonLdTag = `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;
      out = out.replace("</head>", `    ${jsonLdTag}\n  </head>`);
    } catch {
      /* JSON-LD 注入失敗唔影響已經做好嘅 OG meta */
    }
    return out;
  } catch {
    return html;
  }
}
