import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteTryOnMedia,
  readTryOnMedia,
  signTryOnMediaUrl,
  tryOnMediaAbsolutePath,
  verifyTryOnMediaSignature,
  writeTryOnMedia,
} from "./tryonMedia";
import {
  TRYON_ADMIN_ARCHIVE_DEFAULT_TTL_MS,
  TRYON_ADMIN_ARCHIVE_MAX_TTL_MS,
  TRYON_ADMIN_ARCHIVE_RETENTION_MS,
  archiveTryOnMediaCopy,
  deleteTryOnAdminArchive,
  readTryOnAdminArchive,
  signTryOnAdminArchiveUrl,
  tryOnAdminArchiveAbsolutePath,
  tryOnAdminArchiveAvailable,
  tryOnAdminArchiveDir,
  tryOnAdminArchiveRelativePath,
  verifyTryOnAdminArchiveSignature,
  writeTryOnAdminArchive,
} from "./tryonAdminArchive";

const PUBLIC_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECRET = "unit-test-admin-archive-secret";
const NOW = 1_700_000_000_000;
const INPUT_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OUTPUT_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

let tempDir = "";
let privateDir = "";
let oldPrivateDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "redcode-tryon-admin-archive-test-"));
  oldPrivateDir = process.env.TRYON_PRIVATE_DIR;
  privateDir = path.join(tempDir, "private");
  process.env.TRYON_PRIVATE_DIR = privateDir;
});

