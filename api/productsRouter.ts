import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, like, or, desc } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, orderItems, products } from "@db/schema";
import { PRODUCT_CATEGORY_VALUES, productCategoryLabel } from "@contracts/types";
import { createRouter, publicQuery, staffProcedure } from "./middleware";
import { logAudit } from "./audit";

const categorySchema = z.enum(PRODUCT_CATEGORY_VALUES as [string, ...string[]]);

/**
 * 「未下架」條件：冇開定時下架，或者開咗但時間未到。
 * 人手下架（isActive=false）另外喺查詢度擋。
 */
function notAutoDelisted() {
  return or(
    eq(products.delistEnabled, false),
    isNull(products.delistAt),
    gt(products.delistAt, new Date()),
  )!;
}

// ===== 更新日誌：新舊值對比（中文欄位名＋舊值 → 新值） =====

/** 欄位中文名（日誌顯示用） */
const PRODUCT_FIELD_LABELS: Record<string, string> = {
  sku: "貨號",
  name: "名稱",
  description: "描述",
  image: "主圖",
  photos: "商品圖",
  price: "原價",
  discountPrice: "折扣價",
  sizes: "尺碼",
  sizeEnabled: "尺碼選項",
  note: "備註",
  category: "分類",
  listedDate: "上架日期",
  stock: "存貨",
  isActive: "上架狀態",
  delistEnabled: "定時下架",
  delistAt: "下架時間",
};

/** 長內容欄位（圖片網址、描述）：唔列新舊值，淨係講「已更新」 */
const PRODUCT_SILENT_FIELDS = new Set(["description", "image", "photos"]);

/** 香港時間（UTC+8）格式化：dateOnly＝YYYY-MM-DD，否則 YYYY-MM-DD HH:mm */
function fmtDateHK(d: Date, dateOnly: boolean): string {
  const hk = new Date(d.getTime() + 8 * 3600 * 1000);
  const iso = hk.toISOString();
  return dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** 單個欄位值嘅日誌顯示格式 */
function fmtProductField(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "（無）";
  if (key === "price" || key === "discountPrice") return `$${v}`;
  if (key === "isActive") return v ? "上架中" : "已下架";
  if (key === "sizeEnabled" || key === "delistEnabled") return v ? "開" : "關";
  if (key === "listedDate")
    return v instanceof Date ? fmtDateHK(v, true) : String(v);
  if (key === "delistAt")
    return v instanceof Date ? fmtDateHK(v, false) : String(v);
  if (key === "category") return productCategoryLabel(String(v));
  return String(v);
}

/** 新舊值正規化比較（null ≈ undefined ≈ 空字串；Date 用 timestamp；array 逐項） */
function productFieldSame(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === null || v === undefined || v === "") return "";
    if (v instanceof Date) return v.getTime();
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  };
  return norm(a) === norm(b);
}

/**
 * 對比更新前後，用中文列出「真係改咗」嘅欄位（舊值 → 新值）。
 * 前端係成張表單提交，所以淨係改一個欄位都會傳晒全部欄位上嚟——
 * 呢個函數負責過濾，全部冇變就話「內容冇變」。
 */
function describeProductChanges(
  existing: Record<string, unknown>,
  data: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of Object.keys(data)) {
    // 多相更新時 image 係由 photos[0] 同步（見下面 mutation），屬同一改動，唔重複講
    if (key === "image" && data.photos !== undefined) continue;
    const next = data[key];
    if (next === undefined) continue;
    const prev = existing[key];
    if (productFieldSame(prev, next)) continue;
    const label = PRODUCT_FIELD_LABELS[key] ?? key;
    if (PRODUCT_SILENT_FIELDS.has(key)) {
      parts.push(`${label}已更新`);
    } else {
      parts.push(
        `${label}：${fmtProductField(key, prev)} → ${fmtProductField(key, next)}`,
      );
    }
  }
  return parts.length > 0 ? parts.join("；") : "內容冇變";
}

