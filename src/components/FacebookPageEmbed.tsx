import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { loadFacebookSdk } from '@/lib/facebookSdk';

/**
 * Facebook Page Plugin 嵌入（R-B §4.2 + §4.3）
 *
 * - SDK 版 + FB.XFBML.parse(container)：HashRouter SPA route change 後一定要手動 re-parse
 * - re-parse 前清走 SDK 上次留低嘅 state（fb-xfbml-state attr + innerHTML + fb_iframe_widget class），
 *   否則 SDK 會 skip 唔重新 render（SPA 最常見留白陷阱）
 * - 容器 max-width 500px 置中（plugin 硬上限 180–500px，闊過就會兩邊留白）；
 *   深色 loading 底（--space-2）防「白格」、min-height 300px 防 CLS、
 *   rounded-2xl + overflow hidden 配現有玻璃卡風格
 * - error（多數 ad blocker）→ fallback「直接前往 Facebook 專頁」連結
 * - perf-fix（P1-6）：FB SDK＋page plugin 係出名重——改做 IntersectionObserver
 *   入 viewport（提前 400px）先 load SDK；唔好用「撳先載入」facade，保持無縫。
 *   未入 viewport 前容器維持深色 loading 底＋min-height，唔會 CLS。
 */

interface FacebookPageEmbedProps {
  /** 專頁 URL，預設 Red Code HK直播台 */
  pageUrl?: string;
  /** timeline 高度 px，建議 500–700 */
  height?: number;
  /** 額外容器 className */
  className?: string;
}

export default function FacebookPageEmbed({
  pageUrl = 'https://www.facebook.com/redcodexhk',
  height = 600,
  className = '',
}: FacebookPageEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const location = useLocation(); // HashRouter 都會觸發
  // 入 viewport（提前 400px）先 load FB SDK——首屏唔使即刻食數百 KB 第三方 JS；
  // 舊瀏覽器冇 IntersectionObserver → lazy init 開局即當入埋 viewport（唔喺 effect 同步 setState）
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (near) return;
    const el = containerRef.current;
    // 外層 div 必定已 render（effect 跑嗰陣 ref 已綁定），唔使兜底；淨係 IO callback 先 setNear
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return; // 未入 viewport：乜都唔做（SDK 未 load）
    let cancelled = false;
    setStatus('loading');

    loadFacebookSdk()
      .then((FB) => {
        if (cancelled || !containerRef.current) return;
        const el = containerRef.current.querySelector('.fb-page');
        if (el) {
          // 【關鍵】SPA re-mount / route change 後 re-parse 前，
          // 要清走 SDK 上次渲染留低嘅 state，否則佢會 skip 唔重新 render
          el.removeAttribute('fb-xfbml-state');
          el.innerHTML = '';
          el.classList.remove('fb_iframe_widget', 'fb_iframe_widget_fluid');
        }
        FB.XFBML.parse(containerRef.current); // 只 parse 呢個容器，唔好成個 document
        if (!cancelled) setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [near, location.pathname, pageUrl, height]); // route change 後重新 parse

  return (
    <div
      ref={containerRef}
      className={`relative mx-auto w-full overflow-hidden rounded-2xl border ${className}`}
      style={{
        maxWidth: '500px', // plugin 永遠唔會闊過 500：夾住佢 + 置中，兩側唔留白
        minHeight: '300px', // 預留高度防 CLS
        background: 'var(--space-2)', // 深色 loading 底，未 load 完唔會有一格突兀白色
        borderColor: 'var(--glass-border)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div
        className="fb-page"
        data-href={pageUrl}
        data-tabs="timeline"
        data-width="500" // 上限 500；配合 adapt 會自動縮到容器闊
        data-height={String(height)}
        data-small-header="true" // 手機慳位
        data-adapt-container-width="true"
        data-hide-cover="true" // 手機比例好啲
        data-show-facepile="false"
        data-lazy="true"
      />
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-txt-3">
          載入 Facebook 專頁中…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm leading-[1.75] text-txt-2">
          未能載入 Facebook 內容（可能被廣告攔截器阻擋）。
          <a
            href={pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 border-b font-medium text-pink-soft transition-colors hover:text-pink-tint"
            style={{ borderColor: 'var(--pink)' }}
          >
            直接前往 Facebook 專頁
          </a>
        </div>
      )}
      <style>{`
        .fb-page, .fb-page iframe, .fb-page span {
          border: none !important;
          display: block;
        }
      `}</style>
    </div>
  );
}
