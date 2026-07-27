import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/providers/trpc';

/**
 * Google「以 Google 登入」掣（Google Identity Services 官方 renderButton）
 *
 * - client ID 唔係 build-time 燒死：經 trpc.auth.googleConfig runtime 攞
 *   （Render Docker build 冇 dashboard env，VITE_* 會缺）
 * - env 未設 GOOGLE_CLIENT_ID → 乜都唔 render（靜默隱藏，唔影響電話登入）
 * - 深色主題：theme=filled_black + pill，配合玻璃卡
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (cfg: {
            client_id: string;
            callback: (resp: { credential?: string }) => void;
            locale?: string;
          }) => void;
          renderButton: (
            el: HTMLElement,
            opts: {
              theme?: string;
              size?: string;
              shape?: string;
              text?: string;
              width?: number;
              logo_alignment?: string;
            },
          ) => void;
        };
      };
    };
  }
}

let gsiLoading: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (gsiLoading) return gsiLoading;
  gsiLoading = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiLoading = null; // 容許重試
      reject(new Error('GSI load failed'));
    };
    document.head.appendChild(script);
  });
  return gsiLoading;
}

interface Props {
  onCredential: (idToken: string) => void;
  onError?: (message: string) => void;
}

export default function GoogleLoginButton({ onCredential, onError }: Props) {
  const configQuery = trpc.auth.googleConfig.useQuery(undefined, {
    staleTime: 300_000,
    retry: false,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const clientId = configQuery.data?.clientId ?? null;

  // onCredential 每次 render 都新，用 ref 固定畀 GIS callback 用
  const cbRef = useRef(onCredential);
  cbRef.current = onCredential;

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp) => {
            if (resp.credential) cbRef.current(resp.credential);
          },
          locale: 'zh_HK',
        });
        containerRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(containerRef.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
          logo_alignment: 'center',
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) onError?.('Google 登入組件載入失敗，請用電話登入');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  if (!clientId) return null;

  return (
    <div className="flex min-h-[44px] items-center justify-center">
      {!ready && <span className="text-[13px] text-txt-3">Google 登入載入中…</span>}
      <div ref={containerRef} className="flex justify-center" />
    </div>
  );
}