export const productsRouter = createRouter({
  list: publicQuery
    .input(
      z
        .object({
          keyword: z.string().optional(),
          category: categorySchema.optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const keyword = input?.keyword?.trim();
      const conditions = [eq(products.isActive, true), notAutoDelisted()];
      if (keyword) {
        const pattern = `%${keyword}%`;
        conditions.push(
          or(like(products.name, pattern), like(products.description, pattern))!,
        );
      }
      if (input?.category) {
        conditions.push(eq(products.category, input.category));
      }
      return db
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.listedDate));
    }),

  // staff 專用：全部商品（包括下架），俾管理後台用
  adminList: staffProcedure.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(products)
      .orderBy(desc(products.listedDate));
  }),

  byId: publicQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const product = await db.query.products.findFirst({
        where: and(eq(products.id, input.id), eq(products.isActive, true), notAutoDelisted()),
      });
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在或已下架" });
      }
      return product;
    }),

  create: staffProcedure
    .input(
      z.object({
        sku: z.string().min(1).max(64),
        name: z.string().min(1),
        description: z.string().optional(),
        image: z.string().min(1),
        // 多相相簿（最多 12 張）：photos[0]＝封面，server 同步寫入 image 欄
        photos: z.array(z.string().min(1).max(512)).max(12).optional(),
        price: z.number().int().nonnegative(),
        discountPrice: z.number().int().nonnegative().optional(),
        sizes: z.string().optional(),
        sizeEnabled: z.boolean().optional(),
        note: z.string().max(512).optional(),
        category: categorySchema.optional(),
        listedDate: z.coerce.date().optional(),
        stock: z.number().int().nonnegative().optional(),
        // 定時自動下架：開關 + 時間（選填；開關開咗冇時間＝唔會自動落）
        delistEnabled: z.boolean().optional(),
        delistAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const dup = await db.query.products.findFirst({
        where: eq(products.sku, input.sku),
      });
      if (dup) {
        throw new TRPCError({ code: "CONFLICT", message: "貨號已存在" });
      }
      // 多相：畀咗 photos 就用佢（第一張＝封面同步落 image 欄）；冇就由 image 欄做唯一一張
      const gallery = input.photos?.length ? input.photos : [input.image];
      const [{ id }] = await db
        .insert(products)
        .values({
          sku: input.sku,
          name: input.name,
          description: input.description ?? null,
          image: gallery[0],
          photos: gallery,
          price: input.price,
          discountPrice: input.discountPrice ?? null,
          sizes: input.sizes ?? null,
          sizeEnabled: input.sizeEnabled ?? true,
          note: input.note ?? null,
          category: input.category ?? "other",
          listedDate: input.listedDate ?? new Date(),
          stock: input.stock ?? 0,
          delistEnabled: input.delistEnabled ?? false,
          delistAt: input.delistAt ?? null,
        })
        .returning({ id: products.id });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.create",
        targetType: "product",
        targetId: input.sku,
        detail: `新增商品「${input.name}」（${input.sku}，HK$${input.discountPrice ?? input.price}）`,
      });
      return db.query.products.findFirst({ where: eq(products.id, id) });
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        sku: z.string().min(1).max(64).optional(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        image: z.string().min(1).optional(),
        photos: z.array(z.string().min(1).max(512)).max(12).optional(),
        price: z.number().int().nonnegative().optional(),
        discountPrice: z.number().int().nonnegative().nullable().optional(),
        sizes: z.string().nullable().optional(),
        sizeEnabled: z.boolean().optional(),
        note: z.string().max(512).nullable().optional(),
        category: categorySchema.optional(),
        listedDate: z.coerce.date().optional(),
        stock: z.number().int().nonnegative().optional(),
        isActive: z.boolean().optional(),
        delistEnabled: z.boolean().optional(),
        delistAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      const existing = await db.query.products.findFirst({
        where: eq(products.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      // 多相：畀咗 photos 就同步封面 image＝photos[0]（唔准空相簿）；冇畀就唔郁舊相
      if (data.photos !== undefined) {
        if (data.photos.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "商品至少要有一張相" });
        }
        data.image = data.photos[0];
      }
      await db.update(products).set(data).where(eq(products.id, id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.update",
        targetType: "product",
        targetId: existing.sku,
        detail: `更新商品「${data.name ?? existing.name}」（${existing.sku}）：${describeProductChanges(
          existing as unknown as Record<string, unknown>,
          { ...data } as Record<string, unknown>,
        )}`,
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
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      // 購物車紀錄係即興嘢（唔係訂單歷史），直接清走，唔做刪除嘅絆腳石
      await db.delete(cartItems).where(eq(cartItems.productId, input.id));
      // 有訂單紀錄嘅商品：orderItems 外鍵擋住，硬刪會搞壞歷史訂單，所以擋＋教路
      const linkedItems = await db.query.orderItems.findMany({
        where: eq(orderItems.productId, input.id),
        columns: { orderId: true },
      });
      if (linkedItems.length > 0) {
        const orderCount = new Set(linkedItems.map((i) => i.orderId)).size;
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `呢件商品有 ${orderCount} 張訂單紀錄，唔可以直接刪除。想徹底刪走：先去「訂單管理」刪埋相關訂單再返嚟刪；想留返訂單紀錄：用「下架」代替（客人即刻睇唔到）。`,
        });
      }
      await db.delete(products).where(eq(products.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.remove",
        targetType: "product",
        targetId: existing.sku,
        detail: `刪除商品「${existing.name}」（${existing.sku}）`,
      });
      return { ok: true };
    }),
});
