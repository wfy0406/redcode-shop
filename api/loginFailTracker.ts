/**
 * 登入失敗鎖定計數器（H1 安全修復，2026-10-24 獨立覆核）——抽出嚟方便單元測試。
 *
 * 規則：同一帳號 key 連續失敗 10 次 → 鎖 15 分鐘；成功登入即清零。
 * 舊 bug：未鎖定 entry 嘅 lockedUntil 係 0，`lockedUntil <= now` 永遠成立，
 * 次次失敗都當「鎖已過期」由 0 重新計 → 永遠到唔到 10 次，鎖定形同虛設；
 * 清理條件 `count === 0` 又永不成立，過期 entry 無限累積。
 * 而家：只有「真係鎖過而家已過期」（lockedUntil > 0 且 <= now）先由 0 重計；
 * 清理用 lastFailAt 閒置時間判斷，唔再靠唔會成立嘅 count===0。
 */

export const LOGIN_FAIL_LIMIT = 10;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
/** 閒置超過鎖定時長嘅未鎖定 entry 先會喺爆煲時被掃走（唔會沖走失敗緊嘅計數） */
const CLEANUP_IDLE_MS = LOGIN_LOCK_MS;
const MAX_ENTRIES = 5000;

interface FailEntry {
  count: number;
  lockedUntil: number; // 0＝未鎖
  lastFailAt: number;
}

export class LoginFailTracker {
  private map = new Map<string, FailEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 而家係咪鎖定中（回鎖定截止時間；冇鎖／已過期回 null） */
  lockedUntil(key: string): number | null {
    const cur = this.map.get(key);
    if (cur && cur.lockedUntil > this.now()) return cur.lockedUntil;
    return null;
  }

  /** 記一次失敗：夠 10 次就鎖 15 分鐘；之前嘅鎖已過期先由 0 重計，否則照舊累加 */
  recordFail(key: string): void {
    const now = this.now();
    const cur = this.map.get(key);
    if (cur && cur.lockedUntil > now) return; // 鎖定中唔好再郁（call 方正常唔會行到嚟）
    const base = cur && cur.lockedUntil > 0 && cur.lockedUntil <= now ? 0 : (cur?.count ?? 0);
    const count = base + 1;
    this.map.set(key, {
      count,
      lockedUntil: count >= LOGIN_FAIL_LIMIT ? now + LOGIN_LOCK_MS : 0,
      lastFailAt: now,
    });
    // 防記憶體無限增長：bucket 大咗就掃走「冇鎖緊＋閒置夠耐」嘅過期 entry
    if (this.map.size > MAX_ENTRIES) {
      for (const [k, v] of this.map) {
        if (v.lockedUntil <= now && now - v.lastFailAt >= CLEANUP_IDLE_MS) this.map.delete(k);
      }
    }
  }

  /** 成功登入即清零 */
  reset(key: string): void {
    this.map.delete(key);
  }
}
