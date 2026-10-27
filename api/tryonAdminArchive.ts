import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TryOnMediaError,
  readTryOnMedia,
  tryOnPrivateDir,
  type TryOnMediaKind,
} from "./tryonMedia";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 後台私人副本保留 30 日；boundary helper 用 createdAt + 30d > now 判斷。 */
export const TRYON_ADMIN_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 後台簽名連結預設 10 分鐘，最長 15 分鐘。 */
export const TRYON_ADMIN_ARCHIVE_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const TRYON_ADMIN_ARCHIVE_MAX_TTL_MS = 15 * 60 * 1000;

/**
 * HMAC scope 前綴：客戶私人 URL 嘅訊息係 `publicId.kind.userId.expires`，
 * 後台 admin-archive 用 `tryon-admin-archive.publicId.kind.expires`（絕不含 userId），
 * 訊息格式完全唔同，所以就算同一把 secret，客戶簽名都 replay 唔到後台 scope，
 * 反過來亦一樣；未來分享 scope 亦會有自己嘅前綴，唔會同呢度撞。
 */
const ADMIN_ARCHIVE_SCOPE = "tryon-admin-archive";

/**
 * Archive root 必須係 tryOnPrivateDir() 嘅 sibling（`${tryOnPrivateDir()}-admin`）。
 * deleteTryOnMedia(publicId) 只會 rm `tryOnPrivateDir()/<publicId>`，
 * 所以只要 archive root 唔喺 private dir 之內，客戶刪除／工作清理絕對刪唔到後台副本。
 * 刻意唔俾 env 覆寫，避免誤配指返入私人目錄而破壞隔離保證。
 */
export function tryOnAdminArchiveDir(): string {
  return `${tryOnPrivateDir()}-admin`;
}

function assertAdminArchivePublicId(publicId: string): void {
  if (!UUID_RE.test(publicId)) {
    throw new TryOnMediaError("BAD_JOB_ID", "工作編號格式無效");
  }
}

/** 後台 archive 路徑只由 UUID＋kind 生成，唔接任何外部路徑片段。 */
export function tryOnAdminArchiveRelativePath(publicId: string, kind: TryOnMediaKind): string {
  assertAdminArchivePublicId(publicId);
  return `${publicId}/${kind === "input" ? "input.jpg" : "output.png"}`;
}

export function tryOnAdminArchiveAbsolutePath(publicId: string, kind: TryOnMediaKind): string {
  return path.join(tryOnAdminArchiveDir(), tryOnAdminArchiveRelativePath(publicId, kind));
}

export async function writeTryOnAdminArchive(
  publicId: string,
  kind: TryOnMediaKind,
  bytes: Buffer,
): Promise<string> {
  const absolute = tryOnAdminArchiveAbsolutePath(publicId, kind);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, bytes, { mode: 0o600 });
  return tryOnAdminArchiveRelativePath(publicId, kind);
}

/**
 * 由客戶私人目錄複製一份入 30 日後台 archive。
 * 寫好之後兩份副本完全獨立：客戶刪除或工作清理私人檔案都唔會影響呢份。
 */
export async function archiveTryOnMediaCopy(
  publicId: string,
  kind: TryOnMediaKind,
): Promise<string> {
  const bytes = await readTryOnMedia(publicId, kind);
  return writeTryOnAdminArchive(publicId, kind, bytes);
}

export async function readTryOnAdminArchive(
  publicId: string,
  kind: TryOnMediaKind,
): Promise<Buffer> {
  return readFile(tryOnAdminArchiveAbsolutePath(publicId, kind));
}

/** 後台 retention 到期後專用刪除；同 deleteTryOnMedia 一樣只郁自己 scope 嘅目錄。 */
export async function deleteTryOnAdminArchive(publicId: string): Promise<void> {
  if (!UUID_RE.test(publicId)) return;
  await rm(path.join(tryOnAdminArchiveDir(), publicId), { recursive: true, force: true });
}

/**
 * Pure retention boundary：createdAt + 30 日仍然大過 now 先至睇得。
 * 29d23:59:59.999 仲睇到；啱啱好 30 日（createdAt + 30d === now）即拒。
 */
export function tryOnAdminArchiveAvailable(createdAt: Date, now?: number): boolean {
  return createdAt.getTime() + TRYON_ADMIN_ARCHIVE_RETENTION_MS > (now ?? Date.now());
}

function adminArchiveSignature(
  publicId: string,
  kind: TryOnMediaKind,
  expires: number,
  secret: string,
): string {
  if (!secret.trim()) {
    throw new TryOnMediaError("MEDIA_SECRET_MISSING", "後台圖片保護尚未配置");
  }
  return createHmac("sha256", secret)
    .update(`${ADMIN_ARCHIVE_SCOPE}.${publicId}.${kind}.${expires}`)
    .digest("base64url");
}

/**
 * 簽發後台專用短期連結：`/api/admin/tryon-media/:publicId/:kind?e=...&s=...`。
 * 絕不含 userId；TTL 預設 10 分鐘，超過 15 分鐘直接拒簽。
 */
export function signTryOnAdminArchiveUrl(args: {
  publicId: string;
  kind: TryOnMediaKind;
  secret: string;
  now?: number;
  ttlMs?: number;
}): string {
  assertAdminArchivePublicId(args.publicId);
  const ttl = args.ttlMs ?? TRYON_ADMIN_ARCHIVE_DEFAULT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > TRYON_ADMIN_ARCHIVE_MAX_TTL_MS) {
    throw new TryOnMediaError("BAD_MEDIA_REQUEST", "後台圖片連結時效無效");
  }
  const expires = (args.now ?? Date.now()) + ttl;
  const sig = adminArchiveSignature(args.publicId, args.kind, expires, args.secret);
  return `/api/admin/tryon-media/${args.publicId}/${args.kind}?e=${expires}&s=${encodeURIComponent(sig)}`;
}

export function verifyTryOnAdminArchiveSignature(args: {
  publicId: string;
  kind: TryOnMediaKind;
  expires: number;
  supplied: string;
  secret: string;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  if (
    !args.secret.trim() ||
    !UUID_RE.test(args.publicId) ||
    !Number.isInteger(args.expires) ||
    args.expires <= now
  ) {
    return false;
  }
  if (args.expires > now + TRYON_ADMIN_ARCHIVE_MAX_TTL_MS) return false;
  let expected: string;
  try {
    expected = adminArchiveSignature(args.publicId, args.kind, args.expires, args.secret);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(args.supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
