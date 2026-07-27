/**
 * Facebook SDK load-once loader（R-B §4.1）
 *
 * - 全 app 共用一個 promise：重複呼叫唔會重複插 script
 * - zh_HK locale、v21.0、xfbml=1（唔使 appId 都可以 render Page Plugin）
 * - fb-root 只插一次；script onerror → reject（多數係 ad blocker 擋咗 connect.facebook.net）
 */

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdkPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadFacebookSdk(locale = 'zh_HK'): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    // fb-root 只需要一個，放 body 底下
    if (!document.getElementById('fb-root')) {
      const root = document.createElement('div');
      root.id = 'fb-root';
      document.body.prepend(root);
    }
    if (document.getElementById('facebook-jssdk')) {
      // script 已存在但 FB 未 ready：等 fbAsyncInit
      const prev = window.fbAsyncInit;
      window.fbAsyncInit = () => {
        prev?.();
        resolve(window.FB);
      };
      return;
    }
    window.fbAsyncInit = () => resolve(window.FB);
    const js = document.createElement('script');
    js.id = 'facebook-jssdk';
    js.async = true;
    js.defer = true;
    js.crossOrigin = 'anonymous';
    // 唔使 appId 都可以 render Page Plugin；有 appId 就加 &appId=xxx
    js.src = `https://connect.facebook.net/${locale}/sdk.js#xfbml=1&version=v21.0`;
    js.onerror = () => {
      sdkPromise = null; // 容許之後重試
      reject(new Error('FB SDK load failed (ad blocker?)'));
    };
    document.body.appendChild(js);
  });
  return sdkPromise;
}
