/**
 * R14（2026-11-19 安全修復）：DB TLS 策略測試——resolveDbSslConfig 純函數。
 *
 * 原始弱點：非 localhost 連線一律 { rejectUnauthorized:false }——TLS 有開但
 * 唔驗證證書，中間人可以用自簽證書攔截 DB 連線。
 * 修復後：提供 CA（內容或檔案）即 rejectUnauthorized:true；錯 CA 連線必敗
 * （pg driver 行為，呢度驗證嘅係「配置一定開驗證」呢個前提）。
 * 明確 opt-out（DATABASE_SSL=disable，例如 Render 內網明文）→ ssl:false；
 * 乜都冇設 → 保留舊行為＋警告（唔好靜默改部署語意整冧現有連線）。
 *
 * ⚠️ 限制：呢度驗證配置生成；「錯 CA 連線實際失敗／正 CA 成功」要喺 staging
 * 用真 PostgreSQL 驗證（本 repo 測試唔掂真 DB）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDbSslConfig } from "./queries/connection";

const REMOTE_URL = "postgresql://user:pass@db.internal:5432/redcode";
const LOCAL_URL = "postgresql://user:pass@localhost:5432/redcode";
const FAKE_CA = "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----";

describe("resolveDbSslConfig（R14）", () => {
  it("localhost／127.0.0.1 永遠 ssl:false（本地 dev/test）", () => {
    expect(resolveDbSslConfig(LOCAL_URL, {}).ssl).toBe(false);
    expect(resolveDbSslConfig("postgresql://u:p@127.0.0.1:5432/db", {}).ssl).toBe(false);
    // localhost 就算設咗 DATABASE_SSL 都係 false——本地唔會誤開 TLS
    expect(resolveDbSslConfig(LOCAL_URL, { DATABASE_CA_CERT: FAKE_CA }).ssl).toBe(false);
  });
  it("★ 修復核心：提供 DATABASE_CA_CERT → rejectUnauthorized:true＋用指定 CA", () => {
    const r = resolveDbSslConfig(REMOTE_URL, { DATABASE_CA_CERT: FAKE_CA });
    expect(r.warning).toBeNull();
    expect(r.ssl).toEqual({ rejectUnauthorized: true, ca: FAKE_CA });
  });
  it("DATABASE_CA_FILE 由檔案讀 CA，同樣開完整驗證", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-test-"));
    const file = path.join(dir, "ca.pem");
    writeFileSync(file, FAKE_CA);
    const r = resolveDbSslConfig(REMOTE_URL, { DATABASE_CA_FILE: file });
    expect(r.ssl).toEqual({ rejectUnauthorized: true, ca: FAKE_CA });
  });
  it("DATABASE_SSL=disable 明確 opt-out → ssl:false 唔警告", () => {
    const r = resolveDbSslConfig(REMOTE_URL, { DATABASE_SSL: "disable" });
    expect(r.ssl).toBe(false);
    expect(r.warning).toBeNull();
    expect(resolveDbSslConfig(REMOTE_URL, { DATABASE_SSL: " Disable " }).ssl).toBe(false);
  });
  it("乜都冇設 → 保留舊行為（rejectUnauthorized:false）兼出信任邊界警告", () => {
    const r = resolveDbSslConfig(REMOTE_URL, {});
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
    expect(r.warning).toContain("DATABASE_CA_CERT");
  });
  it("CA 優先於 disable 之外嘅模糊組合：CA 同時存在 → 用 CA", () => {
    const r = resolveDbSslConfig(REMOTE_URL, { DATABASE_CA_CERT: FAKE_CA, DATABASE_SSL: "require" });
    expect(r.ssl).toEqual({ rejectUnauthorized: true, ca: FAKE_CA });
  });
});
