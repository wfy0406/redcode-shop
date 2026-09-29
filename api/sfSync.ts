/**
 * v2.1.1（Wave 2，2026-09-30）：順豐站點每日自動同步。
 * ─────────────────────────────
 * 背景（老闆原話）：「順豐站點有無得自動掃官網內部接口嘅最新全量清單，每1日自動掃一次？
 * 跟住個官網既點自動更新？」→ 答案：可以，唔使 API 簽約，用官網網點查詢內部接口每日同步。
 *
 * 接口規格（2026-09-30 主線實測，詳情見 plan.md Wave 2）：
 * ─ POST https://hk.sf-express.com/sf-service-core-web/service/serviceSupport/queryServiceNetworkList?region=HK&lang=tc
 * ─ body {"serviceType":"1|4"}＝順豐站（HK 全量 140，低於 1000 cap）；
 *   {"serviceType":"8|9|10"}＝自提點（501）；
 *   {"serviceType":"6"}＝智能櫃——全量會被截 1000（實際 1050），所以**逐街坊查**
 *   {"serviceType":"6","district":"大埔"}（簡體街坊名、唔加「區」），union by item.code 去重；
 * ─ 澳門：query string region=MO 無效（實測照返 HK 數據），要 body 加 "province":"澳門"，三類各一發即全量；
 * ─ 返回簡體（lang=tc 都係簡體）→ 用 api/data/sfS2T.ts 逐字轉繁；
 * ─ item.district 係街坊級 → api/data/sfNeighborhoodMap.ts 映射返議會區；
 *   映射表冇 → 轉繁後原值落 DB＋console.warn＋加埋入 siteSettings 'sf.extraDistricts'
 *   （下次智能櫃 fan-out 會包埋佢，自我修復）。
 *
 * Upsert 策略（種子行 id 係 HK-0001 款，同官方 code 唔同，靠 officialCode 追蹤）：
 * ① officialCode 匹配 → update name/address/district/active=true；
 * ② 冇 → 按 (region, type, 轉繁後 name) 精確匹配認親種子行 → 補寫 officialCode＋更新；
 * ③ 都冇 → 新增，id＝`${region}-O${code}`（避免撞 HK-#### 款），sortOrder＝該 region max+1。
 *
 * 停用策略（重要）：只停用「今次該 (region,type) 抓取完整成功」嘅類別；類別入面
 * officialCode 非 null 而今次 fetch 冇咗嘅行 → active=false。
 * officialCode＝null 嘅行（後台手加／未認親種子）永遠唔郁；部分失敗嘅類別唔准停用。
 *
 * 排程：boot 後約 30 秒檢查 siteSettings 'sf.lastSyncAt'，冇或超過 24 小時即跑一次；
 * 之後每 24 小時一次。全程 never-throw：任何失敗淨係 console.error，唔會冧 server。
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { sfStations, siteSettings } from "@db/schema";
import { logAudit } from "./audit";
import { SF_NEIGHBORHOOD_TO_DISTRICT } from "./data/sfNeighborhoodMap";
import { sfToTraditional } from "./data/sfS2T";

const SF_ENDPOINT =
  "https://hk.sf-express.com/sf-service-core-web/service/serviceSupport/queryServiceNetworkList?region=HK&lang=tc";
const REQUEST_TIMEOUT_MS = 25_000;
const REQUEST_GAP_MS = 150;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 30_000;

const SETTING_LAST_SYNC_AT = "sf.lastSyncAt";
const SETTING_LAST_SYNC_STATS = "sf.lastSyncStats";
const SETTING_EXTRA_DISTRICTS = "sf.extraDistricts";

/** 澳門四區（映射表原值直通；HK 智能櫃 fan-out 要剔除呢 4 個 key） */
const MO_NEIGHBORHOODS = new Set(["氹仔", "澳门半岛", "路氹城", "路环"]);

/** 官方接口返回嘅 item 形狀（欄位比用呢啲多，其餘忽略） */
interface SfNetworkItem {
  code?: string;
  name?: string;
  address?: string;
  district?: string;
}

export interface SfSyncStats {
  added: number;
  updated: number;
  deactivated: number;
  total: number;
  /** 抓取完整成功嘅 (region,type) 類別（只有呢啲類別會做停用） */
  categoriesOk: string[];
  /** 抓取失敗／不完整嘅類別（唔做停用） */
  perTypeFailed: string[];
}

