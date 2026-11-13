/**
 * redcode.red 公開單據入口（v2026.11.13.1 SPEC §9，老闆新要求）：
 * 官網 server-side 白名單 gateway——客人經 `https://redcode.red/web-design-bill/<token>`
 * 開官網公開頁，官網 server 代佢向 WMS 攞公開單據資料／發起付款。
 *
 * 紅線：
 * - 只封裝 WMS `webDesignBilling.getPublic` 同 `webDesignBilling.confirmAndPay` 兩個 public
 *   procedure（UPSTREAM_PROCEDURES hardcode allowlist）；browser 唔可以傳任意 procedure/path。
 *   禁止 iframe／301/302 redirect／通用 /api/* 反向代理。
 * - server-to-server base 用 server-only env `WMS_BASE_URL`（同 wmsSync 口徑）；
 *   10s timeout；唔 forward cookies／authorization；只傳 JSON content-type、request id 同必要 body。
 * - 唔向 client 洩漏 WMS base、upstream error body、stack、headers 或 secrets；
 *   upstream 錯誤一律 sanitize 做安全中文訊息。
 * - public response 維持 WMS 現有 public-safe 欄位（白名單輸出，adjustLog 再剥一次操作員 `by`），
 *   兩個 procedure 經統一 no-store middleware 設 `Cache-Control: no-store`——
 *   middleware 喺 input 驗證之前行，成功／BAD_REQUEST／429／NOT_FOUND／upstream error 全部都有份。
 * - 保守 per-IP＋per-IP+token 滑窗 rate limit；limiter 只會拒絕多餘請求，
 *   confirmAndPay 嘅重試／雙擊防重繼續靠 WMS 原本嘅 intent 核對＋request id 冪等。
 *
 * onlineUrl 契約：WMS `getPublic` 已返 `onlineUrl`/`kind`/`notes`/`publicToken`（SPEC §9）；
 *   呢度仍逐項核實——route token 係權威（唔一致即拒），onlineUrl 永遠由官網 canonical base
 *   （PUBLIC_BASE_URL，default https://redcode.red）＋route token 重砌，唔信 upstream origin；
 *   上游缺欄（舊部署）嗰陣本地補返，舊 token 照樣開到（保留兼容，唔准整斷已發出單據）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "./middleware";
import { RateLimiter, clientIpFromRequest } from "./guestUtils";

// ───────────────────────── 設定（全部 server-only，唔入 VITE_*／前端 bundle）─────────────

/** 同 api/wmsSync.ts 口徑：server-only；呢個值永遠唔會出現喺回應或前端。 */
const DEFAULT_WMS_BASE_URL = "https://red-code-wms.onrender.com";
const DEFAULT_PUBLIC_BASE_URL = "https://redcode.red";
const UPSTREAM_TIMEOUT_MS = 10_000;

function wmsBaseUrl(): string {
  return (process.env.WMS_BASE_URL || DEFAULT_WMS_BASE_URL).replace(/\/+$/, "");
}

/** 公開單據頁 origin（QR／畫面顯示用）；只接受 HTTPS、無 userinfo/query/hash，移除尾 `/`；invalid 要 loud。 */
export function publicBillBaseUrl(): string {
  const raw = (process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL 設定唔係有效 URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_BASE_URL 只接受 https、唔准帶 userinfo/query/hash");
  }
  return url.origin;
}

// 公開 token：192-bit → 32 字 base64url（SPEC §9；舊 token 同一格式，天然兼容）
export const PUBLIC_BILL_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const tokenSchema = z.string().trim().regex(PUBLIC_BILL_TOKEN_RE, "單據連結格式唔正確");

/** 官網公開單據 canonical URL（畫面顯示＋QR payload 嘅唯一來源） */
export function webDesignPublicBillOnlineUrl(publicToken: string): string {
  if (!PUBLIC_BILL_TOKEN_RE.test(publicToken)) {
    throw new Error("publicToken 格式唔正確，唔可以出 onlineUrl");
  }
  return `${publicBillBaseUrl()}/web-design-bill/${publicToken}`;
}

