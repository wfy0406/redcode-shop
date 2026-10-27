/**
 * 後台 30 日私人副本 HTTP route（/api/admin/tryon-media/:publicId/:kind）focused tests。
 * 覆蓋：
 * - admin／supervisor 200；staff／member／未登入／已降職／帳號已刪全部拒絕
 * - admin-archive HMAC 篡改、過期、>15min 時效、客戶 scope 簽名 replay 全部 404
 * - 30 日 retention：29d23:59:59.999 可睇、啱啱好 30 日 410（只按 createdAt）
 * - 客戶私人媒體已刪除，後台副本仍 200；副本檔案唔存在 404
 * - no-store 回應頭；成功讀私人圖寫 audit
 *
 * ⚠️ DB／auth／audit 全部 mock；archive 檔案寫落 os tmpdir，唔掂真 uploads。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryOnJobs, users } from "@db/schema";

const h = vi.hoisted(() => {
  const state = {
    user: null as null | { userId: number; role: "member" | "staff" | "supervisor" | "admin" },
    account: undefined as undefined | { role: string } | null,
    job: undefined as undefined | { id: number; createdAt: Date } | null,
    audits: [] as any[],
  };
  const db: any = {
    select: (selection?: any) => ({
      from: (table: any) => ({
        where: () => ({
          limit: async () => {
            void selection;
            if (table === users) {
              if (state.account === undefined) throw new Error("test 未設定 account");
              return state.account ? [state.account] : [];
            }
            if (table === tryOnJobs) {
              if (state.job === undefined) throw new Error("test 未設定 job");
              return state.job ? [state.job] : [];
            }
            throw new Error("unexpected table");
          },
        }),
      }),
    }),
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./auth", () => ({
  userFromAuthHeader: vi.fn(async () => h.state.user),
}));
vi.mock("./audit", () => ({
  logAudit: vi.fn(async (entry: any) => {
    h.state.audits.push(entry);
  }),
}));
vi.mock("./lib/env", () => ({
  env: { appSecret: "unit-test-admin-media-secret", appId: "unit-test", databaseUrl: "", isProduction: false },
}));

import { tryOnAdminMedia } from "./tryonAdminMedia";
import { signTryOnMediaUrl } from "./tryonMedia";
import {
  TRYON_ADMIN_ARCHIVE_RETENTION_MS,
  signTryOnAdminArchiveUrl,
  writeTryOnAdminArchive,
} from "./tryonAdminArchive";

const SECRET = "unit-test-admin-media-secret";
const PUBLIC_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = 1_760_000_000_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8]);

const app = new Hono();
app.get("/api/admin/tryon-media/:publicId/:kind", tryOnAdminMedia);

let tempDir = "";
let oldPrivateDir: string | undefined;

function signedPath(kind: "input" | "output" = "input", ttlMs?: number): string {
  return signTryOnAdminArchiveUrl({ publicId: PUBLIC_ID, kind, secret: SECRET, ttlMs });
}

function request(path: string) {
  return app.request(path, {
    headers: h.state.user ? { authorization: "Bearer test-token" } : {},
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  tempDir = await mkdtemp(path.join(tmpdir(), "redcode-tryon-admin-media-test-"));
  oldPrivateDir = process.env.TRYON_PRIVATE_DIR;
  process.env.TRYON_PRIVATE_DIR = path.join(tempDir, "private");
  h.state.user = { userId: 9001, role: "admin" };
  h.state.account = { role: "admin" };
  h.state.job = { id: 11, createdAt: new Date(NOW - 60_000) };
  h.state.audits = [];
});

afterEach(async () => {
  if (oldPrivateDir === undefined) delete process.env.TRYON_PRIVATE_DIR;
  else process.env.TRYON_PRIVATE_DIR = oldPrivateDir;
  await rm(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("權限：只 supervisor／admin；每 request 以 DB 最新 role 判", () => {
  it("admin 睇 input 原相：200、JPEG bytes、no-store、寫咗 audit", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    const res = await request(signedPath("input"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    expect(h.state.audits).toHaveLength(1);
    expect(h.state.audits[0]).toMatchObject({
      actorId: 9001,
      actorRole: "admin",
      action: "tryon.adminMediaView",
      targetType: "tryonJob",
      targetId: PUBLIC_ID,
    });
    expect(h.state.audits[0].detail).toContain("原相");
  });

  it("supervisor 睇 output 生成圖：200 PNG（logo 缺失時安全回退原圖）", async () => {
    h.state.user = { userId: 9002, role: "supervisor" };
    h.state.account = { role: "supervisor" };
    await writeTryOnAdminArchive(PUBLIC_ID, "output", PNG);
    const res = await request(signedPath("output"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(h.state.audits[0]).toMatchObject({ actorId: 9002, actorRole: "supervisor" });
  });

  it("staff → 403；member → 403（同 JWT 快照無關，以 DB role 為準）", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    h.state.user = { userId: 9003, role: "staff" };
    h.state.account = { role: "staff" };
    expect((await request(signedPath())).status).toBe(403);
    h.state.user = { userId: 9004, role: "member" };
    h.state.account = { role: "member" };
    expect((await request(signedPath())).status).toBe(403);
    expect(h.state.audits).toHaveLength(0);
  });

  it("未登入（冇 Bearer）→ 401；帳號已刪（DB 搵唔到）→ 401", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    h.state.user = null;
    expect((await request(signedPath())).status).toBe(401);
    h.state.user = { userId: 9005, role: "admin" };
    h.state.account = null;
    expect((await request(signedPath())).status).toBe(401);
    expect(h.state.audits).toHaveLength(0);
  });

  it("降職：JWT 係 admin 但 DB 最新 role 係 member → 403，舊 token 即時失效", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    h.state.user = { userId: 9006, role: "admin" };
    h.state.account = { role: "member" };
    expect((await request(signedPath())).status).toBe(403);
    expect(h.state.audits).toHaveLength(0);
  });
});

describe("admin-archive HMAC：篡改／過期／跨 scope replay 全部 404", () => {
  function tamper(mutate: (url: URL) => void): string {
    const url = new URL(signedPath(), "https://redcode.red");
    mutate(url);
    return `${url.pathname}${url.search}`;
  }

  it("改 signature、改 kind、改 expires 全部 404", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    expect((await request(tamper((u) => u.searchParams.set("s", "forged")))).status).toBe(404);
    expect(
      (await request(tamper((u) => { u.pathname = u.pathname.replace(/input$/, "output"); }))).status,
    ).toBe(404);
    expect(
      (await request(tamper((u) => u.searchParams.set("e", String(Number(u.searchParams.get("e")) + 1))))).status,
    ).toBe(404);
    expect(h.state.audits).toHaveLength(0);
  });

  it("過期簽名同異常長（>15 分鐘）時效都 404", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    const expired = signTryOnAdminArchiveUrl({ publicId: PUBLIC_ID, kind: "input", secret: SECRET, now: NOW - 11 * 60 * 1000 });
    expect((await request(expired)).status).toBe(404);
    // 手工砌一個 16 分鐘時效（sign 會拒簽，所以用呢刻合法簽名再唔改 e 嘅做法唔得；
    // 直接喺 16 分鐘後驗證一個 15 分鐘 TTL 嘅 URL —— 已過期）
    const maxTtl = signTryOnAdminArchiveUrl({ publicId: PUBLIC_ID, kind: "input", secret: SECRET, ttlMs: 15 * 60 * 1000 });
    vi.setSystemTime(NOW + 15 * 60 * 1000);
    expect((await request(maxTtl)).status).toBe(404);
    expect(h.state.audits).toHaveLength(0);
  });

  it("客戶私人 scope 嘅簽名 replay 到後台 route：404", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    const customerUrl = new URL(
      signTryOnMediaUrl({ publicId: PUBLIC_ID, kind: "input", userId: 7, secret: SECRET, now: NOW }),
      "https://redcode.red",
    );
    const replayed = `/api/admin/tryon-media/${PUBLIC_ID}/input?e=${customerUrl.searchParams.get("e")}&s=${encodeURIComponent(customerUrl.searchParams.get("s")!)}`;
    expect((await request(replayed)).status).toBe(404);
    expect(h.state.audits).toHaveLength(0);
  });

  it("kind 參數唔係 input／output：404", async () => {
    const url = new URL(signedPath(), "https://redcode.red");
    expect((await request(`/api/admin/tryon-media/${PUBLIC_ID}/original${url.search}`)).status).toBe(404);
  });
});

describe("30 日 retention：只按 tryOnJobs.createdAt", () => {
  it("29d23:59:59.999 仲睇到（200）；啱啱好 30 日 → 410", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    h.state.job = { id: 11, createdAt: new Date(NOW - TRYON_ADMIN_ARCHIVE_RETENTION_MS + 1) };
    expect((await request(signedPath())).status).toBe(200);

    h.state.job = { id: 11, createdAt: new Date(NOW - TRYON_ADMIN_ARCHIVE_RETENTION_MS) };
    const res = await request(signedPath());
    expect(res.status).toBe(410);
  });

  it("客戶私人媒體早已刪除（24 小時已過）後台副本仍 200；handler 唔睇 expiresAt／mediaDeletedAt", async () => {
    // 客戶私人檔從未存在喺今次測試嘅 private dir——等於已被 deleteTryOnMedia 清走；
    // 後台副本係獨立目錄，唔受影響。
    const { deleteTryOnMedia } = await import("./tryonMedia");
    await deleteTryOnMedia(PUBLIC_ID);
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    h.state.job = { id: 11, createdAt: new Date(NOW - 20 * 24 * 60 * 60 * 1000) }; // 20 日前（客戶層一早過期）
    const res = await request(signedPath());
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("job 唔存在 → 404；副本檔案唔存在（已被 sweeper 清走）→ 404", async () => {
    await writeTryOnAdminArchive(PUBLIC_ID, "input", JPEG);
    h.state.job = null;
    expect((await request(signedPath())).status).toBe(404);

    h.state.job = { id: 11, createdAt: new Date(NOW - 60_000) };
    h.state.user = { userId: 9001, role: "admin" };
    const otherId = "223e4567-e89b-42d3-a456-426614174000";
    const missing = signTryOnAdminArchiveUrl({ publicId: otherId, kind: "input", secret: SECRET });
    h.state.job = { id: 12, createdAt: new Date(NOW - 60_000) };
    // job 查詢按 publicId 對應——mock 統一回 state.job，所以呢度淨係驗副本檔案缺失 → 404
    expect((await request(missing)).status).toBe(404);
  });
});
