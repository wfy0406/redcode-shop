/**
 * luckyAnnouncementPng 排版核心測試（純函數，注入 stub measure，唔使真 canvas）
 * 覆蓋：CJK／長名截斷唔斷字、活動名自動縮字、多人行高遞減＋「仲有 N 位」、
 * 空名單 empty 狀態、1080×1350 規格常數。
 */
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_H,
  ANNOUNCEMENT_W,
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
    const l = layoutAnnouncement({ eventName: "前夕突擊抽獎", drawnAtLabel: null, winners: [] }, wideMeasure);
    expect(l.empty).toBe(true);
    expect(l.rows).toHaveLength(0);
    expect(l.hiddenCount).toBe(0);
  });

  it("少人（≤6）用大行距，全部顯示", () => {
    const winners = Array.from({ length: 5 }, (_, i) => ({ name: `得獎者${i + 1}`, prizeName: `$55現金券` }));
    const l = layoutAnnouncement({ eventName: "前夕突擊抽獎", drawnAtLabel: "2026-11-08 21:30", winners }, wideMeasure);
    expect(l.empty).toBe(false);
    expect(l.rows).toHaveLength(5);
    expect(l.hiddenCount).toBe(0);
    expect(l.rowFontSize).toBe(40);
  });

  it("多人（>16）用密行距；放唔晒有 hiddenCount", () => {
    const winners = Array.from({ length: 30 }, (_, i) => ({ name: `幸運兒${i + 1}號`, prizeName: `精美飾品` }));
    const l = layoutAnnouncement({ eventName: "壓軸大抽獎", drawnAtLabel: "2026-11-11 22:00", winners }, wideMeasure);
    expect(l.rows.length).toBeLessThan(30);
    expect(l.hiddenCount).toBe(30 - l.rows.length);
    expect(l.hiddenCount).toBeGreaterThan(0);
    expect(l.rowFontSize).toBe(24);
  });

  it("長人名＋長獎品名都會截斷到欄寬之內", () => {
    const winners = [
      { name: "超級無敵長嘅中獎人名稱陳大文先生閣下", prizeName: "超長獎品名稱之閃石頸鏈手鍊套裝限定版" },
    ];
    const l = layoutAnnouncement({ eventName: "測試", drawnAtLabel: null, winners }, wideMeasure);
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
