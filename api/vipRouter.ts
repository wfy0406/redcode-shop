/**
 * v2.1.0（VIP+免運，2026-09-29）：VIP 會員＋免運＋順豐站點 tRPC API。
 *
 * ─ getMyVip（登入）：我嘅 VIP 狀態＋本年度消費＋距離下一級差幾多（會員中心／導覽列 badge 用）
 * ─ getPublicVipConfig（公開）：VIP＋免運全部規則數值（VIP 介紹頁／結帳顯示用）
 * ─ checkoutQuote（登入）：結帳報價（VIP 折扣＋優惠碼＋免運判定，server 重算唔信前端）
 * ─ listStations（公開）：順豐站點下拉資料（只回 active）
 * ─ adminListStations／upsertStation／deleteStation／reseedDefaultStations（admin）：後台站點管理
 * 規則引擎同註解喺 api/vip.ts。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { sfStations, siteSettings, users } from "@db/schema";
import { createRouter, publicQuery, authedProcedure, adminProcedure } from "./middleware";
import { logAudit } from "./audit";
import { SF_STATIONS } from "./data/sfStations";
import { SF_STATIONS_FULL } from "./data/sfStationsFull"; // v2.1.0：reseed 用全量官方清單（HK 1654／MO 51）；樣例清單留作 fallback
import crypto from "node:crypto";
import {
  computeCheckoutQuote,
  effectiveVipTier,
  getShippingRules,
  getVipRules,
  regionInputSchema,
  deliveryMethodInputSchema,
  yearSpendCents,
  type VipTier,
} from "./vip";
import {
  buildVipCertJpeg,
  buildVipCertPdf,
  buildVipVerifyUrl,
  signVipCertMemberNo,
} from "./vipCert";

/** 會員專用 procedure（v2.2.0 證書下載用）；同 authedProcedure 一樣要 Bearer JWT，改名貼合契約叫法 */
const memberProcedure = authedProcedure;

/**
 * v2.2.0 門檻凍結：證書／驗證頁成就行嘅消費門檻＝升級嗰刻嘅快照（users.vipThresholdCents）；
 * 舊會員冇快照就落返 v2.2.0 前嘅歷史門檻（銀 $3000／金 $5000），**唔准用即時 rules**。
 */
function frozenThresholdCents(
  user: { vipThresholdCents: number | null },
  tier: "SILVER" | "GOLD",
): number {
  return user.vipThresholdCents ?? (tier === "GOLD" ? 500000 : 300000);
}

/**
 * 會員期限（月）由（生效日, 到期日）月份差 derive——證書凍結用，
 * 唔好用即時 rules.durationMonths（後台改期限唔影響已發證書）。
 */
function durationMonthsBetween(effectiveAt: Date, expiresAt: Date): number {
  const months =
    (expiresAt.getFullYear() - effectiveAt.getFullYear()) * 12 +
    (expiresAt.getMonth() - effectiveAt.getMonth());
  return Math.max(1, months);
}

/** 同 email.ts 嘅做法：SITE_URL 環境變數，去尾 slash */
function siteUrl(): string {
  return (process.env.SITE_URL || "https://redcode.red").replace(/\/+$/, "");
}

// ─────────────────── v2.2.0：順豐站點查詢頁（/#/sf-stations）地址定位＋最近站點 ───────────────────

const GEOCODE_TIMEOUT_MS = 10_000;
const GEOCODE_CACHE_MAX = 100;

/** geocode 結果（lat/lng/label）；Nominatim display_name 做 label */
interface GeocodeHit {
  lat: number;
  lng: number;
  label: string;
}

/**
 * 地址 → 坐標 in-memory LRU（最多 100 條；key 係 trim 後地址原文）。
 * 私隱：query 明文唔准落 log（淨係落長度／結果數）；cache 只存喺 server 記憶體，重開即清。
 */
const geocodeCache = new Map<string, GeocodeHit[]>();

function geocodeCacheGet(q: string): GeocodeHit[] | undefined {
  const hit = geocodeCache.get(q);
  if (hit) {
    // LRU：讀過就接返落尾（Map 保插入次序）
    geocodeCache.delete(q);
    geocodeCache.set(q, hit);
  }
  return hit;
}

function geocodeCacheSet(q: string, v: GeocodeHit[]): void {
  geocodeCache.delete(q);
  geocodeCache.set(q, v);
  if (geocodeCache.size > GEOCODE_CACHE_MAX) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest !== undefined) geocodeCache.delete(oldest);
  }
}

