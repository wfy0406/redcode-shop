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
 *
 * 回傳值三種情況（2026-10-27 Search Console 軟 404 根治）：
 * ─ 商品存在 → 注入後嘅 HTML（title/description/canonical/OG/JSON-LD/noscript 全文）
 * ─ DB 查詢成功但商品**唔存在** → null（caller 要回真 404；例如已刪嘅 /products/94
 *   之前回 200＋首頁 title/canonical，Google 當軟 404 / alternate page 處理）
 * ─ DB 出錯／注入出錯 → 原封不動回 html（一時 DB 故障唔可以令在架商品被當 404 踢出索引）
 */
/** 逐頁 SEO 注入參數；title/description/path 唔俾就照 index.html 預設 */
export interface RouteMeta {
  title?: string;
  description?: string;
  path?: string;
  noindex?: boolean;
}

/**
 * 逐頁 SEO（v2.2.21 E2）：BrowserRouter 遷移後每條路由係真 URL，server 喺
 * notFound fallback 出 index.html 前，按頁面注入專屬 title / description /
 * og:title / og:description / og:url / canonical（https://redcode.red{path}）；
 * noindex=true 時 robots meta 改做 `noindex, nofollow`（冇就先加一條）。
 * 純字串操作，pattern 對唔上就靜靜雞 skip，絕對唔可以阻正常出頁。
 */
export function injectRouteMeta(html: string, meta: RouteMeta): string {
  try {
    let out = html;
    if (meta.title) {
      const t = esc(meta.title);
      out = out.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
      out = out.replace(
        /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:title" content="${t}" />`,
      );
    }
    if (meta.description) {
      const d = esc(meta.description);
      out = out.replace(
        /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
        `<meta name="description" content="${d}" />`,
      );
      out = out.replace(
        /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:description" content="${d}" />`,
      );
    }
    if (meta.path) {
      const url = esc(`https://redcode.red${meta.path}`);
      out = out.replace(
        /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:url" content="${url}" />`,
      );
      out = out.replace(
        /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
        `<link rel="canonical" href="${url}" />`,
      );
    }
    if (meta.noindex) {
      const robots = '<meta name="robots" content="noindex, nofollow" />';
      if (/<meta\s+name="robots"\s+content="[^"]*"\s*\/>/.test(out)) {
        out = out.replace(/<meta\s+name="robots"\s+content="[^"]*"\s*\/>/, robots);
      } else {
        out = out.replace("</head>", `    ${robots}\n  </head>`);
      }
    }
    return out;
  } catch {
    return html;
  }
}

