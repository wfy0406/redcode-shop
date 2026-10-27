/**
 * luckyAnnouncementPng 排版核心測試（純函數，注入 stub measure，唔使真 canvas）
 * 覆蓋：CJK／長名截斷唔斷字、活動名自動縮字、多人行高遞減＋「仲有 N 位」、
 * 空名單 empty 狀態、1080×1350 規格常數。
 */
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_H,
  ANNOUNCEMENT_W,
  announcementDateLines,
  fitText,
  layoutAnnouncement,
  shrinkToFit,
  type MeasureFn,
} from "./luckyAnnouncementPng";

// stub：每個字元當 1em 闊（CJK 最壞情況；英文實際會窄啲，截斷只會更安全）
const wideMeasure: MeasureFn = (text, size) => [...text].length * size;

describe("fitText", () => {
  it("放得落就原串返回", () => {
    expect(fitText("陳小明", 10 * 40, 40, true, wideMeasure)).toBe("陳小明");
  });

  it("太長逐字截斷加省略號，唔會斷半個字", () => {
    const out = fitText("超級無敵長嘅中獎人名稱陳大文", 5 * 40, 40, true, wideMeasure);
    // 5 個字位：4 字＋…
    expect(out).toBe("超級無敵…");
    expect([...out].length).toBe(5);
  });

  it("極窄都至少回省略號", () => {
    expect(fitText("乜都放唔落", 0, 40, true, wideMeasure)).toBe("…");
  });
});

describe("shrinkToFit", () => {
  it("大標題放得落就唔縮", () => {
    const r = shrinkToFit("雙十一．壓軸狂歡", 1080, 72, 34, true, wideMeasure);
    expect(r.text).toBe("雙十一．壓軸狂歡");
    expect(r.fontSize).toBeGreaterThan(34);
  });

  it("太長會縮到 min 再截斷", () => {
    const long = "雙十一．壓軸狂歡特別加長版活動名稱一定要寫足全名先合格之超長版本";
    const r = shrinkToFit(long, 200, 72, 34, true, wideMeasure);
    expect(r.fontSize).toBe(34);
    expect(r.text.endsWith("…")).toBe(true);
    expect([...r.text].length * 34).toBeLessThanOrEqual(200);
  });
});

describe("layoutAnnouncement", () => {
  it("空名單 → empty 狀態（公告照出，寫即將公佈）", () => {
    const l = layoutAnnouncement({ eventName: "前夕突擊抽獎", scheduledDrawDateLabel: null, drawnAtLabel: null, winners: [] }, wideMeasure);
    expect(l.empty).toBe(true);
    expect(l.rows).toHaveLength(0);
    expect(l.hiddenCount).toBe(0);
  });

  it("少人（≤6）用大行距，全部顯示", () => {
    const winners = Array.from({ length: 5 }, (_, i) => ({ name: `得獎者${i + 1}`, prizeName: `$55現金券` }));
    const l = layoutAnnouncement({ eventName: "前夕突擊抽獎", scheduledDrawDateLabel: "2026-11-08", drawnAtLabel: "2026-11-08 21:30", winners }, wideMeasure);
    expect(l.empty).toBe(false);
    expect(l.rows).toHaveLength(5);
    expect(l.hiddenCount).toBe(0);
    expect(l.rowFontSize).toBe(40);
  });

  it("多人（>16）用密行距；放唔晒有 hiddenCount", () => {
    const winners = Array.from({ length: 30 }, (_, i) => ({ name: `幸運兒${i + 1}號`, prizeName: `精美飾品` }));
    const l = layoutAnnouncement({ eventName: "壓軸大抽獎", scheduledDrawDateLabel: "2026-11-11", drawnAtLabel: "2026-11-11 22:00", winners }, wideMeasure);
    expect(l.rows.length).toBeLessThan(30);
    expect(l.hiddenCount).toBe(30 - l.rows.length);
    expect(l.hiddenCount).toBeGreaterThan(0);
    expect(l.rowFontSize).toBe(24);
  });

  it("長人名＋長獎品名都會截斷到欄寬之內", () => {
    const winners = [
      { name: "超級無敵長嘅中獎人名稱陳大文先生閣下", prizeName: "超長獎品名稱之閃石頸鏈手鍊套裝限定版" },
    ];
    const l = layoutAnnouncement({ eventName: "測試", scheduledDrawDateLabel: null, drawnAtLabel: null, winners }, wideMeasure);
    const contentW = ANNOUNCEMENT_W - 84 * 2;
    const nameMaxW = Math.floor(contentW * 0.52);
    const prizeMaxW = contentW - nameMaxW - 40;
    expect([...l.rows[0].name].length * 40).toBeLessThanOrEqual(nameMaxW);
    expect([...l.rows[0].prize].length * 36).toBeLessThanOrEqual(prizeMaxW);
    expect(l.rows[0].name.endsWith("…")).toBe(true);
  });

  it("規格：1080×1350（4:5 直度，>= 要求下限）", () => {
    expect(ANNOUNCEMENT_W).toBe(1080);
    expect(ANNOUNCEMENT_H).toBe(1350);
    expect(ANNOUNCEMENT_H).toBeGreaterThanOrEqual(1350);
  });
});

describe("announcementDateLines（v2026.10.26.2 活動日期行）", () => {
  const base = { eventName: "測試活動", winners: [] };

  it("未開獎有預定日 → 「預定抽獎日：…」", () => {
    const lines = announcementDateLines({ ...base, scheduledDrawDateLabel: "2026-12-01", drawnAtLabel: null });
    expect(lines).toEqual(["預定抽獎日：2026-12-01"]);
  });

  it("已開獎＋有預定日 → 預定日同實際抽獎時間兩行分開標示", () => {
    const lines = announcementDateLines({
      ...base,
      scheduledDrawDateLabel: "2026-11-11",
      drawnAtLabel: "2026-11-11 21:30",
      winners: [{ name: "陳小明", prizeName: "禮物A" }],
    });
    expect(lines).toEqual(["預定抽獎日：2026-11-11", "抽獎時間：2026-11-11 21:30"]);
  });

  it("舊活動冇預定日但有 winner → 用真實抽出時間做「抽獎時間」行（唔寫預定）", () => {
    const lines = announcementDateLines({ ...base, scheduledDrawDateLabel: null, drawnAtLabel: "2026-10-24 21:00" });
    expect(lines).toEqual(["抽獎時間：2026-10-24 21:00"]);
  });

  it("舊活動 null＋未開獎 → 如實寫「抽獎日待公佈」（唔好用 createdAt 冒充）", () => {
    const lines = announcementDateLines({ ...base, scheduledDrawDateLabel: null, drawnAtLabel: null });
    expect(lines).toEqual(["抽獎日待公佈"]);
  });
});
