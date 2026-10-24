import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';

/**
 * PWA 安裝提示 banner（2026-10）——原位可收起，唔係全屏彈窗。
 *
 * - Android/Chrome：攔 beforeinstallprompt，延後到客人撳「安裝」先 prompt()
 * - iOS：冇 beforeinstallprompt，顯示「Safari 分享 → 加至主畫面」簡短指引
 *   （iPhone 要 A2HS 先收到 Web Push，呢個 banner 係通知 funnel 第一級）
 * - 已安裝（display-mode: standalone／iOS navigator.standalone）→ 唔顯示
 * - 撳「暫時唔使」／關閉 → localStorage 記低，14 日內唔再煩佢
 */

const DISMISS_KEY = 'rc_install_banner_dismissed_at';
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

/** beforeinstallprompt 係 Chromium 專有事件，TS 冇型別，自己定 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ 扮 Mac，用 touch 點數分辨
  return (
    /iphone|ipod/i.test(ua) ||
    (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
    /ipad/i.test(ua)
  );
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function dismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < DISMISS_MS;
  } catch {
    return false; // localStorage 唔用得就當冇 dismiss 過（寧願顯示）
  }
}

function rememberDismiss(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // 記唔到就算，最多次次載入都睇到 banner，唔會壞事
  }
}

export default function InstallBanner() {
  // 'android'（攔到 beforeinstallprompt）/ 'ios'（Safari 指引）/ null（唔顯示）
  const [mode, setMode] = useState<'android' | 'ios' | null>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || dismissedRecently()) return;

    const onBeforeInstallPrompt = (e: Event) => {
      // 阻止瀏覽器預設迷你提示，改用自己嘅原位 banner
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setMode('android');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);

    // iOS 冇 beforeinstallprompt：靜候一拍都冇攔到、又係 iOS，先出 Safari 指引
    const iosTimer = window.setTimeout(() => {
      setMode((prev) => (prev === null && isIos() ? 'ios' : prev));
    }, 1500);

    // 安裝完成後即刻收 banner
    const onInstalled = () => setMode(null);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.clearTimeout(iosTimer);
    };
  }, []);

  if (mode === null) return null;

  const dismiss = () => {
    rememberDismiss();
    setMode(null);
    setDeferredPrompt(null);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setMode(null); // 裝咗就唔使再記 dismiss
      } else {
        dismiss(); // 用戶喺系統彈窗揀取消 → 當「暫時唔使」處理
      }
    } catch {
      dismiss();
    } finally {
      setDeferredPrompt(null); // 每個 deferred prompt 只可以用一次
    }
  };

  return (
    <div
      role="region"
      aria-label="安裝 RedCode App 提示"
      className="fixed inset-x-0 bottom-0 z-50 px-4"
      style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto flex w-full max-w-lg items-start gap-3 rounded-2xl border border-gold/50 bg-space-2/95 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-sm">
        <img
          src="/pwa-icon-192.png"
          alt=""
          aria-hidden="true"
          className="mt-0.5 h-11 w-11 shrink-0 rounded-xl"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold leading-snug">安裝 RedCode App</p>
          {mode === 'android' ? (
            <p className="mt-0.5 text-sm leading-relaxed text-txt-2">
              加到主畫面，開播通知更快收到，一撳即入直播間。
            </p>
          ) : (
            <p className="mt-0.5 text-sm leading-relaxed text-txt-2">
              用 Safari 開呢個網站，撳底部「分享」
              <Share size={14} className="mx-0.5 inline-block align-[-2px]" aria-hidden="true" />
              → 揀「加至主畫面」，之後先可以收到開播通知。
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {mode === 'android' && (
              <button
                type="button"
                onClick={install}
                className="btn btn-primary inline-flex min-h-11 items-center gap-1.5 !px-5 !py-2 text-[15px]"
              >
                <Download size={18} aria-hidden="true" />
                安裝
              </button>
            )}
            <button
              type="button"
              onClick={dismiss}
              className="btn btn-secondary inline-flex min-h-11 items-center !px-5 !py-2 text-[15px]"
            >
              暫時唔使
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="關閉安裝提示"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-txt-3 hover:bg-white/10"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