// ───────────────────────────── 抓取層（never-throw） ─────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 順豐接口嘅站點類型（body serviceType 值）
 * → 本站 sfStations.type 對應：
 *   "1|4" 順豐站 → SF_STATION；"8|9|10" 自提點 → SERVICE_POINT；"6" 智能櫃 → SF_LOCKER
 */
type SfCategory = { region: "HK" | "MO"; type: "SF_STATION" | "SERVICE_POINT" | "SF_LOCKER"; serviceType: string };

const HK_CATEGORIES: SfCategory[] = [
  { region: "HK", type: "SF_STATION", serviceType: "1|4" },
  { region: "HK", type: "SERVICE_POINT", serviceType: "8|9|10" },
];

/** 單發請求（失敗 retry 一次）；任何失敗回 null，唔 throw */
async function fetchSfNetwork(body: Record<string, string>, label: string): Promise<SfNetworkItem[] | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(SF_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 官方接口對冇 UA 嘅請求有機會直接拒（實測要扮瀏覽器）
          "User-Agent": "Mozilla/5.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[sf-sync] ${label} HTTP ${res.status}（第 ${attempt} 次）`);
        continue;
      }
      const json: unknown = await res.json();
      // 接口包裹格式冇官方文件：防禦式搵第一個 array（實測係 { data: [...] } 款）
      const list = extractList(json);
      if (!list) {
        console.warn(`[sf-sync] ${label} 返回格式唔係預期（搵唔到清單 array）`);
        continue;
      }
      return list;
    } catch (e) {
      console.warn(
        `[sf-sync] ${label} 請求失敗（第 ${attempt} 次）：`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return null;
}

/** 由返回 JSON 入面搵出站點 array（直接 array／data／list／items／result／rows 逐個試） */
function extractList(json: unknown): SfNetworkItem[] | null {
  if (Array.isArray(json)) return json as SfNetworkItem[];
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of ["data", "list", "items", "result", "rows"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as SfNetworkItem[];
      // 有啲接口會再包一層 { data: { list: [...] } }
      if (v && typeof v === "object") {
        const nested = extractList(v);
        if (nested) return nested;
      }
    }
  }
  return null;
}

// ───────────────────────────── siteSettings 小 helper ─────────────────────────────

async function readSetting(key: string): Promise<string | null> {
  try {
    const db = getDb();
    const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, key) });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  await db
    .insert(siteSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
}

