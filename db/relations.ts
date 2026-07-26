import { relations } from "drizzle-orm";
import {
  users,
  products,
  cartItems,
  orders,
  orderItems,
  paymentProofs,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  cartItems: many(cartItems),
  orders: many(orders),
  reviewedProofs: many(paymentProofs),
}));

export const productsRelations = relations(products, ({ many }) => ({
  cartItems: many(cartItems),
  orderItems: many(orderItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  user: one(users, {
    fields: [cartItems.userId],
    references: [users.id],
  }),
  product: one(products, {
    fields: [cartItems.productId],
    references: [products.id],
  }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  items: many(orderItems),
  proofs: many(paymentProofs),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

export const paymentProofsRelations = relations(paymentProofs, ({ one }) => ({
  order: one(orders, {
    fields: [paymentProofs.orderId],
    references: [orders.id],
  }),
  reviewer: one(users, {
    fields: [paymentProofs.reviewedBy],
    references: [users.id],
  }),
}));
