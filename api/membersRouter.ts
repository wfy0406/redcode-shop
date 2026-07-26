import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, users } from "@db/schema";
import { createRouter, adminProcedure } from "./middleware";

/**
 * 會員列表 —— admin only
 * totalSpent 排除 cancelled/rejected；按註冊時間 createdAt desc
 */
export const membersRouter = createRouter({
  list: adminProcedure.query(async () => {
    const db = getDb();
    return db
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        email: users.email,
        createdAt: users.createdAt,
        orderCount: sql<number>`count(${orders.id})::int`,
        totalSpent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} not in ('cancelled', 'rejected')), 0)::int`,
      })
      .from(users)
      .leftJoin(orders, eq(orders.userId, users.id))
      .where(eq(users.role, "member"))
      .groupBy(users.id)
      .orderBy(desc(users.createdAt));
  }),
});
