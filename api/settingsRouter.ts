import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { siteSettings } from "@db/schema";
import { createRouter, publicQuery, staffProcedure, adminProcedure } from "./middleware";
import { logAudit } from "./audit";
import { PAYMENT_METHOD_IDS, PAYMENT_METHODS_SETTING_KEY } from "@contracts/paymentMethods";

/**
 * 全站設定（key-value）——
 * get：公開讀，但只准白名單 key（避免內部設定外洩）
 * upsert：staff/admin 寫一般文案 key，value ≤ 200 字
 * setPaymentMethods（2026-08-08 Glo 要求）：收款方式全網統一（/payment＋結帳步驟② 同一來源），
 *   **淨係管理員（admin）改得**；存 siteSettings key="payment_methods"（JSON）。
 */
const READ_KEYS = ["products_intro_title", "products_intro_sub", PAYMENT_METHODS_SETTING_KEY] as const;
const keySchema = z.enum(READ_KEYS);
// 寫入白名單（staff 可寫）：payment_methods 唔喺度——佢係 admin 專用，行 setPaymentMethods
const WRITE_KEYS = ["products_intro_title", "products_intro_sub"] as const;
const writeKeySchema = z.enum(WRITE_KEYS);

/** 收款方式逐項驗證（id 固定 4 個；extra 兩欄要齊先有得存，見 setPaymentMethods） */
const paymentMethodSchema = z.object({
	id: z.enum(PAYMENT_METHOD_IDS),
	label: z.string().trim().min(1, "名稱唔可以留空").max(40),
	subtitle: z.string().trim().max(40).default(""),
	accountLabel: z.string().trim().min(1, "帳號名稱唔可以留空").max(20),
	account: z.string().trim().min(1, "帳號唔可以留空").max(64),
	extraLabel: z.string().trim().max(20).default(""),
	extraValue: z.string().trim().max(64).default(""),
});

export const settingsRouter = createRouter({
	get: publicQuery
		.input(z.object({ key: keySchema }))
		.query(async ({ input }) => {
			const db = getDb();
			const row = await db.query.siteSettings.findFirst({
				where: eq(siteSettings.key, input.key),
			});
			return row ? { key: row.key, value: row.value } : null;
		}),

	upsert: staffProcedure
		.input(z.object({ key: writeKeySchema, value: z.string().max(200, "內容最長 200 字") }))
		.mutation(async ({ input, ctx }) => {
			const db = getDb();
			await db
				.insert(siteSettings)
				.values({ key: input.key, value: input.value, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: siteSettings.key,
					set: { value: input.value, updatedAt: new Date() },
				});
			void logAudit({
				actorId: ctx.user.userId,
				actorRole: ctx.user.role,
				action: "setting.upsert",
				targetType: "setting",
				targetId: input.key,
				detail: `更新設定 ${input.key}：「${input.value.slice(0, 50)}${input.value.length > 50 ? "…" : ""}」`,
			});
			return { ok: true as const };
		}),

	/**
	 * 收款方式（2026-08-08 Glo 要求）：全網統一來源，**淨係管理員改得**。
	 * 要齊 4 個固定 id（boc/payme/alipay/fps），按官方順序存 JSON；
	 * /payment 頁＋結帳步驟② 都讀呢個 key，改一次全網同步。
	 */
	setPaymentMethods: adminProcedure
		.input(
			z.object({
				methods: z.array(paymentMethodSchema).length(4, "要齊 4 個收款方式"),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// 4 個固定 id 齊（唔准重複／缺）先收
			const sortedIds = input.methods.map((m) => m.id).sort().join(",");
			if (sortedIds !== [...PAYMENT_METHOD_IDS].sort().join(",")) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "收款方式唔齊或重複" });
			}
			// 按官方順序排返先存（前台顯示順序一致）；extra 兩欄要齊先存，得一邊就當冇
			const ordered = PAYMENT_METHOD_IDS.map((id) => {
				const m = input.methods.find((x) => x.id === id)!;
				return {
					id: m.id,
					label: m.label,
					subtitle: m.subtitle,
					accountLabel: m.accountLabel,
					account: m.account,
					extraLabel: m.extraLabel && m.extraValue ? m.extraLabel : "",
					extraValue: m.extraLabel && m.extraValue ? m.extraValue : "",
				};
			});
			const db = getDb();
			const value = JSON.stringify(ordered);
			await db
				.insert(siteSettings)
				.values({ key: PAYMENT_METHODS_SETTING_KEY, value, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: siteSettings.key,
					set: { value, updatedAt: new Date() },
				});
			void logAudit({
				actorId: ctx.user.userId,
				actorRole: ctx.user.role,
				action: "setting.paymentMethods",
				targetType: "setting",
				targetId: PAYMENT_METHODS_SETTING_KEY,
				detail: `更新收款方式：${ordered.map((m) => `${m.label} ${m.account}`).join("；")}`,
			});
			return { ok: true as const };
		}),
});
