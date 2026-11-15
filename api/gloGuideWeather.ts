/**
 * Glo Glo 精選配搭指南——香港天文台（HKO）九天預報 server-only provider。
 *
 * SPEC v1 生成流程第 2 步：
 * ─ 取 https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=tc；
 * ─ 以 Asia/Hong_Kong 計「明日」起 7 日；
 * ─ parse 真數值（forecastMaxtemp/forecastMintemp.value），唔係真數就當失敗；
 * ─ 失敗降級次序：最近成功快取（source=hko-stale）→ 季節 fallback（source=seasonal）；
 * ─ 季節 fallback 唔作任何具體天氣斷言。
 *
 * 對 orchestrator 嘅接合契約（見 ./gloGuideProviders.ts）：
 *   getGloGuideWeather(): Promise<GloGuideWeatherResult> —— 永遠唔 throw，
 *   成功／降級狀態由 source 欄如實標示。
 *
 * fetch 同 now 可經可選 options 注入，測試唔使掂網絡；正式調用唔使傳。
 */

import { GloGuideProviderError, type GloGuideWeatherResult } from "./gloGuideProviders";

export const HKO_FND_URL =
  "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=tc";
export const GLO_GUIDE_WEATHER_DAYS = 7;
export const GLO_GUIDE_WEATHER_TIMEOUT_MS = 10_000;

interface GloGuideWeatherDay {
  /** 香港本地日期 YYYY-MM-DD */
  date: string;
  /** HKO 星期描述（如「星期一」） */
  week: string | null;
  minTempC: number | null;
  maxTempC: number | null;
  /** HKO 原文天氣描述 */
  summary: string | null;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 可選注入（測試用）；正式調用唔使傳。 */
export interface GloGuideWeatherOptions {
  fetchImpl?: FetchLike;
  /** 注入「而家」；預設 new Date() */
  now?: Date;
}

// ──────────────────────────── 香港日期工具 ────────────────────────────

const HK_TZ = "Asia/Hong_Kong";

function hkYmd(now: Date, offsetDays: number): { ymd: string; compact: string; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HK_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    const n = part ? Number(part.value) : NaN;
    if (!Number.isInteger(n)) {
      throw new GloGuideProviderError("HK_DATE", "計唔到香港日期");
    }
    return n;
  };
  const shifted = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + offsetDays));
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { ymd: `${y}-${pad(m)}-${pad(d)}`, compact: `${y}${pad(m)}${pad(d)}`, month: m };
}

/** 香港月份 → 季節（3–5 春、6–8 夏、9–11 秋、12–2 冬） */
export function gloGuideSeason(month: number): string {
  if (month >= 3 && month <= 5) return "春季";
  if (month >= 6 && month <= 8) return "夏季";
  if (month >= 9 && month <= 11) return "秋季";
  return "冬季";
}

// ──────────────────────────── HKO fnd parse ────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 真數值先收：number finite，或純數字字串；其他（null／{}／"--"）一律唔收 */
function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function tempOf(day: Record<string, unknown>, key: string): number | null {
  return numericValue(record(day[key]).value ?? day[key]);
}