/* ─────────── v2.2.2 多源 geocode 引擎（私隱：呢啲函式永遠唔准 log query 明文）─────────── */

/** ① 香港政府 ALS：官方屋邨／屋苑／大廈地址庫，XML 回傳，lat/lng 直接係 WGS84。
 *  中英文 query 都食（官方 API 雙語）；label 跟 query 語言砌：中文查攞中文段，英文查攞英文段。 */
async function geocodeViaAls(q: string): Promise<GeocodeHit[]> {
  const res = await fetch(`https://www.als.gov.hk/lookup?q=${encodeURIComponent(q)}&n=5`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/xml" },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ALS HTTP ${res.status}`);
  const xml = await res.text();
  const hits: GeocodeHit[] = [];
  const hasCJK = /[\u4e00-\u9fff]/.test(q);
  // 逐個 <SuggestedAddress> block 拆：lat/lng＋按 query 語言攞相應地址段砌 label
  for (const block of xml.split("<SuggestedAddress>").slice(1)) {
    const lat = Number(/<Latitude>([\d.]+)<\/Latitude>/.exec(block)?.[1]);
    const lng = Number(/<Longitude>([\d.]+)<\/Longitude>/.exec(block)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (hasCJK) {
      // 只喺 <ChiPremisesAddress> 入面攞中文部件（英文段排前面，直接攞會攞錯英文）
      const chi = /<ChiPremisesAddress>([\s\S]*?)<\/ChiPremisesAddress>/.exec(block)?.[1] ?? "";
      const grab = (tag: string) =>
        new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(chi)?.[1]?.trim() ?? "";
      const district = grab("DcDistrict");
      const estate = grab("EstateName");
      const building = grab("BuildingName");
      const street = grab("StreetName");
      const noFrom = grab("BuildingNoFrom");
      const core = estate || building || street || q;
      const addrBits = [street && noFrom ? `${street}${noFrom}號` : street].filter(Boolean).join("");
      const label = [district, core, addrBits && !core.includes(street) ? addrBits : ""]
        .filter(Boolean)
        .join(" ");
      hits.push({ lat, lng, label: label || q });
    } else {
      // 英文查詢：攞 <EngPremisesAddress> 段，官方全大寫轉返 Title Case 先好睇
      const eng = /<EngPremisesAddress>([\s\S]*?)<\/EngPremisesAddress>/.exec(block)?.[1] ?? "";
      const grab = (tag: string) =>
        new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(eng)?.[1]?.trim() ?? "";
      const titleCase = (s: string) =>
        s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
      const district = titleCase(grab("DcDistrict"));
      const estate = titleCase(grab("EstateName"));
      const building = titleCase(grab("BuildingName"));
      const street = titleCase(grab("StreetName"));
      const noFrom = grab("BuildingNoFrom");
      const core = estate || building || street || q;
      const addrBits = [noFrom && street ? `${noFrom} ${street}` : street].filter(Boolean).join("");
      const label = [core, addrBits && !core.includes(street) ? addrBits : "", district]
        .filter(Boolean)
        .join(", ");
      hits.push({ lat, lng, label: label || q });
    }
  }
  return hits.slice(0, 5);
}

/** ② Nominatim（OSM）：v2.2.0 原有路線，HK＋MO，街道／地標穩；label 語言跟 query 走 */
async function geocodeViaNominatim(q: string): Promise<GeocodeHit[]> {
  const lang = /[\u4e00-\u9fff]/.test(q) ? "zh-HK" : "en";
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
    `&format=jsonv2&countrycodes=hk,mo&limit=5&accept-language=${lang}`;
  const res = await fetch(url, {
    headers: {
      // Nominatim 使用條款要求可識別 UA（寫明 RedCode/1.0＋聯絡網址）
      "User-Agent": "RedCode/1.0 (https://redcode.red; contact@redcode.red)",
      "Accept-Language": lang,
    },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const json: unknown = await res.json();
  return (Array.isArray(json) ? json : [])
    .map((r): GeocodeHit | null => {
      const o = r as { lat?: string; lon?: string; display_name?: string };
      const lat = Number(o?.lat);
      const lng = Number(o?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, label: typeof o?.display_name === "string" ? o.display_name : q };
    })
    .filter((r): r is GeocodeHit => r !== null);
}

/** ③ Photon（OSM 系）：模糊匹配強；過濾返 HK／MO 地理範圍先回（佢係全球引擎）；lang 跟 query */
async function geocodeViaPhoton(q: string): Promise<GeocodeHit[]> {
  const lang = /[\u4e00-\u9fff]/.test(q) ? "zh" : "en";
  const res = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=${lang}`,
    {
      headers: { "User-Agent": "RedCode/1.0 (https://redcode.red; contact@redcode.red)" },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const json: unknown = await res.json();
  const features = (json as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return [];
  const hits: GeocodeHit[] = [];
  for (const f of features) {
    const o = f as {
      geometry?: { coordinates?: number[] };
      properties?: { name?: string; street?: string; district?: string; city?: string };
    };
    const coords = o?.geometry?.coordinates;
    const lng = Number(coords?.[0]);
    const lat = Number(coords?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // HK：lat 22.13–22.57 lng 113.83–114.45；MO：lat 22.08–22.24 lng 113.52–113.66
    const inHK = lat >= 22.13 && lat <= 22.57 && lng >= 113.83 && lng <= 114.45;
    const inMO = lat >= 22.08 && lat <= 22.24 && lng >= 113.52 && lng <= 113.66;
    if (!inHK && !inMO) continue;
    const p = o.properties ?? {};
    const label = [p.district, p.name ?? p.street, p.city].filter(Boolean).join(" ") || q;
    hits.push({ lat, lng, label });
    if (hits.length >= 5) break;
  }
  return hits;
}

/** Haversine 大圓距離（km） */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // 地球半徑 km
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** checkoutQuote 內部錯誤 → 中文 TRPCError（同 orders.create 嘅口吻一致） */
function quoteError(e: unknown): never {
  const msg = e instanceof Error ? e.message : "";
  if (msg === "CART_EMPTY") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "購物車係空嘅" });
  }
  if (msg === "STATION_INVALID") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "站點唔存在或已停用" });
  }
  if (msg === "STATION_REGION_MISMATCH") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "站點同收件地區唔啱，請重新揀過" });
  }
  throw e;
}

const stationInputSchema = z.object({
  id: z.string().trim().min(1).max(64),
  region: z.enum(["HK", "MO"]),
  type: z.enum(["SF_STATION", "SF_LOCKER", "SERVICE_POINT"]),
  name: z.string().trim().min(1, "站點名稱唔可以留空").max(255),
  district: z.string().trim().max(64).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const vipRouter = createRouter({
  /**
   * 我嘅 VIP 狀態（登入）：級別（過期即當 NONE 顯示）＋生效／到期時間＋本年度已付款消費＋
   * 全部門檻／折扣率＋toNextTierCents（已係金就 0；銀就係距離金嘅差額；普通就係距離銀嘅差額）。
   */
  getMyVip: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(users.id, ctx.user.userId),
    });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "用戶不存在" });
    }
    const rules = await getVipRules();
    const spend = await yearSpendCents(ctx.user.userId);
    const tier: VipTier = effectiveVipTier(user);
    const toNextTierCents =
      tier === "GOLD"
        ? 0
        : tier === "SILVER"
          ? Math.max(0, rules.goldThresholdCents - spend)
          : Math.max(0, rules.silverThresholdCents - spend);
    return {
      tier,
      effectiveAt: tier === "NONE" ? null : user.vipEffectiveAt,
      expiresAt: tier === "NONE" ? null : user.vipExpiresAt,
      yearSpendCents: spend,
      silverThresholdCents: rules.silverThresholdCents,
      goldThresholdCents: rules.goldThresholdCents,
      silverDiscountBps: rules.silverDiscountBps,
      goldDiscountBps: rules.goldDiscountBps,
      toNextTierCents,
    };
  }),

  /**
   * v2.2.0：會員證書驗證（公開，唔使登入；/#/vip-verify 頁用）。
   * input c=會員編號（RC-000128 款）、s=HMAC-SHA256("vip-cert:"+memberNo, JWT_SECRET) hex。
   * timingSafeEqual 比對簽名；任何錯（格式錯／簽名錯／搵唔到／系統錯）都回 { ok:false, reason }，唔准 throw；
   * secret 唔准落 log。valid = tier∈SILVER/GOLD && expiresAt>now（過期都會返資料，valid=false 畀前端灰階顯示）。
   */
  verifyVipCert: publicQuery
    .input(z.object({ c: z.string().trim().max(32), s: z.string().trim().max(128) }))
    .query(async ({ input }) => {
      try {
        const m = /^RC-(\d{6,10})$/.exec(input.c);
        if (!m) return { ok: false as const, reason: "會員編號格式唔啱" };
        if (!/^[0-9a-f]{64}$/i.test(input.s)) {
          return { ok: false as const, reason: "驗證簽名格式唔啱" };
        }
        const expected = signVipCertMemberNo(input.c);
        if (!expected) return { ok: false as const, reason: "系統未設定驗證密鑰" };
        const a = Buffer.from(input.s.toLowerCase(), "utf8");
        const b = Buffer.from(expected, "utf8");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return { ok: false as const, reason: "驗證簽名唔啱" };
        }
        const db = getDb();
        const user = await db.query.users.findFirst({
          where: eq(users.id, Number(m[1])),
        });
        if (!user) return { ok: false as const, reason: "搵唔到呢個會員編號" };
        if (user.vipTier !== "SILVER" && user.vipTier !== "GOLD") {
          return { ok: false as const, reason: "此編號未有會員級別紀錄" };
        }
        // 上面守衛已保證 SILVER/GOLD（varchar 係 string，呢度明示收窄俾快照 helper 用）
        const certTier: "SILVER" | "GOLD" = user.vipTier === "GOLD" ? "GOLD" : "SILVER";
        const rules = await getVipRules();
        const valid = user.vipExpiresAt !== null && user.vipExpiresAt.getTime() > Date.now();
        return {
          ok: true as const,
          name: user.name,
          memberNo: input.c,
          tier: user.vipTier,
          effectiveAt: user.vipEffectiveAt?.toISOString() ?? "",
          expiresAt: user.vipExpiresAt?.toISOString() ?? "",
          valid,
          // v2.2.0 門檻凍結：成就行用升級嗰刻嘅快照；舊欄（即時 rules）保留兼容
          thresholdCents: frozenThresholdCents(user, certTier),
          silverThresholdCents: rules.silverThresholdCents,
          goldThresholdCents: rules.goldThresholdCents,
          durationMonths: rules.durationMonths,
        };
      } catch (e) {
        // 唔 log secret／簽名；只記錄錯誤訊息
        console.error("[vip] verifyVipCert 錯誤:", e instanceof Error ? e.message : e);
        return { ok: false as const, reason: "系統錯誤，請稍後再試" };
      }
    }),

  /**
   * v2.2.0：我嘅會員證書下載（登入會員；會員中心用）。
   * 歷史晉升都要出到：vipTier∈SILVER/GOLD（包括已過期）或 vipEffectiveAt 唔係 null 先准。
   * JPG 用 sharp 砌；PDF 用 pdf-lib 包 JPG（A4 直向）；builder 失敗回 ok:false，唔 throw。
   */
  myCertificate: memberProcedure
    .input(z.object({ format: z.enum(["jpg", "pdf"]) }))
    .query(async ({ ctx, input }) => {
      try {
        const db = getDb();
        const user = await db.query.users.findFirst({
          where: eq(users.id, ctx.user.userId),
        });
        if (!user) return { ok: false as const, error: "用戶不存在" };
        const hasRecord =
          user.vipTier === "SILVER" || user.vipTier === "GOLD" || user.vipEffectiveAt !== null;
        if (!hasRecord) return { ok: false as const, error: "未有會員級別紀錄" };
        // 過期後被重判落 NONE 嘅歷史會員：vipTier 已清但 vipEffectiveAt 留底——
        // 歷史晉升最低都係銀會員，證書用 SILVER 出（唔影響而家有效級別判定）
        const tier: "SILVER" | "GOLD" =
          user.vipTier === "GOLD" || user.vipTier === "SILVER" ? user.vipTier : "SILVER";
        const rules = await getVipRules();
        const effectiveAt = user.vipEffectiveAt ?? new Date();
        const expiresAt =
          user.vipExpiresAt ??
          (() => {
            const d = new Date(effectiveAt.getTime());
            d.setMonth(d.getMonth() + rules.durationMonths);
            return d;
          })();
        const memberNo = `RC-${String(user.id).padStart(6, "0")}`;
        const args = {
          name: user.name,
          memberNo,
          phone: user.phone ?? null,
          tier,
          effectiveAt,
          expiresAt,
          // v2.2.0 門檻凍結：成就行用升級嗰刻嘅門檻快照（冇快照先落歷史門檻），唔准用即時 rules
          thresholdCents: frozenThresholdCents(user, tier),
          // 會員期限由（生效日, 到期日）月份差 derive，唔好用即時 rules.durationMonths
          durationMonths: durationMonthsBetween(effectiveAt, expiresAt),
          verifyUrl: buildVipVerifyUrl(siteUrl(), memberNo),
        };
        const buf =
          input.format === "pdf" ? await buildVipCertPdf(args) : await buildVipCertJpeg(args);
        if (!buf) return { ok: false as const, error: "證書生成失敗，請稍後再試" };
        const tierLabel = tier === "GOLD" ? "金會員" : "銀會員";
        return {
          ok: true as const,
          filename: `RedCode-會員證書-${tierLabel}-${memberNo}.${input.format}`,
          base64: buf.toString("base64"),
        };
      } catch (e) {
        console.error("[vip] myCertificate 錯誤:", e instanceof Error ? e.message : e);
        return { ok: false as const, error: "證書生成失敗，請稍後再試" };
      }
    }),

  /** VIP＋免運全部規則數值（公開）：介紹頁／結帳頁顯示用；金額全部整數仙、折扣率 bps */
  getPublicVipConfig: publicQuery.query(async () => {
    const vip = await getVipRules();
    const shipping = await getShippingRules();
    return { ...vip, ...shipping };
  }),

  /**
   * 結帳報價（登入）：由 server 由購物車重算——
   * VIP 折扣（先）＋優惠碼（後，以 VIP 折後價做基數）＋免運判定；
   * 回契約欄位＋正規化後嘅 region/deliveryMethod/stationName 畀前端顯示。
   */
  checkoutQuote: authedProcedure
    .input(
      z.object({
        region: regionInputSchema,
        deliveryMethod: deliveryMethodInputSchema,
        stationId: z.string().trim().max(64).optional(),
        couponCode: z.string().trim().max(32).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const q = await computeCheckoutQuote(ctx.user.userId, input);
        return {
          subtotalCents: q.subtotalCents,
          vipDiscountCents: q.vipDiscountCents,
          couponDiscountCents: q.couponDiscountCents,
          totalCents: q.totalCents,
          shippingFree: q.shippingFree,
          shippingLabel: q.shippingLabel,
          remarks: q.remarks,
          region: q.region,
          deliveryMethod: q.deliveryMethod,
          stationId: q.stationId,
          stationName: q.stationName,
          vipTier: q.vipTier,
        };
      } catch (e) {
        quoteError(e);
      }
    }),

  /** 站點清單（公開）：只回 active，按 sortOrder→名稱排；下拉先揀地區再揀類型 */
  listStations: publicQuery
    .input(
      z.object({
        region: z.enum(["HK", "MO"]),
        type: z.enum(["SF_STATION", "SF_LOCKER", "SERVICE_POINT"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db.query.sfStations.findMany({
        where: and(
          eq(sfStations.region, input.region),
          eq(sfStations.active, true),
          input.type ? eq(sfStations.type, input.type) : undefined,
        ),
        orderBy: [asc(sfStations.sortOrder), asc(sfStations.name)],
      });
    }),

  /**
   * v2.2.2（順豐站點查詢頁，老闆指令「打屋邨、屋苑、大廈名都要有資料」）：地址 → 坐標（公開）。
   * 多源鏈（邊個先中就用邊個，全部 never-throw）：
   *   ① 香港政府地址識別服務 ALS（www.als.gov.hk，免費免 key，官方覆蓋全港屋邨／屋苑／大廈，
   *      回傳直接係 WGS84 lat/lng）——澳門關鍵字（澳門／氹仔／路環）跳過佢；
   *   ② Nominatim（OSM，HK＋MO）——v2.2.0 原有路線，街道／地標穩；
   *   ③ Photon（photon.komoot.io，OSM 系另一引擎，模糊匹配強）——過濾返 HK/MO 範圍先用。
   * 私隱鐵律：query 明文永遠唔落 log（淨落長度／來源／結果數）；in-memory LRU 100 條；逐源 timeout。
   */
  geocodeAddress: publicQuery
    .input(z.object({ q: z.string().trim().min(1).max(200) }))
    .query(async ({ input }) => {
      const q = input.q;
      const cached = geocodeCacheGet(q);
      if (cached) return { ok: true as const, results: cached };

      const isMacau = /澳門|氹仔|路環|澳氹/.test(q);
      const sources: Array<{ name: string; run: () => Promise<GeocodeHit[]> }> = [
        ...(isMacau ? [] : [{ name: "ALS", run: () => geocodeViaAls(q) }]),
        { name: "Nominatim", run: () => geocodeViaNominatim(q) },
        { name: "Photon", run: () => geocodeViaPhoton(q) },
      ];

      let anyNetworkError = false;
      for (const src of sources) {
        try {
          const results = await src.run();
          if (results.length > 0) {
            geocodeCacheSet(q, results);
            console.log(
              `[vip] geocodeAddress：來源 ${src.name}，query 長度 ${q.length}，結果 ${results.length} 條`,
            );
            return { ok: true as const, results };
          }
        } catch (e) {
          anyNetworkError = true;
          console.warn(
            `[vip] geocodeAddress 來源 ${src.name} 失敗（query 長度 ${q.length}）：`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      // 全部來源都係空結果 → 真係搵唔到；有來源炸過 → 提示稍後再試
      if (!anyNetworkError) {
        geocodeCacheSet(q, []);
        console.log(`[vip] geocodeAddress：query 長度 ${q.length}，三源皆無結果`);
        return { ok: true as const, results: [] };
      }
      return { ok: false as const, reason: "地址服務暫時唔可用，請稍後再試" };
    }),

  /**
   * v2.2.0（順豐站點查詢頁）：最近站點（公開）。
   * 撈 active＋有經緯度嘅站（region 唔傳就 HK+MO 一齊計），JS Haversine 排序回 top N，
   * 每個站加 distanceKm（兩位小數）；冇經緯度嘅站唔會出現（同步補齊前先咁）。
   */
  nearestStations: publicQuery
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        region: z.enum(["HK", "MO"]).optional(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.query.sfStations.findMany({
        where: and(
          eq(sfStations.active, true),
          isNotNull(sfStations.lat),
          isNotNull(sfStations.lng),
          input.region ? eq(sfStations.region, input.region) : undefined,
        ),
      });
      return rows
        .map((s) => ({
          ...s,
          distanceKm:
            Math.round(
              haversineKm(input.lat, input.lng, s.lat as number, s.lng as number) * 100,
            ) / 100,
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, input.limit);
    }),

  // ─────────────────────── 後台站點管理（admin 專用） ───────────────────────

  /** 後台站點列表（admin）：連停用嘅都回，俾管理員改 */
  adminListStations: adminProcedure.query(async () => {
    const db = getDb();
    return db.query.sfStations.findMany({
      orderBy: [asc(sfStations.region), asc(sfStations.sortOrder), asc(sfStations.name)],
    });
  }),

  /**
   * 新增／更新站點（admin）：id 存在就 update、唔存在就 insert；
   * undefined 嘅可選欄 update 時唔郁（insert 時用預設）。
   */
  upsertStation: adminProcedure
    .input(stationInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.sfStations.findFirst({
        where: eq(sfStations.id, input.id),
      });
      if (existing) {
        await db
          .update(sfStations)
          .set({
            region: input.region,
            type: input.type,
            name: input.name,
            district: input.district === undefined ? existing.district : input.district,
            address: input.address === undefined ? existing.address : input.address,
            active: input.active ?? existing.active,
            sortOrder: input.sortOrder ?? existing.sortOrder,
          })
          .where(eq(sfStations.id, input.id));
      } else {
        await db.insert(sfStations).values({
          id: input.id,
          region: input.region,
          type: input.type,
          name: input.name,
          district: input.district ?? null,
          address: input.address ?? null,
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
        });
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "station.upsert",
        targetType: "setting",
        targetId: input.id,
        detail: `${existing ? "更新" : "新增"}順豐站點「${input.name}」（${input.region}/${input.type}${input.active === false ? "，已停用" : ""}）`,
      });
      return { ok: true as const, created: !existing };
    }),

  /** 刪除站點（admin）：直接刪 row；歷史訂單有 stationName 快照，唔受影響 */
  deleteStation: adminProcedure
    .input(z.object({ id: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.sfStations.findFirst({
        where: eq(sfStations.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "站點唔存在" });
      }
      await db.delete(sfStations).where(eq(sfStations.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "station.delete",
        targetType: "setting",
        targetId: input.id,
        detail: `刪除順豐站點「${existing.name}」（${input.id}）`,
      });
      return { ok: true as const };
    }),

  /**
   * 重新導入預設站點清單（admin）：將 api/data/sfStations.ts 嘅樣例逐個 upsert——
   * 唔會清走後台自加嘅站；同 id 嘅站會被預設資料覆蓋（active 照舊保留而家值）。
   * 正式完整清單整合後，用呢度一掣倒入。
   */
  reseedDefaultStations: adminProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const SEED_LIST = (SF_STATIONS_FULL.length > 0 ? SF_STATIONS_FULL : SF_STATIONS.map((x, i) => ({ ...x, sortOrder: i })));
    for (const [i, s] of SEED_LIST.entries()) {
      await db
        .insert(sfStations)
        .values({ ...s, sortOrder: i })
        .onConflictDoUpdate({
          target: sfStations.id,
          set: {
            region: s.region,
            type: s.type,
            name: s.name,
            district: s.district ?? null,
            address: s.address ?? null,
            sortOrder: i,
          },
        });
    }
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "station.reseed",
      targetType: "setting",
      targetId: "sfStations",
      detail: `重新導入預設順豐站點清單（${SEED_LIST.length} 個站${SF_STATIONS_FULL.length > 0 ? "・全量官方清單" : "・樣例"}）`,
    });
    return { ok: true as const, count: SEED_LIST.length };
  }),

  /**
   * v2.1.1（Wave 2，2026-09-30）：立即同步順豐官方站點（admin 專用）。
   * 即跑一次 api/sfSync.ts 嘅全量同步（同每日排程同一條路），回 stats＋lastSyncAt；
   * 同步本身 never-throw，失敗類別會喺 stats.perTypeFailed 睇到。
   */
  adminSyncStationsNow: adminProcedure.mutation(async ({ ctx }) => {
    const { runSfSync } = await import("./sfSync"); // lazy import：同 boot.ts 嘅模組隔離款一致
    const stats = await runSfSync();
    const db = getDb();
    const lastSyncRow = await db.query.siteSettings.findFirst({
      where: eq(siteSettings.key, "sf.lastSyncAt"),
    });
    // v2.2.17（老闆指令：成功定失敗都要喺後台日誌睇到）：
    // 失敗唔再扮成功（以前全軍覆沒都會寫「新增 0、更新 0」），日誌照實寫，前端照實彈錯。
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "station.syncNow",
      targetType: "setting",
      targetId: "sfStations",
      detail: stats.ok
        ? `管理員手動即時同步順豐官方站點${stats.perTypeFailed.length > 0 ? "（部分失敗）" : "成功"}：新增 ${stats.added}、更新 ${stats.updated}、停用 ${stats.deactivated}${stats.perTypeFailed.length > 0 ? `；失敗類別：${stats.perTypeFailed.join("、")}` : ""}`
        : `管理員手動即時同步順豐官方站點失敗：${stats.error ?? "未知錯誤"}`,
    });
    return { ok: stats.ok, stats, lastSyncAt: lastSyncRow?.value ?? null, error: stats.error };
  }),

  /**
   * v2.2.17（老闆指令，2026-09-30）：順豐站點同步狀態（admin 專用）。
   * 站點管理面板頂嘅「上次同步」狀態行用——成功/部分失敗/失敗＋統計＋時間，
   * 唔使靠一閃即逝嘅 toast，管理員隨時入嚟都睇到最近一次同步結果。
   */
  adminStationSyncStatus: adminProcedure.query(async () => {
    const db = getDb();
    const read = async (key: string) => {
      const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, key) });
      return row?.value ?? null;
    };
    const [lastSyncAt, statsRaw, errorRaw] = await Promise.all([
      read("sf.lastSyncAt"),
      read("sf.lastSyncStats"),
      read("sf.lastSyncError"),
    ]);
    let stats: unknown = null;
    try {
      stats = statsRaw ? (JSON.parse(statsRaw) as unknown) : null;
    } catch {
      stats = null;
    }
    let lastError: { at: string; error: string } | null = null;
    try {
      if (errorRaw) lastError = JSON.parse(errorRaw) as { at: string; error: string };
    } catch {
      lastError = null;
    }
    return { lastSyncAt, stats, lastError };
  }),
});
