/**
 * api/lib/luckyAnnouncementVisibility.ts 對外公告總開關 helper focused tests。
 *
 * 覆蓋（fail-closed 鐵律）：
 * - 設定行唔存在 → 關閉；value="false" → 關閉；垃圾值（"yes"/"TRUE"/"1"/""）→ 關閉；
 *   只有精確 "true"（trim 後）先開。
 * - DB 讀取失敗 → throw 給上層 catch（公開語義唔改：tRPC 500／vite.ts catch／sitemap caller catch），
 *   而且失敗唔會寫入 TTL 快取（唔會毒化之後 60 秒）。
 * - 60 秒 TTL 快取：連續兩次讀只打一次 DB；resetLuckyAnnouncementPublicCache 後重讀。
 * - setLuckyAnnouncementPublic：upsert 寫 "true"/"false"＋即時 reset 快取（下一次讀打 DB）。
 * - luckyAnnouncementVisible：兩層 AND 唯一組合入口（總開 AND winnersPublic）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ───────────────────────── mock DB（relational query＋insert upsert）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    row: null as null | { value: string },
    error: null as null | Error,
    findFirstCalls: 0,
    inserts: [] as { table: unknown; values: unknown }[],
  };
  const db = {
    query: {
      siteSettings: {
        findFirst: async () => {
          state.findFirstCalls += 1;
          if (state.error) throw state.error;
          return state.row;
        },
      },
    },
    insert: (table: unknown) => ({
      values: (values: { key: string; value: string }) => {
        state.inserts.push({ table, values });
        return {
          // 模擬真實 upsert 落 DB：下一次 findFirst 讀到新值
          onConflictDoUpdate: async () => {
            state.row = { value: values.value };
          },
        };
      },
    }),
  };
  return { state, db };
});

vi.mock("../queries/connection", () => ({ getDb: () => h.db }));

import {
  isLuckyAnnouncementPublic,
  luckyAnnouncementVisible,
  resetLuckyAnnouncementPublicCache,
  setLuckyAnnouncementPublic,
  LUCKY_ANNOUNCEMENT_PUBLIC_SETTING_KEY,
} from "./luckyAnnouncementVisibility";

beforeEach(() => {
  h.state.row = null;
  h.state.error = null;
  h.state.findFirstCalls = 0;
  h.state.inserts = [];
  resetLuckyAnnouncementPublicCache();
});

describe("isLuckyAnnouncementPublic（fail-closed 預設關）", () => {
  it("設定行唔存在（null）→ false", async () => {
    expect(await isLuckyAnnouncementPublic()).toBe(false);
  });

  it("value='false' → false", async () => {
    h.state.row = { value: "false" };
    expect(await isLuckyAnnouncementPublic()).toBe(false);
  });

  it("垃圾值一律當關：'yes'／'TRUE'／'1'／空字串 → false（只有精確 true 先開）", async () => {
    for (const garbage of ["yes", "TRUE", "1", ""]) {
      h.state.row = { value: garbage };
      resetLuckyAnnouncementPublicCache();
      expect(await isLuckyAnnouncementPublic(), `value=${JSON.stringify(garbage)}`).toBe(false);
    }
  });

  it("只有精確 'true' 開；前後空白 trim 後 'true' 都開", async () => {
    h.state.row = { value: "true" };
    expect(await isLuckyAnnouncementPublic()).toBe(true);
    h.state.row = { value: "  true  " };
    resetLuckyAnnouncementPublicCache();
    expect(await isLuckyAnnouncementPublic()).toBe(true);
  });

  it("DB 讀取失敗 → throw（唔靜默當開／當關），而且唔會毒化快取——下一個 caller 嘅 catch 決定點收", async () => {
    h.state.error = new Error("connection refused");
    await expect(isLuckyAnnouncementPublic()).rejects.toThrow("connection refused");
    // 錯誤冇寫入快取：修返 DB 後即刻讀到新值（唔使等 60 秒 TTL）
    h.state.error = null;
    h.state.row = { value: "true" };
    expect(await isLuckyAnnouncementPublic()).toBe(true);
  });

  it("60 秒 TTL：連續兩次讀只打一次 DB；reset 後重讀 DB", async () => {
    h.state.row = { value: "true" };
    expect(await isLuckyAnnouncementPublic()).toBe(true);
    expect(await isLuckyAnnouncementPublic()).toBe(true);
    expect(h.state.findFirstCalls).toBe(1);
    resetLuckyAnnouncementPublicCache();
    h.state.row = { value: "false" };
    expect(await isLuckyAnnouncementPublic()).toBe(false);
    expect(h.state.findFirstCalls).toBe(2);
  });
});

describe("setLuckyAnnouncementPublic（後台寫入＋即時 reset 快取）", () => {
  it("寫 true：upsert siteSettings value='true'；之後讀即刻係開（同一 process 即時生效）", async () => {
    h.state.row = null; // DB 原本關
    await isLuckyAnnouncementPublic(); // 預熱快取＝false
    await setLuckyAnnouncementPublic(true);
    expect(h.state.inserts).toHaveLength(1);
    expect(h.state.inserts[0].values).toMatchObject({
      key: LUCKY_ANNOUNCEMENT_PUBLIC_SETTING_KEY,
      value: "true",
    });
    expect(h.state.inserts[0].values).toHaveProperty("updatedAt");
    // 寫入後 reset 咗快取 → 下一次讀打 DB 攞到新值
    const callsBefore = h.state.findFirstCalls;
    expect(await isLuckyAnnouncementPublic()).toBe(true);
    expect(h.state.findFirstCalls).toBeGreaterThan(callsBefore);
  });

  it("寫 false：upsert value='false'；之後讀即刻係關", async () => {
    h.state.row = { value: "true" };
    expect(await isLuckyAnnouncementPublic()).toBe(true); // 預熱快取＝true
    await setLuckyAnnouncementPublic(false);
    expect(h.state.inserts[0].values).toMatchObject({ value: "false" });
    expect(await isLuckyAnnouncementPublic()).toBe(false);
  });
});

describe("luckyAnnouncementVisible（兩層 AND 唯一組合入口）", () => {
  it("總開 AND 該場 winnersPublic 先可見；其餘組合全部收埋", () => {
    expect(luckyAnnouncementVisible(true, true)).toBe(true);
    expect(luckyAnnouncementVisible(true, false)).toBe(false); // 總開但單場關
    expect(luckyAnnouncementVisible(false, true)).toBe(false); // 單場開但總關
    expect(luckyAnnouncementVisible(false, false)).toBe(false);
  });
});
