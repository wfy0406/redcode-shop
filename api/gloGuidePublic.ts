/**
 * Glo Glo 指南——公開 tRPC（router 名 gloGuide）：
 * ─ list.useQuery({limit?}) → {items: GuideListItem[]}，publishedAt desc；
 * ─ bySlug.useQuery({slug}) → GuideDetail；非 published 一律 NOT_FOUND
 *   （唔分 draft/pending/rejected/archived/唔存在，防窺探）。
 * DTO 經 gloGuideDto mapper：圖片只出 /uploads/glo-guide/ 持久路徑、modelImage 永遠 null。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  gloGuideArticleProducts,
  gloGuideArticles,
  gloGuideImages,
  products,
} from "@db/schema";
import { publicAiTags } from "./productAiContent";
import {
  toGuideDetail,
  toGuideListItem,
  type DtoImageRow,
  type DtoProductRow,
} from "./gloGuideDto";
import type { GuideDetail, GuideListItem } from "@contracts/gloGuide";

type Db = ReturnType<typeof getDb>;

function toDtoProduct(p: typeof products.$inferSelect): DtoProductRow {
  return {
    id: p.id,
    name: p.name,
    image: p.image,
    photos: p.photos,
    price: p.price,
    discountPrice: p.discountPrice,
    category: p.category,
    stock: p.stock,
    sizeEnabled: p.sizeEnabled,
    sizes: p.sizes,
    isActive: p.isActive,
    liveDate: p.liveDate,
    liveSession: p.liveSession,
    aiTags: publicAiTags(p.aiTags, p.aiTagsEnabled),
  };
}

/** 攞一篇文章嘅公開素材（商品＋圖片連 alt）；alt 用對應商品名，對唔到就用文章標題 */
async function loadPublicAssets(db: Db, articleId: number, title: string) {
  const links = await db
    .select()
    .from(gloGuideArticleProducts)
    .where(eq(gloGuideArticleProducts.articleId, articleId))
    .orderBy(gloGuideArticleProducts.position);
  const productRows = links.length
    ? await db.select().from(products).where(inArray(products.id, links.map((l) => l.productId)))
    : [];
  const productById = new Map(productRows.map((p) => [p.id, p]));
  const imageRows = await db
    .select()
    .from(gloGuideImages)
    .where(and(eq(gloGuideImages.articleId, articleId), isNull(gloGuideImages.deletedAt)))
    .orderBy(gloGuideImages.position, gloGuideImages.id);
  const images = imageRows.map((row) => ({
    row: row as DtoImageRow,
    alt:
      (row.productId !== null ? productById.get(row.productId)?.name : undefined) ??
      `${title}｜Glo Glo 配搭`,
  }));
  return {
    productRows: links
      .map((l) => productById.get(l.productId))
      .filter((p): p is typeof products.$inferSelect => !!p)
      .map(toDtoProduct),
    images,
  };
}

/** 公開詳情查詢（首口 SEO 同 tRPC 共用）：淨係 published；唔存在／未發布 → null */
export async function getPublishedGuideBySlug(slug: string): Promise<GuideDetail | null> {
  const db = getDb();
  const article = await db.query.gloGuideArticles.findFirst({
    where: and(eq(gloGuideArticles.slug, slug), eq(gloGuideArticles.status, "published")),
  });
  if (!article) return null;
  const { productRows, images } = await loadPublicAssets(db, article.id, article.title);
  return toGuideDetail(article, productRows, images);
}

/** Sitemap 專用：全部 published 指南，只讀 slug／真 updatedAt，唔逐篇加載商品同圖片。 */
export async function listPublishedGuideSitemapRows(): Promise<
  { slug: string; updatedAt: string }[]
> {
  const db = getDb();
  const rows = await db
    .select({ slug: gloGuideArticles.slug, updatedAt: gloGuideArticles.updatedAt })
    .from(gloGuideArticles)
    .where(eq(gloGuideArticles.status, "published"))
    .orderBy(desc(gloGuideArticles.publishedAt));
  return rows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt.toISOString() }));
}

/** 公開列表（首口 SEO 同 tRPC 共用）：published、publishedAt desc */
export async function listPublishedGuides(limit = 12): Promise<GuideListItem[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gloGuideArticles)
    .where(eq(gloGuideArticles.status, "published"))
    .orderBy(desc(gloGuideArticles.publishedAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  const items: GuideListItem[] = [];
  for (const article of rows) {
    const { productRows, images } = await loadPublicAssets(db, article.id, article.title);
    items.push(toGuideListItem(article, productRows, images));
  }
  return items;
}

export const gloGuidePublicRouter = createRouter({
  list: publicQuery
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ input }): Promise<{ items: GuideListItem[] }> => {
      return { items: await listPublishedGuides(input?.limit ?? 12) };
    }),
  bySlug: publicQuery
    .input(z.object({ slug: z.string().min(1).max(180) }))
    .query(async ({ input }): Promise<GuideDetail> => {
      const detail = await getPublishedGuideBySlug(input.slug.trim());
      if (!detail) {
        // 非 published（draft/pending/rejected/archived）同唔存在一律 NOT_FOUND
        throw new TRPCError({ code: "NOT_FOUND", message: "搵唔到呢篇指南" });
      }
      return detail;
    }),
});
