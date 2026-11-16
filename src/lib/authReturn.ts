/**
 * 登入／註冊後「返回嚟路」工具（Glo Guide → AI TryOn 深層連結整合，iteration-7）。
 *
 * 場景：TryOn / Glo Guide 用 <Link to="/login" state={{ from: '/try-on?productId=101&photoIndex=0&guide=autumn-knit' }}>
 * 帶客過嚟登入。location.state 喺 SPA 內跳轉穩陣，但 Google 登入喺手機／in-app browser
 * 可能行全頁跳轉，state 會丟——所以除咗讀 state.from，仲用 sessionStorage 短 TTL 兜底。
 *
 * 安全原則：
 * - 只接受單一 `/` 開頭嘅站內路徑；拒絕 `//host`、反斜線、外部 scheme、控制字符
 *   （防 open-redirect：登入成功後 navigate() 嘅目標永遠唔可以指去站外）
 * - sessionStorage 只存 { path, ts }，永遠唔存 token／相片／私隱資料
 * - 成功導航嗰刻先 consume（唔好喺 render／登入失敗時清，避免遺失返回路徑）
 */

export const AUTH_RETURN_KEY = 'rc.authReturn';
/** 返回路徑兜底 TTL：15 分鐘。過期當冇，直接返預設目標。 */
export const AUTH_RETURN_TTL_MS = 15 * 60 * 1000;
/** 站內路徑長度上限——正常深層連結百幾字節夠晒，超長當攻擊／壞資料拒絕。 */
export const MAX_RETURN_PATH_LENGTH = 512;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * 淨化站內路徑：通過回傳原字串（trim 後），唔通過回 null。
 * 通過條件：非空、長度 ≤ MAX、單一 `/` 開頭（`//` 拒絕）、冇反斜線、冇控制字符。
 * 注意：`https://evil.com`、`javascript:...` 呢類唔係 `/` 開頭，天然被拒。
 */
export function sanitizeInternalPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const path = input.trim();
  if (path.length === 0 || path.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!path.startsWith('/')) return null;
  if (path.startsWith('//')) return null;
  if (path.includes('\\')) return null;
  if (CONTROL_CHARS.test(path)) return null;
  return path;
}

/**
 * 由 react-router location.state 抽出安全返回路徑。
 * 相容兩種歷史格式：
 * - 字串：state.from = '/orders'
 * - 物件：state.from = { pathname, search?, hash? }（search/hash 有就拼埋）
 * 淨化失敗／冇 from → null。
 */
export function fromLocationState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const from = (state as { from?: unknown }).from;
  if (typeof from === 'string') return sanitizeInternalPath(from);
  if (from && typeof from === 'object') {
    const o = from as { pathname?: unknown; search?: unknown; hash?: unknown };
    const pathname = typeof o.pathname === 'string' ? o.pathname : '';
    const search = typeof o.search === 'string' ? o.search : '';
    const hash = typeof o.hash === 'string' ? o.hash : '';
    return sanitizeInternalPath(`${pathname}${search}${hash}`);
  }
  return null;
}

interface StoredReturn {
  path: string;
  ts: number;
}

/**
 * 寫兜底記號入 sessionStorage。成功回 true；
 * 私隱模式／quota 爆滿／路徑唔合法 → false（caller 唔使理，state.from 仲係主線）。
 * 只存路徑＋時間戳，永遠唔存 token 或私隱資料。
 */
export function stashAuthReturn(path: string, now: number = Date.now()): boolean {
  const safe = sanitizeInternalPath(path);
  if (!safe) return false;
  try {
    const payload: StoredReturn = { path: safe, ts: now };
    sessionStorage.setItem(AUTH_RETURN_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * 讀兜底路徑（唔清除）。過期／壞資料／storage 唔用得 → null，順手清走壞記號。
 */
export function peekAuthReturn(now: number = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(AUTH_RETURN_KEY);
  } catch {
    return null; // 私隱模式當冇
  }
  if (!raw) return null;
  let path: string | null = null;
  let fresh = false;
  try {
    const data = JSON.parse(raw) as Partial<StoredReturn> | null;
    path = sanitizeInternalPath(data?.path);
    const ts = Number(data?.ts);
    // 過期、未來時間（時鐘跳咗，寬容 1 分鐘）、ts 唔係數 → 全部當無效
    fresh =
      path !== null &&
      Number.isFinite(ts) &&
      now - ts <= AUTH_RETURN_TTL_MS &&
      ts <= now + 60_000;
  } catch {
    fresh = false;
  }
  if (!fresh) {
    try {
      sessionStorage.removeItem(AUTH_RETURN_KEY);
    } catch {
      /* 私隱模式當冇 */
    }
    return null;
  }
  return path;
}

/**
 * 讀兼清（一次性）：成功導航嗰刻先用，避免下次登入誤中舊記號。
 * 就算冇記號都會試清一次，順手帶走過期殘留。
 */
export function consumeAuthReturn(now: number = Date.now()): string | null {
  const path = peekAuthReturn(now);
  try {
    sessionStorage.removeItem(AUTH_RETURN_KEY);
  } catch {
    /* 私隱模式當冇 */
  }
  return path;
}
