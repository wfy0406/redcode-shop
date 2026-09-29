/**
 * 直播開播推送前端助手（v2.2.0，2026-09-30 老闆指令）
 *
 * Web Push 全流程（service worker + VAPID，唔經第三方）：
 * - isPushSupported()：瀏覽器支唔支援（serviceWorker + PushManager）
 * - ensureSw()：註冊 /sw.js 攞 registration
 * - subscribeLivePush()：PushPermissionGuide 確認後先叫 Notification.requestPermission()；
 *   granted → pushManager.subscribe（applicationServerKey = urlBase64ToUint8Array(vapidKey)）
 *   → trpc push.subscribe 落後端
 * - unsubscribeLivePush()：本機 sw unsubscribe ＋ trpc push.unsubscribe
 *   （傳 endpoint 撤單一裝置；唔傳＝全撤，後端會順手關 optIn）
 *
 * 全部 never-throw：失敗回 { ok: false, message }，message 係繁中可以直接顯示。
 * 注意：呢度用獨立 vanilla tRPC client（唔係 React hook），等 guide modal 嘅
 * onClick async flow 都叫到 API；設定同 src/providers/trpc.tsx 一致。
 */

import { createTRPCClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../../api/router';
import { getToken } from '@/lib/auth';

export type PushResult = { ok: true } | { ok: false; message: string };

/** 同 providers/trpc.tsx 一樣嘅連線設定（batch link＋superjson＋Bearer token） */
const api = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      transformer: superjson,
      headers() {
        const token = getToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: 'include',
        });
      },
    }),
  ],
});

/** 瀏覽器支唔支援 Web Push（iPhone 要 iOS 16.4+ 兼「加至主畫面」先會 true） */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** 註冊 /sw.js 並等佢 ready；失敗 throw（由 caller 包返做繁中訊息） */
export async function ensureSw(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  // 等 service worker 進入 active 狀態，先至保證 pushManager.subscribe 用得
  await navigator.serviceWorker.ready;
  return reg;
}

/** VAPID public key（base64url）→ Uint8Array，pushManager.subscribe 嘅 applicationServerKey 用 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** ArrayBuffer → base64url 字串（subscription keys p256dh／auth 上報後端用） */
function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function errMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

/**
 * 訂閱直播開播推送（綁定呢部裝置）。
 * ⚠ 一定要喺用戶 gesture（撳掣）嘅 call stack 入面叫，
 *   因為入面會觸發 Notification.requestPermission() 瀏覽器彈窗。
 * PushPermissionGuide 講解完、用戶撳「允許通知」先會行到呢度。
 */
export async function subscribeLivePush(): Promise<PushResult> {
  if (!isPushSupported()) {
    return {
      ok: false,
      message:
        '你嘅瀏覽器暫時唔支援推送通知。iPhone 請先用 Safari 將 RedCode「加至主畫面」，再喺主畫面圖示開返網站綁定。',
    };
  }

  try {
    // 第一步：瀏覽器通知權限（一定要喺用戶 gesture 內觸發）
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        ok: false,
        message:
          permission === 'denied'
            ? '通知權限俾瀏覽器擋咗。請跟返頁面上嘅步驟，喺瀏覽器設定開返通知，之後再試一次。'
            : '你未允許通知權限，今次綁定唔到。可以稍後喺會員中心開返。',
      };
    }

    // 第二步：註冊 service worker
    const reg = await ensureSw();

    // 第三步：攞 VAPID public key，向瀏覽器推送服務訂閱
    const { key } = await api.push.getVapidKey.query();
    if (!key) {
      return { ok: false, message: '推送服務未設定好，請稍後再試。' };
    }
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    });

    // 第四步：將 endpoint＋加密 keys 上報後端（後端 upsert＋記 optIn）
    await api.push.subscribe.mutate({
      endpoint: subscription.endpoint,
      p256dh: arrayBufferToBase64Url(subscription.getKey('p256dh')),
      auth: arrayBufferToBase64Url(subscription.getKey('auth')),
      userAgent: navigator.userAgent.slice(0, 255),
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: errMessage(err, '綁定失敗，請稍後再試；可以喺會員中心隨時再綁定。'),
    };
  }
}

/**
 * 取消直播開播推送。
 * - all = true（會員中心「取消綁定・拒絕接收」）：後端全撤所有裝置＋關 optIn；
 *   本機 service worker 嘅 subscription 都一併 unsubscribe
 * - all = false：只撤呢部裝置（上報本機 endpoint）
 * 本機 unsubscribe 失敗唔阻塞後端全撤（裝置可能換過瀏覽器，本機根本冇 subscription）。
 */
export async function unsubscribeLivePush(opts?: { all?: boolean }): Promise<PushResult> {
  if (!isPushSupported()) {
    // 唔支援嘅瀏覽器冇本機 subscription，但都照樣叫後端撤（全撤場景）
    if (!opts?.all) {
      return { ok: false, message: '你嘅瀏覽器唔支援推送通知，呢部裝置本來就冇綁定。' };
    }
  }

  // 本機撤銷（best effort，唔好因為本機失敗而唔撤後端）
  let endpoint: string | undefined;
  if (isPushSupported()) {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = await reg?.pushManager.getSubscription();
      endpoint = subscription?.endpoint;
      await subscription?.unsubscribe();
    } catch {
      // 本機撤銷失敗（例如權限已俾用戶喺瀏覽器設定撤咗）——繼續落後端撤
    }
  }

  try {
    await api.push.unsubscribe.mutate(opts?.all ? {} : { endpoint });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: errMessage(err, '取消失敗，請稍後再試。'),
    };
  }
}
