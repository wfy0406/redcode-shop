import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products } from "@db/schema";
import { createRouter, publicQuery, staffProcedure } from "./middleware";
import { logAudit } from "./audit";
import { openApprovalRequest } from "./approvalsRouter";

export const CATEGORY_OPTIONS = [
  { key: "top", label: "上身" },
  { key: "dress", label: "連身裙/半身裙" },
  { key: "pants", label: "褲" },
  { key: "bag", label: "袋" },
  { key: "shoes", label: "鞋" },
  { key: "accessories", label: "飾物" },
  { key: "other", label: "其他" },
] as const;

const categoryKeys = CATEGORY_OPTIONS.map((c) => c.key) as [
  string,
  ...string[],
];

/**
 * 商品目錄
 * list：公開，只回上架中（isActive），按 listedDate desc（最新上架排最前）
 * detail：公開，單件商品詳情
 * adminList / create / update / remove / restock：員工後台用（staff/admin）
 */
const productInput = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  image: z.string().min(1).max(512),
  photos: z.array(z.string().min(1).max(512)).max(10).optional(),
  price: z.number().int().min(0),
  discountPrice: z.number().int().min(0).nullable().optional(),
  sizes: z.string().max(255).nullable().optional(),
  sizeEnabled: z.boolean().optional(),
  delistEnabled: z.boolean().optional(),
  delistAt: z.coerce.date().nullable().optional(),
  note: z.string().max(512).nullable().optional(),
  category: z.enum(categoryKeys as [string, ...string[]]).optional(),
  stock: z.number().int().min(0),
});

export const productsRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    // 只顯示上架中嘅商品畀客人（定時下架：到咗 delistAt 就當落咗架，後台先睇返）
    const now = new Date();
    const rows = await db
      .select()
      .from(products)
      .where(eq(products.isActive, true))
      .orderBy(desc(products.listedDate), desc(products.id));
    return rows.filter(
      (p) => !(p.delistEnabled && p.delistAt && p.delistAt <= now),
    );
  }),

  detail: publicQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const product = await db.query.products.findFirst({
        where: eq(products.id, input.id),
      });
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "商品唔存在" });
      }
      return product;
    }),

  adminList: staffProcedure.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(products)
      .orderBy(desc(products.listedDate), desc(products.id));
  }),

  create: staffProcedure.input(productInput).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const dup = await db.query.products.findFirst({
      where: eq(products.sku, input.sku),
    });
    if (dup) {
      throw new TRPCError({ code: "CONFLICT", message: `SKU「${input.sku}」已存在` });
    }
    // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准
    const reqId = await openApprovalRequest({
      user: ctx.user,
      action: "product.create",
      payload: { input },
      summary: `新增商品「${input.name}」（SKU ${input.sku}）`,
    });
    if (reqId !== null) return { pendingApproval: true as const, requestId: reqId };
    const photos = normalizePhotos(input.image, input.photos);
    const [{ id }] = await db
      .insert(products)
      .values({
        sku: input.sku,
        name: input.name,
        description: input.description ?? null,
        image: photos[0] ?? input.image,
        photos,
        price: input.price,
        discountPrice: input.discountPrice ?? null,
        sizes: input.sizes ?? null,
        sizeEnabled: input.sizeEnabled ?? true,
        delistEnabled: input.delistEnabled ?? false,
        delistAt: input.delistEnabled ? (input.delistAt ?? null) : null,
        note: input.note ?? null,
        category: input.category ?? "other",
        stock: input.stock,
        listedDate: new Date(),
      })
      .returning({ id: products.id });
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "product.create",
      targetType: "product",
      targetId: id,
      detail: `新增商品「${input.name}」（SKU ${input.sku}）`,
    });
    return db.query.products.findFirst({ where: eq(products.id, id) });
  }),

  update: staffProcedure
    .input(productInput.partial().extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      const existing = await db.query.products.findFirst({
        where: eq(products.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "商品唔存在" });
      }
      if (data.sku && data.sku !== existing.sku) {
        const dup = await db.query.products.findFirst({
          where: eq(products.sku, data.sku),
        });
        if (dup) {
          throw new TRPCError({ code: "CONFLICT", message: `SKU「${data.sku}」已存在` });
        }
      }
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准；
      // before 快照記低現狀，審批中心用嚟做改前 vs 改後對照
      const reqId = await openApprovalRequest({
        user: ctx.user,
        action: "product.update",
        payload: { input, before: existing },
        summary: `修改商品「${existing.name}」（SKU ${existing.sku}）`,
      });
      if (reqId !== null) return { pendingApproval: true as const, requestId: reqId };
      const merged = { ...existing, ...data };
      // 相簿規整：有傳 photos 就以佢為準（去重、封面排頭），冇傳就維持；image 永遠＝photos[0]
      const photos = data.photos !== undefined
        ? normalizePhotos(data.photos[0] ?? merged.image, data.photos)
        : merged.photos && merged.photos.length > 0
          ? merged.photos
          : [merged.image];
      await db
        .update(products)
        .set({
          sku: merged.sku,
          name: merged.name,
          description: merged.description ?? null,
          image: photos[0] ?? merged.image,
          photos,
          price: merged.price,
          discountPrice: merged.discountPrice ?? null,
          sizes: merged.sizes ?? null,
          sizeEnabled: merged.sizeEnabled ?? true,
          delistEnabled: merged.delistEnabled ?? false,
          delistAt: (merged.delistEnabled ?? false) ? (merged.delistAt ?? null) : null,
          note: merged.note ?? null,
          category: merged.category ?? "other",
          stock: merged.stock,
        })
        .where(eq(products.id, id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.update",
        targetType: "product",
        targetId: id,
        detail: `更新商品「${merged.name}」（SKU ${merged.sku}）：${Object.keys(data).join("、")}`,
      });
      return db.query.products.findFirst({ where: eq(products.id, id) });
    }),

  remove: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.products.findFirst({
        where: eq(products.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "商品唔存在" });
      }
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准；
      // before 快照記低現狀，審批中心用嚟完整預覽將會刪除嘅資料
      const reqId = await openApprovalRequest({
        user: ctx.user,
        action: "product.remove",
        payload: { input, before: existing },
        summary: `刪除商品「${existing.name}」（SKU ${existing.sku}）`,
      });
      if (reqId !== null) return { pendingApproval: true as const, requestId: reqId };
      await db.delete(products).where(eq(products.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.remove",
        targetType: "product",
        targetId: input.id,
        detail: `刪除商品「${existing.name}」（SKU ${existing.sku}）`,
      });
      return { ok: true };
    }),

  restock: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        delta: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.products.findFirst({
        where: eq(products.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "商品唔存在" });
      }
      const newStock = existing.stock + input.delta;
      if (newStock < 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `扣完會變負數（而家 ${existing.stock} 件）`,
        });
      }
      await db
        .update(products)
        .set({ stock: newStock })
        .where(eq(products.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.restock",
        targetType: "product",
        targetId: input.id,
        detail: `「${existing.name}」庫存 ${existing.stock} → ${newStock}`,
      });
      return db.query.products.findFirst({ where: eq(products.id, input.id) });
    }),
});

/** 相簿規整：確保封面排第一、去重、去空字串；冇相就回 [cover] */
function normalizePhotos(cover: string, photos?: string[]): string[] {
  const list = (photos ?? []).map((p) => p.trim()).filter(Boolean);
  const unique = Array.from(new Set(list));
  if (unique.length === 0) return [cover];
  // 封面一定要排第一
  const rest = unique.filter((p) => p !== cover);
  return [cover, ...rest];
}
