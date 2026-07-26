import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  int,
  boolean,
  bigint,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
  address: text("address"),
  age: int("age"),
  role: mysqlEnum("role", ["member", "staff", "admin"])
    .notNull()
    .default("member"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const products = mysqlTable("products", {
  id: serial("id").primaryKey(),
  sku: varchar("sku", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  image: varchar("image", { length: 512 }).notNull(),
  price: int("price").notNull(),
  discountPrice: int("discountPrice"),
  sizes: varchar("sizes", { length: 255 }),
  listedDate: timestamp("listedDate").notNull(),
  stock: int("stock").notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const cartItems = mysqlTable(
  "cartItems",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => users.id),
    productId: bigint("productId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => products.id),
    size: varchar("size", { length: 64 }),
    quantity: int("quantity").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cart_user_product_size").on(t.userId, t.productId, t.size)],
);

export const orders = mysqlTable("orders", {
  id: serial("id").primaryKey(),
  orderNo: varchar("orderNo", { length: 32 }).notNull().unique(),
  userId: bigint("userId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => users.id),
  status: mysqlEnum("status", [
    "pending_payment",
    "payment_review",
    "approved",
    "rejected",
    "shipped",
    "completed",
    "cancelled",
  ])
    .notNull()
    .default("pending_payment"),
  total: int("total").notNull(),
  address: text("address"),
  note: text("note"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
});

export const orderItems = mysqlTable("orderItems", {
  id: serial("id").primaryKey(),
  orderId: bigint("orderId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => orders.id),
  productId: bigint("productId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => products.id),
  productName: varchar("productName", { length: 255 }).notNull(),
  sku: varchar("sku", { length: 64 }).notNull(),
  size: varchar("size", { length: 64 }),
  price: int("price").notNull(),
  quantity: int("quantity").notNull(),
});

export const paymentProofs = mysqlTable("paymentProofs", {
  id: serial("id").primaryKey(),
  orderId: bigint("orderId", { mode: "number", unsigned: true })
    .notNull()
    .references(() => orders.id),
  imagePath: varchar("imagePath", { length: 512 }).notNull(),
  status: mysqlEnum("status", ["pending", "approved", "rejected"])
    .notNull()
    .default("pending"),
  reviewedBy: bigint("reviewedBy", { mode: "number", unsigned: true }).references(
    () => users.id,
  ),
  reviewNote: text("reviewNote"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;
export type CartItem = typeof cartItems.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type PaymentProof = typeof paymentProofs.$inferSelect;
