import { useEffect, useState } from 'react';

/** Chromium 專有安裝事件；事件只可以用一次，全站共用同一份狀態。 */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export type PwaInstallOutcome = 'accepted' | 'dismissed' | 'unavailable' | 'error';
export type PwaInstallSnapshot = { canInstall: boolean; installed: boolean };

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
let installed = false;
let snapshot: PwaInstallSnapshot = { canInstall: false, installed: false };
const listeners = new Set<() => void>();

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iphone|ipod/i.test(ua) ||
    /ipad/i.test(ua) ||
    (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function publish(): void {
  installed = installed || isStandalone();
  snapshot = { canInstall: Boolean(deferredPrompt), installed };
  listeners.forEach((listener) => listener());
}

function onBeforeInstallPrompt(event: Event): void {
  // 全站只攔一次；InstallBanner 同 FAQ 安裝掣共用，唔會各自搶事件。
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  publish();
}

function onInstalled(): void {
  deferredPrompt = null;
  installed = true;
  publish();
}

export function ensurePwaInstallCapture(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  installed = isStandalone();
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onInstalled);
  publish();
}

// 模組隨 Layout 載入，盡早接住瀏覽器事件；唔使等某個頁面先 mount。
ensurePwaInstallCapture();

export function getPwaInstallSnapshot(): PwaInstallSnapshot {
  ensurePwaInstallCapture();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  ensurePwaInstallCapture();
  listeners.add(listener);
  listener();
  return () => listeners.delete(listener);
}

export function usePwaInstall(): PwaInstallSnapshot {
  const [current, setCurrent] = useState<PwaInstallSnapshot>(getPwaInstallSnapshot);
  useEffect(() => subscribe(() => setCurrent(getPwaInstallSnapshot())), []);
  return current;
}

export async function promptPwaInstall(): Promise<PwaInstallOutcome> {
  ensurePwaInstallCapture();
  const promptEvent = deferredPrompt;
  if (!promptEvent) return 'unavailable';

  // 無論接受、取消或失敗，呢個 event 都唔可以重用。
  deferredPrompt = null;
  publish();
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === 'accepted') installed = true;
    publish();
    return choice.outcome;
  } catch {
    publish();
    return 'error';
  }
}
