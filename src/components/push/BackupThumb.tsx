import { useEffect, useRef, useState } from 'react';

/**
 * 後備「會郁」縮圖（v2.2.30 老闆指令：哈利波特式會郁嘅相，
 * 「live 後備隨機選」「重溫後備隨機選但同屏唔准重複」）
 *
 * FB 摷唔到真縮圖（封 IP／直播中冇 og:image）時，跌落呢度：
 * 45 條 AI 生成 mp4（9 條直播 9:16＋36 條回顧 3:4，Glo Glo 樣貌參考生成，
 * 唔同場景／動作／衣著）＋同名 jpg 海報，全部係自家 public/live-backup/
 * 靜態檔——唔受 FB 封 IP 影響，永遠出到。
 * （v2.2.31 老闆指令：live-07＋replay-15/17/29/36 抽出咗做首頁浮卡同
 * 關於我們動態相，後備池刪除兼重新編號：live 1–9、replay 1–36）
 *
 * 設計守鐵律：
 * - 自家 mp4 靜音＋playsInline 循環 autoplay——手機瀏覽器准（唔似 FB embed 要手勢）
 * - 入 viewport 先 mount <video>（IntersectionObserver，rootMargin 240px），
 *   唔好整慢客人電話；prefers-reduced-motion → 淨顯示 jpg 海報
 * - RedCode logo 係 HTML overlay（透明底 PNG），jpg／mp4 原檔保持乾淨，
 *   日後換 logo 淨係換一個檔
 */
export const LIVE_BACKUP_COUNT = 9;
export const REPLAY_BACKUP_COUNT = 36;

/** 直播後備：隨機揀一條（1–9） */
export function pickLiveBackup(): number {
  return 1 + Math.floor(Math.random() * LIVE_BACKUP_COUNT);
}

/** 回顧後備：洗牌 1–36 拎頭 n 張——同屏保證唔重複（老闆指令：最多 10 條唔可以撞圖） */
export function dealReplayBackups(n: number): number[] {
  const pool = Array.from({ length: REPLAY_BACKUP_COUNT }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(n, REPLAY_BACKUP_COUNT)));
}

const pad = (n: number) => String(n).padStart(2, '0');

export default function BackupThumb({
  kind,
  index,
  logoPos = 'br',
}: {
  kind: 'live' | 'replay';
  index: number;
  /** logo 擺位：tr＝右上（直播海報，左上有 LIVE pill）／br＝右下（回顧卡） */
  logoPos?: 'tr' | 'br';
}) {
  const base = `/live-backup/${kind}-${pad(index)}`;
  // reduced-motion 客：淨 jpg 海報，唔播片
  const [reduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0" aria-hidden="true">
      {/* jpg 海報即刻出（細、 progressive）；video 就位後蓋過佢 */}
      <img src={`${base}.jpg`} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      {near && !reduced && (
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src={`${base}.mp4`}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      )}
      <img
        src="/live-backup/redcode-logo.png"
        alt=""
        className={`absolute w-[40%] max-w-[148px] opacity-95 drop-shadow-[0_1px_6px_rgba(0,0,0,0.55)] ${
          logoPos === 'tr' ? 'right-2.5 top-2.5' : 'bottom-2.5 right-2.5'
        }`}
      />
    </div>
  );
}
