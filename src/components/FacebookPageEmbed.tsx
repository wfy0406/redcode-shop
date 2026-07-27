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

  useEffect(() => {
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
  }, [location.pathname, pageUrl, height]); // route change 後重新 parse

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
