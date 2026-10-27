import { createHmac, timingSafeEqual } from "node:crypto";
import { TRYON_MEDIA_RETENTION_MS } from "./tryonConfig";
import { TryOnMediaError } from "./tryonMedia";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_SCOPE = "tryon-share-v1";

function assertShareInput(publicId: string, expires: number, secret: string): void {
  if (!UUID_RE.test(publicId) || !Number.isSafeInteger(expires) || !secret.trim()) {
    throw new TryOnMediaError("BAD_SHARE_REQUEST", "分享連結資料無效");
  }
}

function signature(publicId: string, expires: number, secret: string): string {
  assertShareInput(publicId, expires, secret);
  return createHmac("sha256", secret).update(`${SHARE_SCOPE}.${publicId}.${expires}`).digest("base64url");
}

/**
 * 分享頁及分享媒體用同一把有時限凭证；expires 必須同 DB job.expiresAt 完全一致。
 * 呢條鏈唔綁 userId，亦唔回客戶原相；每次讀取仍會查 DB 狀態及到期。
 */
export function signTryOnShare(args: { publicId: string; expiresAt: Date; secret: string }): {
  url: string;
  mediaUrl: string;
  expiresAt: Date;
} {
  const expires = args.expiresAt.getTime();
  const supplied = signature(args.publicId, expires, args.secret);
  const query = `e=${expires}&s=${encodeURIComponent(supplied)}`;
  return {
    url: `/try-on/shared/${args.publicId}?${query}`,
    mediaUrl: `/api/tryon/shared-media/${args.publicId}?${query}`,
    expiresAt: args.expiresAt,
  };
}

export function verifyTryOnShare(args: {
  publicId: string;
  expires: number;
  supplied: string;
  secret: string;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  if (
    !args.secret.trim() ||
    !UUID_RE.test(args.publicId) ||
    !Number.isSafeInteger(args.expires) ||
    args.expires <= now ||
    args.expires > now + TRYON_MEDIA_RETENTION_MS
  ) {
    return false;
  }
  const expected = signature(args.publicId, args.expires, args.secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(args.supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
