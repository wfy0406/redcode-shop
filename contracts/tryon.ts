/** AI 試穿共用商品契約：只分實際穿戴部位，唔將非穿著商品包埋入嚟。 */
export const TRYON_PRODUCT_KINDS = [
  "top",
  "pants",
  "dress",
  "shoes",
  "ring",
  "necklace",
  "earrings",
  "bracelet",
] as const;

export type TryOnProductKind = (typeof TRYON_PRODUCT_KINDS)[number];

const LABELS: Record<TryOnProductKind, string> = {
  top: "上衣",
  pants: "褲",
  dress: "裙",
  shoes: "鞋",
  ring: "戒指",
  necklace: "頸鏈",
  earrings: "耳環",
  bracelet: "手鏈／手鐲",
};

export function tryOnProductKindLabel(kind: TryOnProductKind): string {
  return LABELS[kind];
}

/** 同一步失敗後可以重試；對外只顯示最新 attempt，唔將舊失敗紀錄當成另一件商品。 */
export function latestTryOnAttemptsByStep<T extends { id: number; stepNumber: number }>(rows: T[]): T[] {
  const latest = new Map<number, T>();
  for (const row of rows) {
    const current = latest.get(row.stepNumber);
    if (!current || row.id > current.id) latest.set(row.stepNumber, row);
  }
  return [...latest.values()].sort((a, b) => a.stepNumber - b.stepNumber || a.id - b.id);
}

const ACCESSORY_PATTERNS: ReadonlyArray<{ kind: TryOnProductKind; pattern: RegExp }> = [
  { kind: "ring", pattern: /戒指|介指|指環|\brings?\b/i },
  { kind: "necklace", pattern: /頸鏈|頸鍊|項鏈|項鍊|\bnecklaces?\b/i },
  { kind: "earrings", pattern: /耳環|耳釘|耳飾|\bearrings?\b/i },
  { kind: "bracelet", pattern: /手鏈|手鍊|手鐲|手環|\bbracelets?\b|\bbangles?\b/i },
];

/**
 * 飾品只接受品名可明確分辨嘅單一子類；套裝、多子類、收納／保養用品或泛稱飾品一律拒絕。
 * 呢個係上架資格及混搭部位判斷，唔係對生成效果嘅保證；最後仍要真人＋真商品驗收。
 */
export function resolveTryOnProductKind(category: string, productName: string): TryOnProductKind | null {
  if (category === "top" || category === "pants" || category === "dress" || category === "shoes") {
    return category;
  }
  if (category !== "accessory") return null;
  const name = productName.trim();
  if (!name || /收納|首飾盒|展示架|清潔|保養|抹銀|擦銀|維修|storage|cleaning|polish/i.test(name)) {
    return null;
  }
  const matches = ACCESSORY_PATTERNS.filter(({ pattern }) => pattern.test(name));
  return matches.length === 1 ? matches[0].kind : null;
}

export interface TryOnShareProduct {
  productId: number;
  productName: string;
  productSku: string;
  productPrice: number;
  productDiscountPrice: number | null;
}

function hkd(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  return `HK$${String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** 只分享公開商品資料及網址；私人原相、生成結果 signed URL 絕對唔放入文案。 */
export function buildTryOnShareText(products: TryOnShareProduct[], origin: string): string {
  if (products.length < 1 || products.length > 3) throw new Error("分享商品數量必須係 1 至 3 件");
  const base = origin.replace(/\/+$/, "");
  const lines = ["✨ RedCode AI 試穿預覽", "", `我試咗以下 ${products.length} 件商品嘅 AI 穿著效果：`];
  products.forEach((product, index) => {
    const current = product.productDiscountPrice ?? product.productPrice;
    const hasDiscount = product.productDiscountPrice != null && product.productDiscountPrice < product.productPrice;
    lines.push(
      "",
      `${index + 1}. ${product.productName}`,
      `貨號：${product.productSku}`,
      hasDiscount ? `價錢：優惠價 ${hkd(current)}（原價 ${hkd(product.productPrice)}）` : `價錢：${hkd(current)}`,
      `商品網址：${base}/products/${product.productId}`,
    );
  });
  lines.push(
    "",
    "以上係 AI 試穿視覺預覽，唔代表實際尺碼、鬆緊、合身程度或舒適度；尺寸以商品尺寸表及實物為準。",
  );
  return lines.join("\n");
}

/** wa.me 只能帶公開文字及商品網址；私人結果圖由用戶下載後自行附加，或用支援嘅 Web Share files。 */
export function buildTryOnWhatsAppUrl(products: TryOnShareProduct[], origin: string): string {
  return `https://wa.me/?text=${encodeURIComponent(buildTryOnShareText(products, origin))}`;
}
