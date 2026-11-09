import { useState } from 'react';
import { Link } from 'react-router';
import {
  BadgeCheck,
  Bell,
  Copy,
  Facebook,
  Share2,
  Sparkles,
} from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import PushPermissionGuide from '@/components/push/PushPermissionGuide';

const FACEBOOK_URL = 'https://www.facebook.com/redcodexhk';

/** Facebook sharer 要用完整公開 URL；呢個 helper 畀頁面同測試共用，避免寫錯編碼。 */
export function buildFacebookShareUrl(shareUrl: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
}

/** 複製公開連結（clipboard API 失敗 → textarea fallback；再失敗回 false 畀 UI 提示） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------- 直播開播通知 CTA（重用首頁 LivePushEntry 邏輯：未登入→/login；已訂閱→狀態 pill；否則開 PushPermissionGuide） ---------- */
function LiveAlertCta() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [showGuide, setShowGuide] = useState(false);
  const statusQuery = trpc.push.myPushStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const subscribed = !!statusQuery.data?.optIn && (statusQuery.data?.activeDevices ?? 0) > 0;

  if (!user) {
    return (
      <Link to="/login" className="lr-cta lr-cta-gold">
        <Bell size={15} aria-hidden="true" className="shrink-0" />
        <span className="lr-cta-label">
          <span className="lr-cta-micro">LIVE ALERT</span>
          <span className="lr-cta-title">接收直播開播通知</span>
        </span>
      </Link>
    );
  }
  if (subscribed) {
    return (
      <span role="status" className="lr-cta lr-cta-status">
        <span aria-hidden="true" className="lr-status-dot" />
        <BadgeCheck size={15} aria-hidden="true" className="shrink-0 text-gold" />
        <span className="lr-cta-label">
          <span className="lr-cta-micro">LIVE ALERT ON</span>
          <span className="lr-cta-title">已開啟通知</span>
        </span>
      </span>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setShowGuide(true)} className="lr-cta lr-cta-gold">
        <Bell size={15} aria-hidden="true" className="shrink-0" />
        <span className="lr-cta-label">
          <span className="lr-cta-micro">LIVE ALERT</span>
          <span className="lr-cta-title">接收直播開播通知</span>
        </span>
      </button>
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
    </>
  );
}

/**
 * 中獎公告／查劵頁共用引流 CTA。
 * shareUrl 必須係「而家呢頁」嘅完整公開 link：公告頁傳公告 URL，查劵頁傳查劵 URL。
 */
export function LuckyPublicActions({
  shareUrl,
  copyLabel,
}: {
  shareUrl: string;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const fbShareUrl = buildFacebookShareUrl(shareUrl);

  const onCopy = async () => {
    const ok = await copyText(shareUrl);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <p className="text-center font-mono text-[11px] uppercase tracking-[0.25em] text-txt-3">
        下一個中獎嘅可能係你
      </p>
      <div className="mt-4 flex flex-wrap items-stretch justify-center gap-3">
        <LiveAlertCta />
        <Link to="/try-on" className="lr-cta lr-cta-pink">
          <Sparkles size={15} aria-hidden="true" className="shrink-0" />
          <span className="lr-cta-label">
            <span className="lr-cta-micro">AI TRY-ON</span>
            <span className="lr-cta-title">AI 試穿新衫</span>
          </span>
        </Link>
        <a href={FACEBOOK_URL} target="_blank" rel="noopener noreferrer" className="lr-cta lr-cta-gold">
          <Facebook size={15} aria-hidden="true" className="shrink-0" />
          <span className="lr-cta-label">
            <span className="lr-cta-micro">FOLLOW US</span>
            <span className="lr-cta-title">追蹤 Facebook 專頁</span>
          </span>
        </a>
      </div>
      {/* 分享行：真 Facebook share URL＋複製目前公開連結 */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
        <a
          href={fbShareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="lr-cta lr-cta-share"
        >
          <Share2 size={14} aria-hidden="true" className="shrink-0" />
          分享去 Facebook
        </a>
        <button type="button" onClick={() => void onCopy()} className="lr-cta lr-cta-share">
          <Copy size={14} aria-hidden="true" className="shrink-0" />
          {copied ? '已複製連結 ✓' : copyLabel}
        </button>
      </div>
      {copyFailed && (
        <p className="mt-2 text-center text-[12px] text-pink-soft" role="alert">
          複製唔到——請長按網址列手動複製。
        </p>
      )}
      <LuckyPublicActionsStyles />
    </>
  );
}

/** 共用 CTA scoped 樣式（沿用公告頁原本 lr-cta 外觀及文案密度） */
function LuckyPublicActionsStyles() {
  return (
    <style>{`
      /* CTA：創意規矩——深色實心底＋金色描邊（唔用透明 ghost）；
         hover 淨 transform；雙行標籤（拉丁 micro＋中文主標） */
      .lr-cta {
        position: relative;
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        border-radius: 9999px;
        padding: 12px 22px;
        font-size: 13px; font-weight: 600;
        text-decoration: none; cursor: pointer;
        transform: translateZ(0);
        transition: transform 200ms ease-out;
        min-height: 44px;
      }
      .lr-cta:hover { transform: translateY(-1px) translateZ(0); }
      .lr-cta:active { transform: translateY(0) translateZ(0); }
      .lr-cta-gold {
        border: 1px solid var(--gold);
        background: var(--space-1);
        color: var(--gold-soft);
      }
      .lr-cta-pink {
        background: var(--pink);
        color: var(--space-1);
        font-weight: 800;
        letter-spacing: 0.03em;
      }
      .lr-cta-share {
        border: 1px solid var(--glass-border);
        background: var(--space-1);
        color: var(--text-1);
        font-size: 12.5px;
        padding: 10px 18px;
      }
      .lr-cta-status {
        border: 1px solid var(--space-line);
        background: rgba(255,143,191,0.06);
        color: var(--text-1);
        cursor: default;
      }
      .lr-cta-label { display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
      .lr-cta-micro {
        font-family: var(--font-mono);
        font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; line-height: 1.2;
        color: var(--gold);
      }
      .lr-cta-pink .lr-cta-micro { color: rgba(10,6,20,0.62); }
      .lr-cta-title { line-height: 1.35; }
      .lr-status-dot {
        width: 8px; height: 8px; border-radius: 9999px; background: var(--pink);
        animation: lr-breathe 2.4s ease-in-out infinite alternate;
      }
      @keyframes lr-breathe {
        from { transform: scale(1); opacity: 1; }
        to { transform: scale(1.35); opacity: 0.45; }
      }

      @media (prefers-reduced-motion: reduce) {
        .lr-status-dot { animation: none; }
        .lr-cta { transition: none; }
        .lr-cta:hover, .lr-cta:active { transform: translateZ(0); }
      }
    `}</style>
  );
}
