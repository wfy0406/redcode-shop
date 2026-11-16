import { describe, expect, it } from "vitest";
import {
  isChromeAndroidUserAgent,
  shouldDisableAndroidWebApk,
} from "./pwaInstallPolicy";

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
const SAMSUNG_INTERNET =
  "Mozilla/5.0 (Linux; Android 16; SM-S9280) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36";
const EDGE_ANDROID =
  "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 EdgA/142.0.0.0";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 16; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0";
const LEGACY_ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; U; Android 4.4.4; en-us; Build/KTU84P) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Chrome/33.0.0.0 Mobile Safari/534.30";

const CHROMIUM_BRANCH_UAS: Array<[string, string]> = [
  ["DuckDuckGo", `${CHROME_ANDROID} DuckDuckGo/5`],
  ["QQ Browser", CHROME_ANDROID.replace("Chrome/142.0.0.0", "Chrome/109.0.0.0 MQQBrowser/14.0")],
  ["Puffin", `${CHROME_ANDROID} Puffin/9.9.0.51519`],
  ["Whale", `${CHROME_ANDROID} Whale/3.28.266.14`],
  ["Aloha", `${CHROME_ANDROID} AlohaBrowser/5.9.0`],
  ["Maxthon", `${CHROME_ANDROID} Maxthon/7.1.7.8000`],
  ["Oppo", `${CHROME_ANDROID} OppoBrowser/40.8.6.1`],
  ["Sogou", `${CHROME_ANDROID} SogouMobileBrowser/6.9.18`],
  ["2345 Browser", `${CHROME_ANDROID} 2345Browser/16.1.6`],
  ["Liebao", `${CHROME_ANDROID} LBBROWSER`],
];

describe("Android WebAPK Chrome-only 相容政策", () => {
  it("Chrome Android 保留真正 WebAPK 安裝", () => {
    expect(isChromeAndroidUserAgent(CHROME_ANDROID)).toBe(true);
    expect(shouldDisableAndroidWebApk(CHROME_ANDROID)).toBe(false);
  });

  it.each([
    ["Samsung Internet", SAMSUNG_INTERNET],
    ["Android WebView", ANDROID_WEBVIEW],
    ["legacy Android WebView", LEGACY_ANDROID_WEBVIEW],
    ["Edge Android", EDGE_ANDROID],
    ["Firefox Android", FIREFOX_ANDROID],
    ...CHROMIUM_BRANCH_UAS,
  ])("%s 唔再生成 WebAPK", (_name, ua) => {
    expect(isChromeAndroidUserAgent(ua)).toBe(false);
    expect(shouldDisableAndroidWebApk(ua)).toBe(true);
  });

  it("iPhone 同桌面唔受 Android 封鎖影響", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1";
    const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36";
    expect(shouldDisableAndroidWebApk(iphone)).toBe(false);
    expect(shouldDisableAndroidWebApk(desktop)).toBe(false);
    expect(shouldDisableAndroidWebApk(null)).toBe(false);
  });
});
