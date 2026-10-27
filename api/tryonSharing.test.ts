import { describe, expect, it } from "vitest";
import { signTryOnMediaUrl } from "./tryonMedia";
import { signTryOnShare, verifyTryOnShare } from "./tryonSharing";

const publicId = "123e4567-e89b-42d3-a456-426614174000";
const secret = "unit-test-only-secret";
const now = Date.parse("2026-10-28T00:00:00.000Z");

function signed(expiresAt = new Date(now + 60 * 60 * 1000)) {
  const signedValue = signTryOnShare({ publicId, expiresAt, secret });
  const url = new URL(signedValue.url, "https://example.test");
  return {
    ...signedValue,
    expires: Number(url.searchParams.get("e")),
    supplied: url.searchParams.get("s") ?? "",
  };
}

describe("24 小時 AI 試穿分享凭证", () => {
  it("分享頁及媒體用同一 scope；有效期限內可驗證", () => {
    const value = signed();
    expect(value.url).toContain(`/try-on/shared/${publicId}?`);
    expect(value.mediaUrl).toContain(`/api/tryon/shared-media/${publicId}?`);
    expect(verifyTryOnShare({ publicId, ...value, secret, now })).toBe(true);
    expect(verifyTryOnShare({ publicId, ...value, secret, now: value.expires - 1 })).toBe(true);
  });

  it("剛好到期即拒；篡改 id、期限、簽名或 secret 即拒", () => {
    const value = signed();
    expect(verifyTryOnShare({ publicId, ...value, secret, now: value.expires })).toBe(false);
    expect(verifyTryOnShare({ publicId, ...value, expires: value.expires + 1, secret, now })).toBe(false);
    expect(verifyTryOnShare({ publicId, ...value, supplied: `${value.supplied}x`, secret, now })).toBe(false);
    expect(verifyTryOnShare({ publicId, ...value, secret: "wrong", now })).toBe(false);
    expect(verifyTryOnShare({ publicId: "323e4567-e89b-42d3-a456-426614174000", ...value, secret, now })).toBe(false);
  });

  it("客戶私人媒體 URL 不能 replay 做分享", () => {
    const privateUrl = new URL(
      signTryOnMediaUrl({ publicId, kind: "output", userId: 7, secret, now }),
      "https://example.test",
    );
    expect(
      verifyTryOnShare({
        publicId,
        expires: Number(privateUrl.searchParams.get("e")),
        supplied: privateUrl.searchParams.get("s") ?? "",
        secret,
        now,
      }),
    ).toBe(false);
  });

  it("無效 UUID、非整數期限及超過 24 小時嘅未來期限都拒", () => {
    const value = signed();
    expect(verifyTryOnShare({ publicId: "bad", ...value, secret, now })).toBe(false);
    expect(verifyTryOnShare({ publicId, ...value, expires: value.expires + 0.5, secret, now })).toBe(false);
    expect(verifyTryOnShare({ publicId, ...value, expires: now + 24 * 60 * 60 * 1000 + 1, secret, now })).toBe(false);
  });
});
