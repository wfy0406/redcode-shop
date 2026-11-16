import fs from "node:fs";
import { describe, expect, it } from "vitest";

const sw = fs.readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");

describe("Service Worker — Chrome-only manifest 快取隔離", () => {
  it("manifest 唔再 precache，亦唔會跌入 SWR media cache", () => {
    const shell = sw.match(/var RC_SHELL_URLS = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect(shell).not.toContain("'/manifest.webmanifest'");
    expect(sw).toContain("if (url.pathname === '/manifest.webmanifest') return;");
    expect(sw).toContain("var RC_VERSION = 'v3';");
  });

  it("HTML 用版本化 manifest URL，第一次載入就繞過舊 SW 無 query cache", () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest?v=20261117" />');
    expect(indexHtml).not.toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("開播 push 同 notificationclick 職責保持原樣存在", () => {
    expect(sw).toContain("self.addEventListener('push'");
    expect(sw).toContain("self.registration.showNotification");
    expect(sw).toContain("self.addEventListener('notificationclick'");
    expect(sw).toContain("event.notification.close()");
  });
});
