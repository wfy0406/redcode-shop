import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetGloGuideWeatherCacheForTests,
  getGloGuideWeather,
  gloGuideSeason,
} from "./gloGuideWeather";

// 固定「而家」＝香港時間 2025-06-10 12:00（UTC 04:00），明日＝2025-06-11
const NOW = new Date("2025-06-10T04:00:00.000Z");
const TOMORROW_COMPACT = "20250611";

function hkoPayload(overrides: Partial<Record<string, unknown>> = {}): unknown {
  const weatherForecast = Array.from({ length: 9 }, (_, i) => {
    const day = 11 + i; // 20250611 … 20250619
    return {
      forecastDate: `202506${String(day).padStart(2, "0")}`,
      week: "星期三",
      forecastWeather: "大致多雲",
      forecastMaxtemp: { value: 30 + i },
      forecastMintemp: { value: 26 },
      forecastMaxrh: { value: 85 },
      forecastMinrh: { value: 65 },
    };
  });
  return { generalSituation: "受季候風影響", weatherForecast, updateTime: "2025-06-10T10:00:00+08:00", ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("gloGuideWeather（HKO 明日起 7 日）", () => {
  beforeEach(() => {
    __resetGloGuideWeatherCacheForTests();
  });

  it("成功：parse 真數值，取明日起 7 日（香港時間）", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(hkoPayload()));
    const result = await getGloGuideWeather({ fetchImpl, now: NOW });

    expect(result.source).toBe("hko");
    expect(result.fetchedAt).toBe(NOW.toISOString());
    expect(result.lines).toHaveLength(7);
    expect(result.lines[0]).toContain("2025-06-11");
    expect(result.lines[0]).toContain("26–30°C");
    expect(result.lines[0]).toContain("大致多雲");
    expect(result.lines[6]).toContain("2025-06-17");

    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("data.weather.gov.hk/weatherAPI/opendata/weather.php");
    expect(String(url)).toContain("dataType=fnd");
    expect(String(url)).toContain("lang=tc");
  });

  it("溫度欄唔係真數值 → 嚴格 parse 失敗", async () => {
    const payload = hkoPayload();
    // 攞嚟之後整爛其中一日溫度
    (payload as { weatherForecast: { forecastMaxtemp: { value: unknown } }[] })
      .weatherForecast[0]!.forecastMaxtemp = { value: "--" };
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    const result = await getGloGuideWeather({ fetchImpl, now: NOW });
    // 無快取 → 落入「可用溫度欄」分支（其餘日子仲有真溫度）
    expect(result.source).toBe("hko");
    expect(result.lines[0]).toContain("不完整");
  });

  it("失敗有快取：source=hko-stale，fetchedAt 保留最後成功時間（regression）", async () => {
    const okFetch = vi.fn(async () => jsonResponse(hkoPayload()));
    const first = await getGloGuideWeather({ fetchImpl: okFetch, now: NOW });
    expect(first.source).toBe("hko");

    const later = new Date(NOW.getTime() + 3 * 3_600_000); // 3 小時後
    const badFetch = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const stale = await getGloGuideWeather({ fetchImpl: badFetch, now: later });

    expect(stale.source).toBe("hko-stale");
    // 關鍵：fetchedAt 必須係最後成功讀取嗰刻，唔係而家
    expect(stale.fetchedAt).toBe(NOW.toISOString());
    expect(stale.fetchedAt).not.toBe(later.toISOString());
    expect(stale.lines[0]).toContain("快取");
    expect(stale.lines.slice(1)).toEqual(first.lines);
  });

  it("HTTP 錯誤且無快取 → seasonal fallback，唔作具體天氣斷言", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const result = await getGloGuideWeather({ fetchImpl, now: NOW });

    expect(result.source).toBe("seasonal");
    expect(result.fetchedAt).toBe(NOW.toISOString());
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("夏季");
    expect(result.lines[0]).toContain("唔好斷言");
    expect(result.lines[0]).not.toMatch(/\d+°C/);
  });

  it("network 失敗且無快取 → seasonal fallback，唔會 throw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await getGloGuideWeather({ fetchImpl, now: NOW });
    expect(result.source).toBe("seasonal");
  });

  it("回應唔係 JSON 且無快取 → seasonal fallback", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const result = await getGloGuideWeather({ fetchImpl, now: NOW });
    expect(result.source).toBe("seasonal");
  });

  it("季節分界：香港月份 3–5 春／6–8 夏／9–11 秋／12–2 冬", () => {
    expect(gloGuideSeason(1)).toBe("冬季");
    expect(gloGuideSeason(3)).toBe("春季");
    expect(gloGuideSeason(6)).toBe("夏季");
    expect(gloGuideSeason(9)).toBe("秋季");
    expect(gloGuideSeason(12)).toBe("冬季");
  });
});
