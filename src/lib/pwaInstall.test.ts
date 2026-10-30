import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeforeInstallPromptEvent } from './pwaInstall';

function fakeBrowser(userAgent = 'Chrome Android') {
  const target = new EventTarget() as EventTarget & {
    matchMedia: (query: string) => { matches: boolean };
  };
  target.matchMedia = () => ({ matches: false });
  vi.stubGlobal('window', target);
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 0, standalone: false });
  return target;
}

function installEvent(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

describe('全站共用 PWA 安裝狀態', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('接住 beforeinstallprompt，接受後只可以用一次並標記已安裝', async () => {
    const browser = fakeBrowser();
    const pwa = await import('./pwaInstall');
    const event = installEvent('accepted');
    browser.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pwa.getPwaInstallSnapshot().canInstall).toBe(true);
    await expect(pwa.promptPwaInstall()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(pwa.getPwaInstallSnapshot()).toEqual({ canInstall: false, installed: true });
    await expect(pwa.promptPwaInstall()).resolves.toBe('unavailable');
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('取消系統安裝唔會誤報已安裝', async () => {
    const browser = fakeBrowser();
    const pwa = await import('./pwaInstall');
    browser.dispatchEvent(installEvent('dismissed'));

    await expect(pwa.promptPwaInstall()).resolves.toBe('dismissed');
    expect(pwa.getPwaInstallSnapshot()).toEqual({ canInstall: false, installed: false });
  });

  it('iPhone 冇原生事件時回傳 unavailable，並正確識別 iOS', async () => {
    fakeBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1');
    const pwa = await import('./pwaInstall');

    expect(pwa.isIos()).toBe(true);
    expect(pwa.getPwaInstallSnapshot().canInstall).toBe(false);
    await expect(pwa.promptPwaInstall()).resolves.toBe('unavailable');
  });
});
