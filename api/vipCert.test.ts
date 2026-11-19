/**
 * S05（2026-11-19 安全修復）：VIP 證書 HMAC 密鑰同 JWT secret 分離。
 *
 * 原始弱點：證書驗證簽名直接用 JWT_SECRET——JWT 密鑰一旦失守，攻擊者仲可以
 * 偽造任何會員編號嘅「官方驗證通過」連結（跨用途 secret 重用）。
 *
 * 修復後：
 * ─ 設咗 VIP_CERT_SECRET → 簽／驗都只用專用密鑰；JWT_SECRET 簽嘅即拒（真分離）；
 * ─ 過渡期 VIP_CERT_LEGACY_ACCEPT=1 → 額外接受 JWT_SECRET 舊簽名（已印實體證書 QR）；
 * ─ 未設 VIP_CERT_SECRET → 向後兼容用 JWT_SECRET（警告一次；安全性同舊版一致）。
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signVipCertMemberNo, verifyVipCertSignature } from "./vipCert";

const JWT = "test-jwt-secret-fixture";
const VIP = "test-vip-cert-secret-fixture";
const MEMBER_NO = "RC-000128";

const legacySig = (memberNo: string) =>
  createHmac("sha256", JWT).update(`vip-cert:${memberNo}`).digest("hex");
const dedicatedSig = (memberNo: string) =>
  createHmac("sha256", VIP).update(`vip-cert:${memberNo}`).digest("hex");

beforeEach(() => {
  delete process.env.VIP_CERT_SECRET;
  delete process.env.VIP_CERT_LEGACY_ACCEPT;
  process.env.JWT_SECRET = JWT;
});
afterEach(() => {
  delete process.env.VIP_CERT_SECRET;
  delete process.env.VIP_CERT_LEGACY_ACCEPT;
});

describe("向後兼容（未設 VIP_CERT_SECRET）", () => {
  it("簽名用 JWT_SECRET；驗證接受 JWT_SECRET 簽名（同舊版一致）", () => {
    expect(signVipCertMemberNo(MEMBER_NO)).toBe(legacySig(MEMBER_NO));
    expect(verifyVipCertSignature(MEMBER_NO, legacySig(MEMBER_NO))).toBe(true);
    expect(verifyVipCertSignature(MEMBER_NO, "0".repeat(64))).toBe(false);
  });
  it("JWT_SECRET 都冇 → 簽名回空字串，驗證失敗（fail-closed）", () => {
    delete process.env.JWT_SECRET;
    expect(signVipCertMemberNo(MEMBER_NO)).toBe("");
    expect(verifyVipCertSignature(MEMBER_NO, legacySig(MEMBER_NO))).toBe(false);
  });
});

describe("密鑰分離（設咗 VIP_CERT_SECRET）", () => {
  beforeEach(() => {
    process.env.VIP_CERT_SECRET = VIP;
  });
  it("簽名轉用專用密鑰", () => {
    expect(signVipCertMemberNo(MEMBER_NO)).toBe(dedicatedSig(MEMBER_NO));
  });
  it("★ 修復核心：JWT_SECRET 簽嘅連結即時唔再通過（分離生效）", () => {
    expect(verifyVipCertSignature(MEMBER_NO, legacySig(MEMBER_NO))).toBe(false);
    expect(verifyVipCertSignature(MEMBER_NO, dedicatedSig(MEMBER_NO))).toBe(true);
  });
  it("過渡期 VIP_CERT_LEGACY_ACCEPT=1：舊簽名照收（已印證書 QR 唔會即時失效）", () => {
    process.env.VIP_CERT_LEGACY_ACCEPT = "1";
    expect(verifyVipCertSignature(MEMBER_NO, legacySig(MEMBER_NO))).toBe(true);
    expect(verifyVipCertSignature(MEMBER_NO, dedicatedSig(MEMBER_NO))).toBe(true);
    // 亂簽仍然拒
    expect(verifyVipCertSignature(MEMBER_NO, "f".repeat(64))).toBe(false);
  });
  it("大細楷 hex 都接受（vipRouter 入口有 64-hex 格式檢查）", () => {
    expect(verifyVipCertSignature(MEMBER_NO, dedicatedSig(MEMBER_NO).toUpperCase())).toBe(true);
  });
});