async function readExtraDistricts(): Promise<string[]> {
  const raw = await readSetting(SETTING_EXTRA_DISTRICTS);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ───────────────────────────── 主同步流程 ─────────────────────────────

let syncRunning = false; // 防重入：每日排程同後台手動唔會同時跑

/**
 * 即跑一次全量同步（排程同 adminSyncStationsNow 共用）。
 * never-throw：每個類別獨立 try，失敗嘅類別記入 perTypeFailed（唔做停用），其餘照做。
 */
export async function runSfSync(): Promise<SfSyncStats> {
  const stats: SfSyncStats = { added: 0, updated: 0, deactivated: 0, total: 0, categoriesOk: [], perTypeFailed: [] };
  if (syncRunning) {
    console.log("[sf-sync] 已經有同步緊，今次 skip");
    return stats;
  }
  syncRunning = true;
  try {
    const db = getDb();
    // 自我修復街坊表：映射表冇嘅新街坊會儲落嚟，下次智能櫃 fan-out 包埋佢
    const extraDistricts = new Set(await readExtraDistricts());
    // HK 智能櫃逐街坊查嘅清單：映射表 HK keys（剔除澳門 4 個）＋持久化咗嘅新街坊
    const hkLockerDistricts = [
      ...Object.keys(SF_NEIGHBORHOOD_TO_DISTRICT).filter((k) => !MO_NEIGHBORHOODS.has(k)),
      ...[...extraDistricts].filter((k) => !SF_NEIGHBORHOOD_TO_DISTRICT[k]),
    ];

    // ── 抓取全部類別：catKey → 官方 item 清單（union by code 去重）──
    // Map key：`${region}:${type}`
    const fetched = new Map<string, Map<string, SfNetworkItem>>();

    const grab = async (cat: SfCategory, body: Record<string, string>, label: string) => {
      const list = await fetchSfNetwork(body, label);
      await sleep(REQUEST_GAP_MS);
      if (list === null) {
        stats.perTypeFailed.push(`${cat.region}:${cat.type}`);
        return;
      }
      const key = `${cat.region}:${cat.type}`;
      const bucket = fetched.get(key) ?? new Map<string, SfNetworkItem>();
      for (const item of list) {
        if (item?.code) bucket.set(item.code, item); // union by code 去重
      }
      fetched.set(key, bucket);
    };

    // a/b. HK 順豐站＋自提點（一發全量）
    for (const cat of HK_CATEGORIES) {
      await grab(cat, { serviceType: cat.serviceType }, `HK ${cat.type} (${cat.serviceType})`);
    }
    // c. HK 智能櫃：全量會被截 1000（實際 1050）→ 必須逐街坊查（簡體街坊名、唔加「區」）
    const lockerCat: SfCategory = { region: "HK", type: "SF_LOCKER", serviceType: "6" };
    let lockerFailed = false;
    for (const district of hkLockerDistricts) {
      const list = await fetchSfNetwork({ serviceType: "6", district }, `HK SF_LOCKER ${district}`);
      await sleep(REQUEST_GAP_MS);
      if (list === null) {
        lockerFailed = true; // 任何一個街坊失敗 → 成個櫃類唔准做停用
        console.warn(`[sf-sync] 智能櫃街坊「${district}」抓取失敗，今次櫃類唔做停用`);
        continue;
      }
      const bucket = fetched.get("HK:SF_LOCKER") ?? new Map<string, SfNetworkItem>();
      for (const item of list) {
        if (item?.code) bucket.set(item.code, item);
      }
      fetched.set("HK:SF_LOCKER", bucket);
    }
    if (lockerFailed || hkLockerDistricts.length === 0) {
      // 部分失敗都當成個類別失敗（唔准停用），已 fetch 到嘅都唔 upsert（保守，等聽日重試）
      stats.perTypeFailed.push("HK:SF_LOCKER");
    }
    // d. 澳門：三個 serviceType 各加 "province":"澳門"（query string region=MO 無效，實測照返 HK）
    const MO_CATEGORIES: SfCategory[] = [
      { region: "MO", type: "SF_STATION", serviceType: "1|4" },
      { region: "MO", type: "SERVICE_POINT", serviceType: "8|9|10" },
      { region: "MO", type: "SF_LOCKER", serviceType: "6" },
    ];
    for (const cat of MO_CATEGORIES) {
      await grab(cat, { serviceType: cat.serviceType, province: "澳門" }, `MO ${cat.type} (${cat.serviceType})`);
    }

    // ── 逐類別 upsert＋停用 ──
    // 每個 region 嘅 sortOrder 現時最大值（新增行接尾）
    const maxSort = new Map<string, number>();
    for (const region of ["HK", "MO"] as const) {
      const [{ m }] = await db
        .select({ m: sql<number>`coalesce(max(${sfStations.sortOrder}), 0)::int` })
        .from(sfStations)
        .where(eq(sfStations.region, region));
      maxSort.set(region, m);
    }

    const newlyMappedDistricts = new Set<string>(); // 今次發現嘅新街坊（未入映射表）

    for (const [catKey, items] of fetched) {
      const [region, type] = catKey.split(":") as ["HK" | "MO", SfCategory["type"]];
      // 類別失敗（perTypeFailed 有份）→ 資料唔可信，成個類別 skip（唔 upsert 唔停用）
      if (stats.perTypeFailed.includes(catKey)) continue;
      stats.categoriesOk.push(catKey);
      stats.total += items.size;

      const existing = await db.query.sfStations.findMany({
        where: and(eq(sfStations.region, region), eq(sfStations.type, type)),
      });
      const byCode = new Map(existing.filter((s) => s.officialCode).map((s) => [s.officialCode as string, s]));
      const byName = new Map(existing.map((s) => [s.name, s]));
      const seenCodes = new Set<string>();

      for (const [code, item] of items) {
        seenCodes.add(code);
        const name = sfToTraditional(item.name ?? "").trim();
        if (!name) continue; // 冇名嘅行唔要
        const address = item.address ? sfToTraditional(item.address).trim() : null;
        // district：官方街坊級值 → 議會區映射；表冇 → 轉繁原值＋warn＋自我修復入 extraDistricts
        const rawDistrict = (item.district ?? "").trim();
        let district: string | null = null;
        if (rawDistrict) {
          const mapped = SF_NEIGHBORHOOD_TO_DISTRICT[rawDistrict];
          if (mapped) {
            district = mapped;
          } else {
            district = sfToTraditional(rawDistrict);
            if (!newlyMappedDistricts.has(rawDistrict) && !extraDistricts.has(rawDistrict)) {
              newlyMappedDistricts.add(rawDistrict);
              console.warn(`[sf-sync] 新街坊「${rawDistrict}」（轉繁：${district}）映射表冇，已用原值落 DB 並記入 sf.extraDistricts`);
            }
          }
        }

        // ① officialCode 匹配 → update＋重新啟用
        const hitByCode = byCode.get(code);
        if (hitByCode) {
          await db
            .update(sfStations)
            .set({ name, address, district, active: true })
            .where(eq(sfStations.id, hitByCode.id));
          stats.updated += 1;
          continue;
        }
        // ② (region, type, 轉繁後 name) 認親種子行 → 補寫 officialCode
        const hitByName = byName.get(name);
        if (hitByName) {
          await db
            .update(sfStations)
            .set({ officialCode: code, name, address, district, active: true })
            .where(eq(sfStations.id, hitByName.id));
          byCode.set(code, hitByName);
          stats.updated += 1;
          continue;
        }
        // ③ 新增：id＝`${region}-O${code}`（避免撞種子 HK-#### 款），sortOrder 接尾
        const nextSort = (maxSort.get(region) ?? 0) + 1;
        maxSort.set(region, nextSort);
        await db
          .insert(sfStations)
          .values({ id: `${region}-O${code}`, region, type, name, district, address, active: true, sortOrder: nextSort, officialCode: code })
          .onConflictDoNothing(); // 保險：id 撞咗（理論上唔會）就 skip，唔好冧成個 sync
        stats.added += 1;
      }

      // 停用：只限今次抓取完整成功嘅類別；officialCode 非 null 而今次冇咗嘅行 → active=false。
      // officialCode＝null（後台手加／未認親種子）永遠唔郁。
      const gone = existing.filter((s) => s.officialCode && !seenCodes.has(s.officialCode) && s.active);
      for (const s of gone) {
        await db.update(sfStations).set({ active: false }).where(eq(sfStations.id, s.id));
        stats.deactivated += 1;
      }
    }

    // 新街坊持久化：下次智能櫃 fan-out 會包埋佢（自我修復）
    if (newlyMappedDistricts.size > 0) {
      const merged = [...new Set([...extraDistricts, ...newlyMappedDistricts])];
      await writeSetting(SETTING_EXTRA_DISTRICTS, JSON.stringify(merged));
    }

    // 完成：寫低同步時間＋統計＋audit
    const now = new Date();
    await writeSetting(SETTING_LAST_SYNC_AT, now.toISOString());
    await writeSetting(SETTING_LAST_SYNC_STATS, JSON.stringify(stats));
    void logAudit({
      actorId: null,
      actorRole: "system",
      action: "station.sync",
      targetType: "setting",
      targetId: "sfStations",
      detail: `順豐站點每日同步完成：新增 ${stats.added}、更新 ${stats.updated}、停用 ${stats.deactivated}、官方合計 ${stats.total} 個點${stats.perTypeFailed.length > 0 ? `；失敗類別（未停用）：${stats.perTypeFailed.join("、")}` : ""}`,
    });
    console.log(
      `[sf-sync] 完成：+${stats.added} 更新 ${stats.updated} 停用 ${stats.deactivated}（官方 ${stats.total} 個點）${stats.perTypeFailed.length > 0 ? `；失敗類別 ${stats.perTypeFailed.join("/")}` : ""}`,
    );
    return stats;
  } catch (e) {
    // never-throw：任何意外淨係 log，站點清單維持現狀
    console.error("[sf-sync] 同步失敗:", e);
    return stats;
  } finally {
    syncRunning = false;
  }
}

/**
 * 開機啟動（款跟 orderSweeper）：boot 後約 30 秒檢查 'sf.lastSyncAt'，
 * 冇或超過 24 小時就即跑一次；之後每 24 小時一次。全部失敗淨係 log。
 */
export function startSfSync(): void {
  const due = async (): Promise<boolean> => {
    const raw = await readSetting(SETTING_LAST_SYNC_AT);
    if (!raw) return true;
    const t = Date.parse(raw);
    return Number.isNaN(t) || Date.now() - t >= SYNC_INTERVAL_MS;
  };
  const run = (label: string) =>
    void runSfSync().catch((e) => console.error(`[sf-sync] ${label}失敗:`, e));

  setTimeout(() => {
    void due()
      .then((isDue) => {
        if (isDue) run("首次同步");
        else console.log("[sf-sync] 上次同步未夠 24 小時，今次 skip");
      })
      .catch((e) => console.error("[sf-sync] 首次檢查失敗:", e));
  }, BOOT_DELAY_MS);
  setInterval(() => run("定時同步"), SYNC_INTERVAL_MS);
}
