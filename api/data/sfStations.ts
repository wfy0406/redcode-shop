/**
 * v2.1.0（VIP+免運，2026-09-29）：順豐站點預設清單＋正式清單 loader。
 *
 * ─ SF_STATIONS：8–10 個常見站做**樣例**，開機時表空就自動倒入（boot-migrate），
 *   等開發同首次部署即刻用得。
 * ─ 正式完整清單（HK 1654 個點／MO 51 個點）喺 work/shop-vip/shared/sf-stations-hk.json
 *   同 sf-stations-mo.json，欄位格式 { name, district, address, type }，
 *   type ∈ SF_STATION｜SF_LOCKER｜SERVICE_POINT。
 *   主線整合時用下面嘅 mapSharedStations() 將全量 JSON 轉做 sfStations 行倒入
 *   （例如將 SF_STATIONS 嘅內容整個換成 mapSharedStations 嘅結果再部署），
 *   或者部署後用後台「重新導入預設清單」（vip.reseedDefaultStations）逐個 upsert。
 *   DB 先係最終來源——之後站點有變喺後台改，唔使再郁呢個檔。
 */
import type { SfStation } from "@db/schema";

/** shared/sf-stations-*.json 嘅行格式（正式清單來源） */
export interface SharedStationRow {
  name: string;
  district?: string | null;
  address?: string | null;
  type: "SF_STATION" | "SF_LOCKER" | "SERVICE_POINT";
}

/**
 * 正式清單 JSON → sfStations 行：自動生成穩定 ID（{region}-{序號}，4 位數），
 * sortOrder 按入面嘅順序。region 淨係 'HK'｜'MO'。
 */
export function mapSharedStations(
  region: "HK" | "MO",
  rows: SharedStationRow[],
): Omit<SfStation, "active">[] {
  return rows.map((r, i) => ({
    id: `${region}-${String(i + 1).padStart(4, "0")}`,
    region,
    type: r.type,
    name: r.name,
    district: r.district ?? null,
    address: r.address ?? null,
    sortOrder: i,
  }));
}

/**
 * 樣例清單（開機 seed 用；正式清單倒入後呢啲會被同 ID 覆蓋／或由後台管理）。
 * id 規則：{region}-{區碼}-{序號}（自訂，唔係順豐官方編號）。
 */
export const SF_STATIONS: Omit<SfStation, "active" | "sortOrder">[] = [
  // ── 香港・順豐站 ──
  { id: "HK-CW-001", region: "HK", type: "SF_STATION", name: "順豐站－中西區（上環）", district: "中西區", address: "上環干諾道中 168-200 號信德中心地下" },
  { id: "HK-WC-001", region: "HK", type: "SF_STATION", name: "順豐站－灣仔（駱克道）", district: "灣仔區", address: "灣仔駱克道 188 號地下" },
  { id: "HK-KLM-001", region: "HK", type: "SF_STATION", name: "順豐站－旺角（西洋菜南街）", district: "油尖旺區", address: "旺角西洋菜南街 1A 號地下" },
  { id: "HK-SSP-001", region: "HK", type: "SF_STATION", name: "順豐站－深水埗（欽州街）", district: "深水埗區", address: "深水埗欽州街 37K 號西九龍中心地下" },
  { id: "HK-KWT-001", region: "HK", type: "SF_STATION", name: "順豐站－觀塘（駿業街）", district: "觀塘區", address: "觀塘駿業街 62 號京貿中心地下" },
  { id: "HK-ST-001", region: "HK", type: "SF_STATION", name: "順豐站－沙田（瀝源邨）", district: "沙田區", address: "沙田瀝源街 7 號瀝源廣場地下" },
  // ── 香港・順豐智能櫃 ──
  { id: "HK-CW-L01", region: "HK", type: "SF_LOCKER", name: "智能櫃－中環港鐵站", district: "中西區", address: "港鐵中環站大堂（近 J 出口）" },
  { id: "HK-TW-L01", region: "HK", type: "SF_LOCKER", name: "智能櫃－荃灣港鐵站", district: "荃灣區", address: "港鐵荃灣站大堂（近 A 出口）" },
  // ── 澳門 ──
  { id: "MO-TP-001", region: "MO", type: "SF_STATION", name: "順豐站－氹仔（花城）", district: "氹仔", address: "氹仔埃武拉街花城利盛大廈地下" },
  { id: "MO-NAPE-001", region: "MO", type: "SF_STATION", name: "順豐站－新口岸（皇朝）", district: "澳門半島", address: "澳門新口岸宋玉生廣場皇朝廣場地下" },
];
