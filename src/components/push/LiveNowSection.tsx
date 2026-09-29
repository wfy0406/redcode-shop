import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { isPushSupported } from '@/lib/pushClient';
import PushPermissionGuide from '@/components/push/PushPermissionGuide';

/**
 * 直播進行中展示區（v2.2.0，2026-09-30 老闆指令）
 *
 * trpc.push.currentLive（publicQuery，60 秒 refetch）——後端回最新一筆
 * status='sent' 且 sentAt 喺 90 分鐘內嘅直播推送；冇直播 → 成個 section 唔 render。
 *
 * 有直播時（深色 heritage 金線，§4 大方向）：
 * - 🔴 紅點 opacity 呼吸 pill「LIVE 直播進行中」
 * - serif 大標：日期＋場次
 * - embedUrl 有就 16:9 iframe 預覽（深色框、lazy；facebook.com→plugins/video.php 後端砌好）
 * - 「立即入直播」金 accent 掣（target _blank 開 url；手機有 FB app 系統會自動開 app）
 * - 未訂閱者「通知我開播」副掣（未登入→/login；登入未訂閱→PushPermissionGuide）
 */
export default function LiveNowSection() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [showGuide, setShowGuide] = useState(false);

  const liveQuery = trpc.push.currentLive.useQuery(undefined, {
    refetchInterval: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // 已登入先查訂閱狀態（決定顯唔顯示「通知我開播」副掣）
  const statusQuery = trpc.push.myPushStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const live = liveQuery.data?.live ?? null;
  if (!live) return null;

  const subscribed = !!statusQuery.data?.optIn && (statusQuery.data?.activeDevices ?? 0) > 0;

  const handleNotifyMe = () => {
    if (!user) {
      navigate('/login');
      return;
    }
    setShowGuide(true);
  };

  return (
    <section
      className="mx-auto max-w-[1280px] px-5 pt-10 md:px-8 md:pt-14 xl:px-12"
      aria-label="直播進行中"
    >
      <div
        className="border px-6 py-10 md:px-12 md:py-14"
        style={{
          borderColor: 'rgba(245, 197, 24, 0.35)',
          background:
            'linear-gradient(180deg, var(--space-2) 0%, var(--space-1) 100%)',
        }}
      >
        <div className="grid items-center gap-8 lg:grid-cols-2">
          {/* 左：LIVE pill＋serif 大標＋CTA */}
          <div>
            <p
              className="inline-flex items-center gap-2 rounded-full border px-4 py-1.5 font-mono text-[12px] font-medium tracking-[0.25em]"
              style={{ borderColor: 'rgba(255, 0, 84, 0.5)', color: 'var(--pink-tint)' }}
              aria-live="off"
            >
              {/* 🔴 紅點 opacity 呼吸（淨 opacity，合鐵律） */}
              <span
                className="push-live-dot inline-block h-2 w-2 rounded-full"
                style={{ background: 'var(--pink)' }}
                aria-hidden="true"
              />
              LIVE 直播進行中
            </p>
            <h2 className="mt-5 font-serif-tc text-3xl font-bold leading-[1.25] text-starlight md:text-[40px]">
              Glo Glo 開咗台啦！
            </h2>
            <p className="mt-3 font-serif-tc text-lg leading-[1.5] text-gold-soft md:text-xl">
              {live.liveDate}・{live.liveSession}
            </p>
            <p className="mt-4 max-w-md text-[14px] leading-[1.8] text-txt-2">
              即場著身、即場開賣、留言落單。快閃價手快有手慢冇，快啲入嚟一齊睇！
            </p>

            <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-center">
              <a
                href={live.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-2 rounded-full px-7 py-3 font-serif-tc text-base font-semibold transition-opacity hover:opacity-80"
                style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
              >
                立即入直播
                <ExternalLink size={16} aria-hidden="true" />
              </a>
              {/* 副掣：已訂閱顯示狀態；未訂閱「通知我開播」；未登入一樣顯示（撳咗去登入） */}
              {subscribed ? (
                <span className="inline-flex w-fit items-center gap-2 text-[14px] text-txt-3">
                  已開啟開播通知 ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleNotifyMe}
                  className="inline-flex w-fit items-center gap-2 border-b pb-1 text-[14px] font-medium text-gold-soft transition-opacity hover:opacity-70"
                  style={{ borderColor: 'var(--gold)' }}
                >
                  🔔 通知我開播
                </button>
              )}
            </div>

            {!isPushSupported() && !subscribed && (
              <p className="mt-3 max-w-md text-[12px] leading-[1.7] text-txt-3">
                iPhone 用戶：請先喺 Safari 將 RedCode「加至主畫面」，先收得到開播通知。
              </p>
            )}
          </div>

          {/* 右：FB 直播 embed 預覽（冇 embedUrl 就唔顯示，CTA 卡已經夠搶眼） */}
          {live.embedUrl && (
            <div
              className="overflow-hidden rounded-2xl border"
              style={{ borderColor: 'var(--glass-border)', background: 'var(--space-1)' }}
            >
              <div className="relative aspect-video">
                <iframe
                  src={live.embedUrl}
                  title="Facebook 直播預覽"
                  loading="lazy"
                  allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                  allowFullScreen
                  className="absolute inset-0 h-full w-full border-0"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 權限講解 modal（訂閱成功會 invalidate 狀態，副掣即轉「已開啟 ✓」） */}
      <PushPermissionGuide
        open={showGuide}
        onClose={(ok) => {
          setShowGuide(false);
          if (ok) {
            void utils.push.myPushStatus.invalidate();
            void utils.auth.me.invalidate();
          }
        }}
      />

      {/* 🔴 呼吸：淨 opacity（老闆鐵律）；reduced-motion 停動畫 */}
      <style>{`
        .push-live-dot {
          animation: push-live-breathe 1.6s ease-in-out infinite;
        }
        @keyframes push-live-breathe {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.25; }
        }
        @media (prefers-reduced-motion: reduce) {
          .push-live-dot { animation: none; opacity: 1; }
        }
      `}</style>
    </section>
  );
}
