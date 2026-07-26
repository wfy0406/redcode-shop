import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["member", "staff", "admin"]);

export const orderStatusEnum = pgEnum("order_status", [
  "pending_payment",
  "payment_review",
  "approved",
  "rejected",
  "shipped",
  "completed",
  "cancelled",
]);

export const paymentProofStatusEnum = pgEnum("payment_proof_status", [
  "pending",
  "approved",
  "rejected",
]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
  address: text("address"),
  age: integer("age"),
  role: roleEnum("role").notNull().default("member"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: varchar("sku", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  image: varchar("image", { length: 512 }).notNull(),
  price: integer("price").notNull(),
  discountPrice: integer("discountPrice"),
  sizes: varchar("sizes", { length: 255 }),
  note: varchar("note", { length: 512 }),
  category: varchar("category", { length: 32 }).notNull().default("other"),
  listedDate: timestamp("listedDate").notNull(),
  stock: integer("stock").notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const cartItems = pgTable(
  "cartItems",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number" })
      .notNull()
      .references(() => users.id),
    productId: bigint("productId", { mode: "number" })
      .notNull()
      .references(() => products.id),
    size: varchar("size", { length: 64 }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cart_user_product_size").on(t.userId, t.productId, t.size)],
);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNo: varchar("orderNo", { length: 32 }).notNull().unique(),
  userId: bigint("userId", { mode: "number" })
    .notNull()
    .references(() => users.id),
  status: orderStatusEnum("status").notNull().default("pending_payment"),
  total: integer("total").notNull(),
  address: text("address"),
  note: text("note"),
  promoCode: varchar("promoCode", { length: 32 }),
  discountAmount: integer("discountAmount").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  // PostgreSQL 冇 ON UPDATE CURRENT_TIMESTAMP，updatedAt 由應用層更新時一併 set
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const orderItems = pgTable("orderItems", {
  id: serial("id").primaryKey(),
  orderId: bigint("orderId", { mode: "number" })
    .notNull()
    .references(() => orders.id),
  productId: bigint("productId", { mode: "number" })
    .notNull()
    .references(() => products.id),
  productName: varchar("productName", { length: 255 }).notNull(),
  sku: varchar("sku", { length: 64 }).notNull(),
  size: varchar("size", { length: 64 }),
  price: integer("price").notNull(),
  quantity: integer("quantity").notNull(),
});

export const paymentProofs = pgTable("paymentProofs", {
  id: serial("id").primaryKey(),
  orderId: bigint("orderId", { mode: "number" })
    .notNull()
    .references(() => orders.id),
  imagePath: varchar("imagePath", { length: 512 }).notNull(),
  status: paymentProofStatusEnum("status").notNull().default("pending"),
  reviewedBy: bigint("reviewedBy", { mode: "number" }).references(() => users.id),
  reviewNote: text("reviewNote"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const promoCodes = pgTable("promoCodes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  kind: varchar("kind", { length: 8 }).notNull(), // 'percent' | 'fixed'
  value: integer("value").notNull(),
  minSpend: integer("minSpend").notNull().default(0),
  usageLimit: integer("usageLimit"),
  usedCount: integer("usedCount").notNull().default(0),
  expiresAt: timestamp("expiresAt"),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const praiseWall = pgTable("praiseWall", {
  id: serial("id").primaryKey(),
  image: varchar("image", { length: 512 }).notNull(),
  caption: varchar("caption", { length: 255 }),
  sortOrder: integer("sortOrder").notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;export type Product = typeof products.$inferSelect;
export type CartItem = typeof cartItems.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type PaymentProof = typeof paymentProofs.$inferSelect;
export type PromoCode = typeof promoCodes.$inferSelect;
export type PraiseWallEntry = typeof praiseWall.$inferSelect;