// 上游 procedure allowlist（hardcode；browser 見唔到亦改唔到）
const UPSTREAM_PROCEDURES = {
  getPublic: { path: "webDesignBilling.getPublic", method: "GET" },
  confirmAndPay: { path: "webDesignBilling.confirmAndPay", method: "POST" },
} as const;
type UpstreamKey = keyof typeof UPSTREAM_PROCEDURES;

// ───────────────────────── Rate limit（保守滑窗；server 重啟清零可接受）─────────────────

// getPublic：每 IP+token 20 次/分鐘；每 IP 60 次/分鐘（擋 token 枚舉掃射）
const getPublicIpTokenLimiter = new RateLimiter(20, 60 * 1000);
const getPublicIpLimiter = new RateLimiter(60, 60 * 1000);
// confirmAndPay：每 IP+token 8 次/分鐘；每 IP 30 次/分鐘。
// 付款重試只會回 429（唔會建立新收款）；真正防雙單喺 WMS intent 核對＋request id 冪等。
const confirmIpTokenLimiter = new RateLimiter(8, 60 * 1000);
const confirmIpLimiter = new RateLimiter(30, 60 * 1000);

function assertAllowed(limiter: RateLimiter, key: string): void {
  if (!limiter.allow(key)) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "操作太頻密，請稍後再試" });
  }
}

// ───────────────────────── upstream transport（白名單封裝）──────────────────────────────

interface WmsTrpcEnvelope {
  result?: { data?: { json?: unknown } };
  error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
}

/** 對客人安全嘅通用錯誤（唔包 upstream body／base／stack） */
const UPSTREAM_GENERIC_ERROR = "暫時未能連接單據系統，請稍後再試";
const NOT_FOUND_MESSAGE = "單據不存在或連結已失效";

/**
 * 單向呼叫 allowlist 內嘅 WMS public procedure。
 * - 10s timeout；headers 只有 Content-Type／x-request-id（**唔 forward** 客人 cookies/authorization）
 * - 回傳 `result.data.json`（superjson payload；日期會係 ISO string，前端 normalize 支援）
 * - 所有失敗都 sanitize；server log 只記 procedure＋HTTP status，唔記 base/secrets。
 */