afterEach(async () => {
  if (oldPrivateDir === undefined) delete process.env.TRYON_PRIVATE_DIR;
  else process.env.TRYON_PRIVATE_DIR = oldPrivateDir;
  await rm(tempDir, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("後台 30 日私人副本目錄隔離", () => {
  it("archive root 係 tryOnPrivateDir() 嘅 sibling，絕對唔喺私人目錄之內", () => {
    const archiveDir = tryOnAdminArchiveDir();
    expect(archiveDir).toBe(`${privateDir}-admin`);
    expect(path.dirname(archiveDir)).toBe(path.dirname(privateDir));
    expect(archiveDir.startsWith(privateDir + path.sep)).toBe(false);
  });

  it("write/read input 同 output；路徑只由 UUID＋kind 生成；權限 0700／0600", async () => {
    const inputRel = await writeTryOnAdminArchive(PUBLIC_ID, "input", INPUT_BYTES);
    const outputRel = await writeTryOnAdminArchive(PUBLIC_ID, "output", OUTPUT_BYTES);
    expect(inputRel).toBe(`${PUBLIC_ID}/input.jpg`);
    expect(outputRel).toBe(`${PUBLIC_ID}/output.png`);

    const absolute = tryOnAdminArchiveAbsolutePath(PUBLIC_ID, "output");
    expect(absolute).toBe(path.join(`${privateDir}-admin`, PUBLIC_ID, "output.png"));
    expect((await stat(absolute)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(absolute))).mode & 0o777).toBe(0o700);

    await expect(readTryOnAdminArchive(PUBLIC_ID, "input")).resolves.toEqual(INPUT_BYTES);
    await expect(readTryOnAdminArchive(PUBLIC_ID, "output")).resolves.toEqual(OUTPUT_BYTES);
  });

  it("非 UUID 及路徑穿越 publicId 全部拒絕；delete 對壞 ID 係 no-op", async () => {
    const badIds = [
      "not-a-uuid",
      `${PUBLIC_ID}/../secret`,
      "..",
      `${PUBLIC_ID} extra`,
      "123e4567-e89b-42d3-a456-42661417400", // 少一個位
    ];
    for (const bad of badIds) {
      expect(() => tryOnAdminArchiveRelativePath(bad, "input")).toThrow();
      await expect(writeTryOnAdminArchive(bad, "input", INPUT_BYTES)).rejects.toThrow();
      await expect(readTryOnAdminArchive(bad, "output")).rejects.toThrow();
      await expect(deleteTryOnAdminArchive(bad)).resolves.toBeUndefined();
    }
    expect(await exists(`${privateDir}-admin`)).toBe(false);
  });

  it("deleteTryOnMedia 刪走客戶私人檔之後，archive 副本仍然完整", async () => {
    await writeTryOnMedia(PUBLIC_ID, "input", INPUT_BYTES);
    await writeTryOnMedia(PUBLIC_ID, "output", OUTPUT_BYTES);
    await archiveTryOnMediaCopy(PUBLIC_ID, "input");
    await archiveTryOnMediaCopy(PUBLIC_ID, "output");

    await deleteTryOnMedia(PUBLIC_ID);
    expect(await exists(tryOnMediaAbsolutePath(PUBLIC_ID, "input"))).toBe(false);
    expect(await exists(tryOnMediaAbsolutePath(PUBLIC_ID, "output"))).toBe(false);
    await expect(readTryOnAdminArchive(PUBLIC_ID, "input")).resolves.toEqual(INPUT_BYTES);
    await expect(readTryOnAdminArchive(PUBLIC_ID, "output")).resolves.toEqual(OUTPUT_BYTES);
  });

  it("copy 之後兩份副本獨立：改寫／刪除任何一邊都唔影響另一邊", async () => {
    await writeTryOnMedia(PUBLIC_ID, "output", OUTPUT_BYTES);
    await archiveTryOnMediaCopy(PUBLIC_ID, "output");

    const changed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    await writeTryOnMedia(PUBLIC_ID, "output", changed);
    await expect(readTryOnAdminArchive(PUBLIC_ID, "output")).resolves.toEqual(OUTPUT_BYTES);

    await deleteTryOnAdminArchive(PUBLIC_ID);
    expect(await exists(tryOnAdminArchiveAbsolutePath(PUBLIC_ID, "output"))).toBe(false);
    await expect(readTryOnAdminArchive(PUBLIC_ID, "output")).rejects.toThrow();
    // 後台刪除唔會郁到客戶私人檔
    await expect(readTryOnMedia(PUBLIC_ID, "output")).resolves.toEqual(changed);
    await expect(deleteTryOnAdminArchive(PUBLIC_ID)).resolves.toBeUndefined();
  });
});

describe("後台 HMAC scope 簽名連結", () => {
  function signed(now = NOW, ttlMs?: number) {
    const url = signTryOnAdminArchiveUrl({ publicId: PUBLIC_ID, kind: "output", secret: SECRET, now, ttlMs });
    const parsed = new URL(url, "https://redcode.red");
    return {
      url,
      parsed,
      publicId: parsed.pathname.split("/")[4]!,
      kind: "output" as const,
      expires: Number(parsed.searchParams.get("e")),
      supplied: parsed.searchParams.get("s")!,
      secret: SECRET,
    };
  }

  it("URL 格式係 /api/admin/tryon-media/:publicId/:kind?e=...&s=...，預設 TTL 10 分鐘，絕不含 userId", () => {
    const value = signed();
    expect(value.url.startsWith(`/api/admin/tryon-media/${PUBLIC_ID}/output?`)).toBe(true);
    expect(value.expires - NOW).toBe(TRYON_ADMIN_ARCHIVE_DEFAULT_TTL_MS);
    expect(TRYON_ADMIN_ARCHIVE_DEFAULT_TTL_MS).toBe(10 * 60 * 1000);
    expect(value.parsed.searchParams.get("u")).toBeNull();
    expect(value.url).not.toContain("userId");
    expect(verifyTryOnAdminArchiveSignature({ ...value, now: NOW })).toBe(true);
  });

  it("TTL 最長 15 分鐘：啱啱好 15 分鐘簽到，超過即拒簽；驗證都唔俾異常長時效", () => {
    const maxed = signed(NOW, TRYON_ADMIN_ARCHIVE_MAX_TTL_MS);
    expect(TRYON_ADMIN_ARCHIVE_MAX_TTL_MS).toBe(15 * 60 * 1000);
    expect(maxed.expires - NOW).toBe(15 * 60 * 1000);
    expect(verifyTryOnAdminArchiveSignature({ ...maxed, now: NOW })).toBe(true);

    expect(() =>
      signTryOnAdminArchiveUrl({
        publicId: PUBLIC_ID,
        kind: "output",
        secret: SECRET,
        now: NOW,
        ttlMs: TRYON_ADMIN_ARCHIVE_MAX_TTL_MS + 1,
      }),
    ).toThrow();
    expect(() =>
      signTryOnAdminArchiveUrl({ publicId: PUBLIC_ID, kind: "output", secret: SECRET, now: NOW, ttlMs: 0 }),
    ).toThrow();

    const value = signed();
    expect(
      verifyTryOnAdminArchiveSignature({ ...value, expires: NOW + 16 * 60 * 1000, now: NOW }),
    ).toBe(false);
  });

  it("過期、錯 kind、錯 secret、空 secret、壞 publicId 全部拒絕", () => {
    const value = signed();
    expect(verifyTryOnAdminArchiveSignature({ ...value, now: value.expires })).toBe(false);
    expect(verifyTryOnAdminArchiveSignature({ ...value, kind: "input", now: NOW })).toBe(false);
    expect(verifyTryOnAdminArchiveSignature({ ...value, secret: "wrong-secret", now: NOW })).toBe(false);
    expect(verifyTryOnAdminArchiveSignature({ ...value, secret: " ", now: NOW })).toBe(false);
    expect(verifyTryOnAdminArchiveSignature({ ...value, publicId: "bad", now: NOW })).toBe(false);
    expect(() =>
      signTryOnAdminArchiveUrl({ publicId: PUBLIC_ID, kind: "output", secret: "", now: NOW }),
    ).toThrow();
    expect(() =>
      signTryOnAdminArchiveUrl({ publicId: "bad", kind: "output", secret: SECRET, now: NOW }),
    ).toThrow();
  });

  it("防 scope replay：客戶私人簽名過唔到後台驗證，後台簽名亦過唔到客戶驗證（同一把 secret 都唔得）", () => {
    // 客戶私人 scope 嘅簽名 replay 去後台
    const customerUrl = signTryOnMediaUrl({ publicId: PUBLIC_ID, kind: "output", userId: 7, secret: SECRET, now: NOW });
    const customerParsed = new URL(customerUrl, "https://redcode.red");
    expect(
      verifyTryOnAdminArchiveSignature({
        publicId: PUBLIC_ID,
        kind: "output",
        expires: Number(customerParsed.searchParams.get("e")),
        supplied: customerParsed.searchParams.get("s")!,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);

    // 後台 scope 嘅簽名 replay 去客戶私人驗證
    const admin = signed();
    expect(
      verifyTryOnMediaSignature({
        publicId: PUBLIC_ID,
        kind: "output",
        userId: 7,
        expires: admin.expires,
        supplied: admin.supplied,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("30 日 retention boundary", () => {
  it("30 日常數正確", () => {
    expect(TRYON_ADMIN_ARCHIVE_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("29d23:59:59.999 仲睇到；啱啱好 30 日即拒；之後都拒", () => {
    const createdAt = new Date(NOW);
    expect(tryOnAdminArchiveAvailable(createdAt, NOW + TRYON_ADMIN_ARCHIVE_RETENTION_MS - 1)).toBe(true);
    expect(tryOnAdminArchiveAvailable(createdAt, NOW + TRYON_ADMIN_ARCHIVE_RETENTION_MS)).toBe(false);
    expect(tryOnAdminArchiveAvailable(createdAt, NOW + TRYON_ADMIN_ARCHIVE_RETENTION_MS + 1)).toBe(false);
  });
});
