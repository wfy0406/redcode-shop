/**
 * P3-1（2026-10 安全修復）：WMS callback shared secret 統一比對。
 * 全部 /api/wms/* callback 用呢個——長度檢查＋timingSafeEqual 常數時間比對，
 * 唔准再用 !== 字串比對（時序旁路理論上可以逐字節爆 secret）。
 * 模式同 wmsMemberAdmin.ts／wmsLivePush.ts 原本手寫嗰段一致。
 */
import { timingSafeEqual } from "node:crypto";

/** secret 比對（constant-time）：given 唔係 string／長度唔同即刻 false */
export function secretEquals(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given, "utf8");
  const e = Buffer.from(expected, "utf8");
  if (a.length !== e.length) return false;
  return timingSafeEqual(a, e);
}