async function callUpstream(kind: UpstreamKey, input: Record<string, unknown>): Promise<unknown> {
  const proc = UPSTREAM_PROCEDURES[kind]; // hardcode allowlist——呢個 map 以外冇路去 WMS
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-request-id": randomUUID(),
    };
    let resp: Response;
    if (proc.method === "GET") {
      const qs = encodeURIComponent(JSON.stringify({ json: input }));
      resp = await fetch(`${wmsBaseUrl()}/api/trpc/${proc.path}?input=${qs}`, {
        method: "GET",
        headers,
        signal: ctrl.signal,
      });
    } else {
      resp = await fetch(`${wmsBaseUrl()}/api/trpc/${proc.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ json: input }),
        signal: ctrl.signal,
      });
    }
    const data = (await resp.json().catch(() => null)) as WmsTrpcEnvelope | null;
    const upstreamErr = data?.error?.json;
    if (upstreamErr) {
      const code = upstreamErr.data?.code;
      if (code === "NOT_FOUND" || upstreamErr.data?.httpStatus === 404) {
        throw new TRPCError({ code: "NOT_FOUND", message: NOT_FOUND_MESSAGE });
      }
      console.error(`[wd-public-bill] upstream ${proc.path} 回錯（已對客人隱藏細節）`);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: UPSTREAM_GENERIC_ERROR });
    }
    if (!resp.ok || !data?.result) {
      console.error(`[wd-public-bill] upstream ${proc.path} HTTP ${resp.status}（已對客人隱藏細節）`);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: UPSTREAM_GENERIC_ERROR });
    }
    return data.result.data?.json;
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    const isTimeout = e instanceof Error && e.name === "AbortError";
    console.error(
      `[wd-public-bill] upstream ${proc.path} ${isTimeout ? `timeout ${UPSTREAM_TIMEOUT_MS / 1000}s` : "連接失敗"}（已對客人隱藏細節）`,
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: isTimeout ? "單據系統回應逾時，請稍後再試" : UPSTREAM_GENERIC_ERROR,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── public-safe 輸出（白名單欄位，防上游洩漏內部資料）────────────

const billItemSchema = z.object({
  code: z.string().nullish(),
  name: z.string().max(500).catch(""),
  qty: z.number().finite().catch(1),
  unitPriceCents: z.number().int().catch(0),
  amountCents: z.number().int().catch(0),
  origPriceCents: z.number().int().optional(),
  discountCents: z.number().int().optional(),
});

// 公開調整紀錄：時間／金額／原因可以公開；操作員 `by` 屬內部資料，呢度唔收（再剥一層保險）
const adjustEntrySchema = z.object({
  at: z.string().nullish(),
  fromCents: z.number().int().optional(),
  toCents: z.number().int().optional(),
  deltaCents: z.number().int().catch(0),
  reason: z.string().max(500).optional(),
});

// 專案單備註 snapshot：公開 text＋updatedAt；updatedBy（員工）唔准外出
const noteSchema = z.object({
  id: z.string().max(100).nullish(),
  text: z.string().max(2000).catch(""),
  updatedAt: z.string().nullish(),
});

/**
 * getPublic 白名單輸出 schema——只有呢啲欄位會返去客人；
 * 任何上游多返嘅內部欄位（fee/net、操作員、session、sourcePayload…）一律 drop。
 */
const publicBillSchema = z
  .object({
    billNo: z.string().trim().min(1).max(100),
    period: z.string().max(20).nullable().catch(null),
    kind: z.enum(["monthly", "project"]).catch("monthly"),
    projectTitle: z.string().max(300).nullable().catch(null),
    publicToken: z.string().max(64).nullish(),
    onlineUrl: z.string().max(500).nullish(),
    notes: z.array(noteSchema).max(200).catch([]),
    customerName: z.string().max(200).catch(""),
    items: z.array(billItemSchema).max(500).catch([]),
    subtotalCents: z.number().int().catch(0),
    adjustCents: z.number().int().catch(0),
    adjustLog: z.array(adjustEntrySchema).max(100).catch([]),
    finalCents: z.number().int(),
    status: z.string().max(20).catch("issued"),
    mode: z.string().max(10).catch("live"),
    orderDate: z.string().max(40).nullable().catch(null),
    sessionNo: z.string().max(40).nullable().catch(null),
    remark: z.string().max(2000).nullable().catch(null),
    createdAt: z.string().nullable().catch(null),
    paidAt: z.string().nullable().catch(null),
    paymentMethod: z.string().max(40).nullable().catch(null),
    customerPaidCents: z.number().int().nullable().catch(null),
    refundedAt: z.string().nullable().catch(null),
    refundedCents: z.number().int().nullable().catch(null),
    refundStatus: z.string().max(20).nullable().catch(null),
    companyName: z.string().max(200).nullable().catch(null),
    surchargeOn: z.boolean().nullable().catch(null),
  })
  .strip();

export type PublicBillPayload = z.infer<typeof publicBillSchema>;

/**
 * onlineUrl 永遠由官網 canonical base（PUBLIC_BASE_URL，default https://redcode.red）＋
 * **route token** 重砌；唔信 upstream 返嘅任何 origin（防 evil.example 或 WMS 內部域名外洩）。
 * 上游 onlineUrl 只作 cross-check：存在但同 canonical 唔同 → loud server log（設定漂移），
 * 對外仍只返 canonical。
 */
export function resolveOnlineUrl(upstream: unknown, routeToken: string): string {
  const canonical = webDesignPublicBillOnlineUrl(routeToken);
  if (typeof upstream === "string" && upstream.trim() && upstream.trim() !== canonical) {
    console.error("[wd-public-bill] upstream onlineUrl 同官網 canonical 唔一致，已忽略 upstream 值（詳情唔向客人披露）");
  }
  return canonical;
}

/**
 * 上游 getPublic payload → 官網 public-safe payload（白名單＋onlineUrl adapter）。
 * route token 係權威：上游 publicToken 存在但同 route token 唔一致 → 拒絕（唔准改用另一張單嘅 token）。
 */
export function sanitizePublicBill(raw: unknown, token: string): PublicBillPayload {
  const parsed = publicBillSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[wd-public-bill] upstream getPublic payload 唔合約（已對客人隱藏細節）");
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: UPSTREAM_GENERIC_ERROR });
  }
  const bill = parsed.data;
  if (typeof bill.publicToken === "string" && bill.publicToken.trim() && bill.publicToken !== token) {
    console.error("[wd-public-bill] upstream publicToken 同 route token 唔一致，已拒絕（詳情唔向客人披露）");
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: UPSTREAM_GENERIC_ERROR });
  }
  return {
    ...bill,
    publicToken: token,
    onlineUrl: resolveOnlineUrl(bill.onlineUrl, token),
    // 雙保險：就算上游漏咗 `by`／`updatedBy`，輸出都唔會有
    adjustLog: bill.adjustLog.map((entry) => ({ ...entry })),
    notes: bill.notes.map((n) => ({ id: n.id ?? null, text: n.text, updatedAt: n.updatedAt ?? null })),
  };
}

// ───────────────────────── confirmAndPay 合約（同 WMS public bill 一字不變）─────────────

// 同 WMS v2026.11.12.1：returnUrl 必填、只接受 http/https（防 javascript: 偽協議）。
// SPEC §9 收緊：returnUrl 必須係官網公開 origin（PUBLIC_BASE_URL）＋ path 係同一張
// `/web-design-bill/<route token>`（query/hash 可留，畀 Airwallex 回跳帶狀態）——
// 避免公開 API 被用嚟製造任意外部付款返回位。
const returnUrlSchema = z.string().trim().min(1, "返回網址必填").max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "返回網址只接受 http/https");

/** returnUrl 同源＋同單據 path 檢查（route token 權威） */
export function returnUrlMatchesBill(returnUrl: string, routeToken: string): boolean {
  try {
    const url = new URL(returnUrl);
    return url.origin === publicBillBaseUrl() && url.pathname === `/web-design-bill/${routeToken}`;
  } catch {
    return false;
  }
}

// 現行 WMS confirmAndPay 合約只返 intentId/clientSecret/env/error。
// 舊後端嘅 { url } / { redirectUrl } 直接跳轉欄喺呢個新官網 gateway **完全唔收**：
// schema 冇呢兩欄 + .strip()，upstream 就算返咗都會被 drop（唔會到前端，前端亦冇咗 full-page redirect 分支）。
// 舊 WMS public route 自身嘅兼容唔受影響（佢係另一條路）。
const confirmResultSchema = z
  .object({
    ok: z.boolean(),
    intentId: z.string().max(200).optional(),
    clientSecret: z.string().max(2000).optional(),
    env: z.enum(["prod", "demo"]).optional(),
    error: z.string().max(300).optional(),
  })
  .strip();

// WMS confirmAndPay 已知對客人安全嘅錯誤訊息（web-design-billing-router.ts v2026.11.12.1 逐字對照）。
// 維護註解：WMS 加新用戶向訊息時要同步呢個 whitelist。
const KNOWN_SAFE_PAY_ERRORS = new Set([
  "單據已付款，多謝支持",
  "單據已退款",
  "單據已作廢，請聯絡 Red Code 重新發出",
  "單據金額無效，請聯絡 Red Code",
  "支付平台未設定",
  "暫時未能核實上一筆付款狀態，請稍後再試；系統冇建立新付款",
  "付款紀錄核對唔通過，為安全起見未入賬，請聯絡 Red Code 人手核實（唔會重複收費）",
  "支付平台回應異常，請稍後再試",
  "單據不存在或連結已失效",
]);

const CONFIRM_GENERIC_ERROR = "暫時未能發起付款，請稍後再試";

/**
 * 上游 confirmAndPay 錯誤訊息只放行 KNOWN_SAFE_PAY_ERRORS 白名單；
 * 任何其他字串（可能含 WMS 內部 URL／stack／平台原始錯誤）統一換做安全通用訊息。
 */
export function sanitizePayErrorMessage(raw: unknown): string {
  if (typeof raw === "string" && KNOWN_SAFE_PAY_ERRORS.has(raw.trim())) return raw.trim();
  if (raw != null) {
    console.error("[wd-public-bill] upstream confirmAndPay 錯誤訊息唔喺白名單，已對客人隱藏");
  }
  return CONFIRM_GENERIC_ERROR;
}

/**
 * confirmAndPay 輸出白名單：欄位逐個核對；錯誤訊息只放行已知安全字句。
 * legacy `url`/`redirectUrl` 跳轉欄永遠唔放行（.strip() drop＋loud log）——
 * 呢度係新官網 gateway，只保留 Airwallex HPP intent flow（intentId/clientSecret/env）。
 */
export function sanitizeConfirmResult(raw: unknown): z.infer<typeof confirmResultSchema> {
  const parsed = confirmResultSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[wd-public-bill] upstream confirmAndPay payload 唔合約（已對客人隱藏細節）");
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: UPSTREAM_GENERIC_ERROR });
  }
  const r = parsed.data;
  if (
    typeof raw === "object" &&
    raw !== null &&
    (typeof (raw as Record<string, unknown>).url === "string" || typeof (raw as Record<string, unknown>).redirectUrl === "string")
  ) {
    // 上游返咗 legacy 跳轉欄：已 strip，唔會落到前端；記 loud log 方便發現上游漂移
    console.error("[wd-public-bill] upstream confirmAndPay 返咗 legacy url/redirectUrl 跳轉欄，已拒絕轉發（詳情唔向客人披露）");
  }
  if (r.ok && (!r.intentId || !r.clientSecret)) {
    console.error("[wd-public-bill] upstream confirmAndPay ok 但缺 intent/clientSecret");
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "支付平台回應異常，請稍後再試" });
  }
  if (r.ok) return r;
  return { ok: false as const, error: sanitizePayErrorMessage(r.error) };
}

// ───────────────────────── tRPC router（公開；掛落 appRouter.webDesignPublicBill）────────

/**
 * 公開單據統一 no-store：單據狀態會變（付款／退款／作廢），任何回應都唔准 cache。
 * 一定要係 middleware 而唔係齋喺成功 handler set：`.use()` 排喺 `.input()` 之前，
 * 所以 input 驗證 BAD_REQUEST、rate-limit 429、NOT_FOUND、upstream error 全部都經呢度，
 * resHeaders 喺成功同錯誤回應都一樣有 `Cache-Control: no-store`。
 */
const publicBillProcedure = publicQuery.use(async ({ ctx, next }) => {
  ctx.resHeaders.set("Cache-Control", "no-store");
  return next();
});

export const webDesignPublicBillRouter = createRouter({
  /** 讀公開單據（SPEC §9）：白名單代理 WMS webDesignBilling.getPublic */
  getPublic: publicBillProcedure
    .input(z.object({ token: tokenSchema }).strict())
    .query(async ({ ctx, input }) => {
      const ip = clientIpFromRequest(ctx.req);
      assertAllowed(getPublicIpLimiter, `gp:${ip}`);
      assertAllowed(getPublicIpTokenLimiter, `gp:${ip}:${input.token}`);
      const raw = await callUpstream("getPublic", { token: input.token });
      return sanitizePublicBill(raw, input.token);
    }),

  /** 確認付款 → Airwallex intent（SPEC §9）：白名單代理 WMS webDesignBilling.confirmAndPay */
  confirmAndPay: publicBillProcedure
    .input(
      z
        .object({ token: tokenSchema, returnUrl: returnUrlSchema })
        .strict()
        .refine((v) => returnUrlMatchesBill(v.returnUrl, v.token), {
          message: "返回網址必須係呢張單據嘅官網公開連結",
          path: ["returnUrl"],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      // 顯式強制（input .refine 之外嘅第二重把關）：returnUrl 唔係呢張單嘅官網公開連結 → 即 BAD_REQUEST，
      // 保證 upstream fetch 一次都唔會發生。
      if (!returnUrlMatchesBill(input.returnUrl, input.token)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "返回網址必須係呢張單據嘅官網公開連結" });
      }
      const ip = clientIpFromRequest(ctx.req);
      assertAllowed(confirmIpLimiter, `cp:${ip}`);
      assertAllowed(confirmIpTokenLimiter, `cp:${ip}:${input.token}`);
      const raw = await callUpstream("confirmAndPay", {
        token: input.token,
        returnUrl: input.returnUrl,
      });
      return sanitizeConfirmResult(raw);
    }),
});