/** 商品描述入面嘅 HTML tag／控制碼／emoji 剝走，先至好入 meta description（純文字） */
function toPlainText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function injectProductOg(
  html: string,
  id: number,
  origin: string,
): Promise<string | null> {
  let p: typeof products.$inferSelect | undefined;
  try {
    const db = getDb();
    [p] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  } catch {
    // DB 一時故障：原封不動回 html（200），唔好令在架商品被當 404
    return html;
  }
  // 查詢成功但冇呢件商品（已刪／從未存在，例如 /products/94）：null → caller 回真 404
  if (!p) return null;
  try {
    const pageUrl = `${origin}/products/${p.id}`;
    const imageUrl = p.image.startsWith("http") ? p.image : `${origin}${p.image}`;
    const price = p.discountPrice ?? p.price;
    // meta description：同前端 ProductDetail 載入後嘅規則一致——商品描述純文字 120 字截斷；
    // 冇描述就用商品名兜底。**之前呢度淨係改 OG/title，冇郁 meta[name=description]**，
    // 件件商品出同一條首頁通用 description → Google 當 /products/85、/products/95 呢類
    // 短名商品做 near-duplicate（duplicate without user-selected canonical）。
    const descPlain = toPlainText(p.description ?? "");
    const descSrc =
      descPlain || `${p.name}——RedCode 香港女裝直播精選，直播優惠價發售，順豐站自取。`;
    const desc = descSrc.length > 120 ? `${descSrc.slice(0, 117)}…` : descSrc;
    // title 同前端 ProductDetail 嘅 document.title 對齊（server HTML 同 rendered DOM 一致）
    const title = `${p.name}｜RedCode Fashion Design`;

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
    // SEO（2026-10-27）：meta description 都要換做呢件商品專屬嗰條（之前漏咗，
    // 全部商品頁出同一條首頁 description，係 near-duplicate 嘅主要訊號之一）
    out = out.replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${esc(desc)}" />`,
    );
    // SEO（v2.2.20）：canonical 指返呢件商品（replace 原有嗰條，唔會多一條出嚟）
    out = out.replace(
      '<link rel="canonical" href="https://redcode.red/" />',
      `<link rel="canonical" href="${esc(pageUrl)}" />`,
    );
    out = out.replace("</head>", `    ${tags}\n  </head>`);

    // SEO（2026-10-27）：server-rendered crawlable content——SPA 嘅 #root 出貨時係空，
    // raw HTML 除咗 meta 乜都冇，件件商品頁近乎一樣。喺 <body> 尾加 <noscript>
    // 商品摘要（名＋價＋描述純文字＋全部貨品連結）：唔行 JS 嘅 crawler 讀到真內容；
    // 開咗 JS 嘅瀏覽器/Google 渲染後唔顯示，UI 一字唔郁。
    // ⚠️ 唔好放落 #root 入面：index.html 白屏自救 script 靠 root.childNodes 判斷
    // JS 有冇行到，塞嘢入去會整熄自救；React mount 時亦會清走 #root 原有內容。
    const noscriptDesc =
      (descPlain.length > 300 ? `${descPlain.slice(0, 297)}…` : descPlain) || desc;
    const noscript =
      `<noscript><h1>${esc(p.name)}</h1>` +
      `<p>HK$${price}</p>` +
      `<p>${esc(noscriptDesc)}</p>` +
      `<p><a href="/products">全部貨品</a></p></noscript>`;
    out = out.replace("</body>", `    ${noscript}\n  </body>`);

    // SEO（v2.2.20）：順手注入 Product JSON-LD（放 </head> 前）。
    // 價錢注意：products 表 price/discountPrice 係整數港元（唔係 cents——
    // cents 淨係訂單/VIP 引擎用），所以 JSON-LD price 直接 toFixed(2)，唔准 ÷100。
    // 任何一步出錯都靜靜雞 skip，唔好炸成個 injection。
    try {
      const jsonPlain = descPlain || `${p.name}｜RedCode 香港女裝直播`;
      const jsonDesc = jsonPlain.length > 200 ? `${jsonPlain.slice(0, 197)}…` : jsonPlain;
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
          // SEO（2026-10-06）：Search Console 商家資訊警告——offers 補退貨政策＋運費。
          // 退貨政策照 /returns 頁：收貨 7 天內、郵寄退貨、退貨運費買家付（破損個案內部酌情）。
          // 運費 HK$30 係順豐基準價（滿 $350 免運）；正式展示以 Merchant Center 運送設定為準。
          hasMerchantReturnPolicy: {
            "@type": "MerchantReturnPolicy",
            applicableCountry: "HK",
            returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
            merchantReturnDays: 7,
            merchantReturnLink: "https://redcode.red/returns",
            returnMethod: "https://schema.org/ReturnByMail",
            returnFees: "https://schema.org/ReturnShippingFees",
            // SEO（2026-10-08）：Search Console 建議欄位——退貨運費金額。
            // 買家付順豐到付，基準價 HK$30（同樓上運費一致）。
            returnShippingFeesAmount: { "@type": "MonetaryAmount", value: "30.00", currency: "HKD" },
          },
          shippingDetails: {
            "@type": "OfferShippingDetails",
            shippingDestination: { "@type": "DefinedRegion", addressCountry: "HK" },
            shippingRate: { "@type": "MonetaryAmount", value: "30.00", currency: "HKD" },
            // SEO（2026-10-08）：Search Console 建議欄位——送貨時間。
            // 跟老闆 Merchant Center 填嘅數：處理 3–12 天（一至五）＋ 運送 2–4 天（一至日）＝ 總共 5–16 工作天。
            deliveryTime: {
              "@type": "ShippingDeliveryTime",
              handlingTime: { "@type": "QuantitativeValue", minValue: 3, maxValue: 12, unitCode: "DAY" },
              transitTime: { "@type": "QuantitativeValue", minValue: 2, maxValue: 4, unitCode: "DAY" },
            },
          },
        },
      };
      // SEO（v2.2.21 E2）：BreadcrumbList JSON-LD（首頁 > 全部貨品 > 產品名），
      // 放 Product JSON-LD 隔籬；同樣防 </script> 截斷做 < escape。
      const breadcrumbLd = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "首頁", item: `${origin}/` },
          { "@type": "ListItem", position: 2, name: "全部貨品", item: `${origin}/products` },
          { "@type": "ListItem", position: 3, name: p.name, item: pageUrl },
        ],
      };
      const breadcrumbTag = `<script type="application/ld+json">${JSON.stringify(breadcrumbLd).replace(/</g, "\\u003c")}</script>`;
      out = out.replace("</head>", `    ${breadcrumbTag}\n  </head>`);
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