function compactToYmd(compact: string): string | null {
  if (!/^\d{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function forecastEntries(payload: unknown, fromCompact: string): Record<string, unknown>[] {
  const list = record(payload).weatherForecast;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => record(entry))
    .filter((entry) => {
      const date = entry.forecastDate;
      return typeof date === "string" && /^\d{8}$/.test(date) && date >= fromCompact;
    })
    .sort((a, b) => String(a.forecastDate).localeCompare(String(b.forecastDate)));
}

function entryToDay(entry: Record<string, unknown>): GloGuideWeatherDay | null {
  const date = compactToYmd(String(entry.forecastDate));
  if (!date) return null;
  return {
    date,
    week: typeof entry.week === "string" && entry.week.trim() ? entry.week.trim() : null,
    minTempC: tempOf(entry, "forecastMintemp"),
    maxTempC: tempOf(entry, "forecastMaxtemp"),
    summary:
      typeof entry.forecastWeather === "string" && entry.forecastWeather.trim()
        ? entry.forecastWeather.trim()
        : null,
  };
}

/**
 * 嚴格 parse：夠 7 日、每日 min/max 都係真數值先算成功；唔達標 throw（內部用，對外唔 throw）。
 * 每日都齊先至入快取——唔會快取殘缺資料當新鮮。
 */
function parseHkoStrict(payload: unknown, fromCompact: string): GloGuideWeatherDay[] {
  const days = forecastEntries(payload, fromCompact)
    .slice(0, GLO_GUIDE_WEATHER_DAYS)
    .map(entryToDay)
    .filter((day): day is GloGuideWeatherDay => day !== null);
  if (days.length < GLO_GUIDE_WEATHER_DAYS) {
    throw new GloGuideProviderError(
      "HKO_BAD_PAYLOAD",
      `天文台預報日數唔足 ${GLO_GUIDE_WEATHER_DAYS} 日`,
    );
  }
  for (const day of days) {
    if (day.minTempC === null || day.maxTempC === null) {
      throw new GloGuideProviderError("HKO_BAD_PAYLOAD", "天文台預報缺溫度數值");
    }
  }
  return days;
}

/** 寬鬆 parse：每日只要有最少一個真溫度欄就保留；冇就整日丟。 */
function parseHkoPartial(payload: unknown, fromCompact: string): GloGuideWeatherDay[] {
  return forecastEntries(payload, fromCompact)
    .slice(0, GLO_GUIDE_WEATHER_DAYS)
    .map(entryToDay)
    .filter(
      (day): day is GloGuideWeatherDay =>
        day !== null && (day.minTempC !== null || day.maxTempC !== null),
    );
}

function dayToLine(day: GloGuideWeatherDay): string {
  const temps =
    day.minTempC !== null && day.maxTempC !== null
      ? `${day.minTempC}–${day.maxTempC}°C`
      : day.maxTempC !== null
        ? `最高 ${day.maxTempC}°C`
        : day.minTempC !== null
          ? `最低 ${day.minTempC}°C`
          : "溫度暫缺";
  const desc = day.summary ? `，${day.summary}` : "";
  return `${day.date}${day.week ? `（${day.week}）` : ""}：${temps}${desc}`;
}

// ──────────────────────────── 快取（最近成功） ────────────────────────────

let lastGood: { fetchedAtMs: number; fetchedAt: string; lines: string[] } | null = null;

/** 測試專用：清快取，避免用例之間互相污染。 */
export function __resetGloGuideWeatherCacheForTests(): void {
  lastGood = null;
}

// ──────────────────────────── 主流程 ────────────────────────────

async function fetchHkoPayload(fetchImpl: FetchLike): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLO_GUIDE_WEATHER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(HKO_FND_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new GloGuideProviderError(
      "HKO_NETWORK",
      error instanceof Error && error.name === "AbortError"
        ? "天文台天氣服務回應逾時"
        : "暫時連唔到天文台天氣服務",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new GloGuideProviderError(
      "HKO_HTTP",
      `天文台天氣服務回應 HTTP ${response.status}`,
      response.status >= 500,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new GloGuideProviderError("HKO_BAD_JSON", "天文台天氣服務回應唔係有效 JSON");
  }
}

function staleResult(now: Date): GloGuideWeatherResult | null {
  if (!lastGood) return null;
  const ageHours = Math.max(0, Math.round((now.getTime() - lastGood.fetchedAtMs) / 3_600_000));
  return {
    source: "hko-stale",
    lines: [
      `（天文台最新資料暫時取唔到，以下係約 ${ageHours} 小時前成功讀取嘅預報快取）`,
      ...lastGood.lines,
    ],
    // 如實標示資料真正取得成功嗰刻，唔好用而家時間扮新鮮
    fetchedAt: lastGood.fetchedAt,
  };
}

function seasonalResult(now: Date): GloGuideWeatherResult {
  const season = gloGuideSeason(hkYmd(now, 0).month);
  return {
    source: "seasonal",
    lines: [
      `未來 7 日天氣資料暫時未能由天文台取得；而家係香港${season}，` +
        `只可按季節作一般穿著建議，唔好斷言任何具體天氣（例如「聽日會落雨」「氣溫 28 度」）。`,
    ],
    fetchedAt: now.toISOString(),
  };
}

/**
 * 取香港明日起 7 日天氣（接合契約 export，orchestrator 經 defaultGloGuideProviders() 調用）。
 *
 * 失敗降級次序：stale 快取 → 回應入面仲用得嘅溫度欄 → 季節 fallback。
 * 對外**唔會 throw**；來源同降級狀態由 source／lines 如實標示。
 */
export async function getGloGuideWeather(
  options: GloGuideWeatherOptions = {},
): Promise<GloGuideWeatherResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const tomorrow = hkYmd(now, 1);

  let payload: unknown = null;
  let fetchFailed = false;
  try {
    payload = await fetchHkoPayload(fetchImpl);
  } catch {
    fetchFailed = true;
  }

  if (!fetchFailed) {
    try {
      const days = parseHkoStrict(payload, tomorrow.compact);
      const lines = days.map(dayToLine);
      lastGood = { fetchedAtMs: now.getTime(), fetchedAt: now.toISOString(), lines };
      return { source: "hko", lines, fetchedAt: now.toISOString() };
    } catch {
      // 落入降級鏈
    }
  }

  const stale = staleResult(now);
  if (stale) return stale;

  if (!fetchFailed) {
    // 無快取可用：回應入面仲有帶真溫度欄嘅日就用（唔扮齊料）
    const partial = parseHkoPartial(payload, tomorrow.compact);
    if (partial.length > 0) {
      return {
        source: "hko",
        lines: [
          `（天文台預報資料不完整，以下 ${partial.length} 日只採用帶真溫度欄嘅部分）`,
          ...partial.map(dayToLine),
        ],
        fetchedAt: now.toISOString(),
      };
    }
  }

  return seasonalResult(now);
}
