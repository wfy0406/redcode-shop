/**
 * v2.5.6 抽獎純函數核心（零 DB 依賴，方便單元測試）
 * --------------------------------
 * - normalizeListName：名單/劵持有人名去重口径（trim＋toLowerCase），同 luckyDrawRouter 舊邏輯一致
 * - 名單模式「每人每日限中 N 次」：count >= maxWins 先踢（預設 1 ≡ 舊 Set guard，唔准靜默放寬）
 * - 劵模式加權抽：每張劵等權，人用 ticketCount 加權——randomInt(0,totalTickets)＋累計權重行一次，
 *   絕唔展開 N 張劵做巨型 array
 */

/** 名正規化（trim＋toLowerCase）：去重、「一日一個名中 N 次」、劵持有人唯一鍵都用佢；
 *  顯示／winnerName 快照保留原串 */
export function normalizeListName(n: string): string {
  return n.trim().toLowerCase();
}

/** 每日（或每活動）已中次數仲未過上限？forceExcluded＝重抽保險（舊中獎人永遠踢出重抽池） */
export function underWinLimit(
  count: number | undefined,
  maxWins: number,
  forceExcluded?: boolean,
): boolean {
  if (forceExcluded) return false;
  return (count ?? 0) < maxWins;
}

// ───────────────────────── 抽獎劵活動 ─────────────────────────

/** 加權池 entry（劵模式）：entryId＝luckyDrawEventEntries.id，weight＝ticketCount */
export type WeightedEntry = { entryId: number; weight: number };

/** 總劵數（攞嚟 randomInt(0, total)）；上游已保證每個 weight ∈ 1..10000 同總數唔溢出 */
export function totalTickets(entries: readonly WeightedEntry[]): number {
  let total = 0;
  for (const e of entries) total += e.weight;
  return total;
}

/** 按累計權重搵中邊個 entry：pick ∈ [0, totalTickets)。
 *  每張劵等權——weight=3 嘅人佔 3 個相連區間。entries 空／pick 越界 → -1（上游唔應該發生） */
export function pickWeightedIndex(entries: readonly WeightedEntry[], pick: number): number {
  if (pick < 0) return -1;
  let acc = 0;
  for (let i = 0; i < entries.length; i++) {
    acc += entries[i].weight;
    if (pick < acc) return i;
  }
  return -1;
}

/** 劵模式合資格池：踢走中獎次數已達全活動上限嘅人；forceExcludeId＝重抽時舊中獎人永遠踢走 */
export function filterEligibleEntries<T extends { id: number; ticketCount: number }>(
  entries: readonly T[],
  winCounts: ReadonlyMap<number, number>,
  maxWins: number,
  forceExcludeId?: number,
): T[] {
  return entries.filter((e) =>
    underWinLimit(winCounts.get(e.id), maxWins, e.id === forceExcludeId),
  );
}

/** 劵模式抽獎一步到位：合資格池 → 加權池 → randomInt 結果落邊個 entry。
 *  pick 由 caller 用 crypto randomInt(0, total) 產生（呢度唔掂 randomness，方便測試注入）。
 *  回 null＝冇人抽得。 */
export function pickWeightedEntry<T extends { id: number; ticketCount: number }>(
  eligible: readonly T[],
  pick: number,
): T | null {
  const weighted: WeightedEntry[] = eligible.map((e) => ({ entryId: e.id, weight: e.ticketCount }));
  const idx = pickWeightedIndex(weighted, pick);
  return idx >= 0 ? eligible[idx] : null;
}
