/// <reference types="vite/client" />
import { Link, useSearchParams } from 'react-router';
import { trpc } from '@/providers/trpc';

/**
 * v2.2.0 公開會員驗證頁（/vip-verify?c=RC-000128&s=hex）
 * 客人用第二部手機掃證書 QR 之後見到嘅門面 —— 英倫 heritage 奢侈感：
 * 深 espresso 底 #17100b、奶油字 #f5ead6、金 accent #c9a35f、次級 #fce1b6。
 *
 * 狀態機：
 * ─ 連結不完整（c/s 唔齊）→ 無效態
 * ─ 載入中 → 盾徽 opacity 呼吸（低調奢華，唔用預設 spinner）
 * ─ ok:true + valid → 「有效會員」金框證書卡（金=香檳金、銀=鉑金銀，金級加 ✦）
 * ─ ok:true + !valid → 同樣資料但灰階收斂＋「會員已到期」
 * ─ ok:false / 網絡錯 → 「無法驗證此證書」＋reason，灰階
 *
 * 鐵律：動畫淨 opacity/transform；證書卡零圓角；中文唔准 italic；
 * 金額 integer cents ÷100 顯示；日期 DD/MM/YYYY。
 */

/* ===== 合約色（CONTRACTS-v2.2.0 §4，唔准自己創色） ===== */
const ESPRESSO = '#17100b';
const CREAM = '#f5ead6';
const GOLD = '#c9a35f';
const CHAMPAGNE = '#fce1b6';
/* 銀級鉑金銀：取自 src/lib/vipTheme.ts SILVER_THEME（accent / wash 亮色） */
const PLATINUM = '#7e8794';
const PLATINUM_LIGHT = '#e8ebef';

const CREST_IMG = '/vip/verify-crest.png';
const GLORIA_SIGN_IMG = '/email/gloria-sign.png';

/* ===== 後端回應型別（vip.verifyVipCert 合約） ===== */
type VerifyOk = {
  ok: true;
  name: string;
  memberNo: string;
  tier: 'SILVER' | 'GOLD';
  effectiveAt: string;
  expiresAt: string;
  valid: boolean;
  /* v2.2.0 門檻凍結：升級嗰刻嘅門檻快照（後端保證回；冇就先落返 by-tier 舊欄） */
  thresholdCents?: number;
  silverThresholdCents: number;
  goldThresholdCents: number;
  durationMonths: number;
};

/* ===== BrowserRouter query 解析：URL 係 /vip-verify?c=…&s=…，
   舊 hash 連結（/#/vip-verify?c=…&s=…）由 main.tsx 開機收容 replaceState 去正式路徑，
   所以呢度同 Payment/Checkout 一樣用 useSearchParams 讀 location.search ===== */
function useVerifyQuery(): { c: string; s: string } {
  const [searchParams] = useSearchParams();
  return {
    c: (searchParams.get('c') ?? '').trim(),
    s: (searchParams.get('s') ?? '').trim(),
  };
}

/* ===== 顯示格式 helper ===== */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** cents ÷100 → HK$ 千分位（HK$3,000） */
function formatHKD(cents: number): string {
  return `HK$${Math.round(cents / 100).toLocaleString('en-HK')}`;
}

/* ---------- 頂部盾徽＋旋轉文字環（12s linear infinite，淨 transform rotate） ---------- */
function CrestSeal({ breathing, dimmed }: { breathing?: boolean; dimmed?: boolean }) {
  return (
    <div className="relative mx-auto h-48 w-48 md:h-56 md:w-56" aria-hidden="true">
      {/* 旋轉文字環（圓環文字 12s 勻速無限旋轉） */}
      <svg viewBox="0 0 100 100" className="vv-ring h-full w-full" style={dimmed ? { opacity: 0.45 } : undefined}>
        <defs>
          <path
            id="vv-ring-path"
            d="M50,50 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"
            fill="none"
          />
        </defs>
        <text
          fill={GOLD}
          style={{
            fontFamily: "'Cormorant Garamond', 'Noto Serif TC', serif",
            fontSize: '6.2px',
            letterSpacing: '1.7px',
          }}
        >
          <textPath href="#vv-ring-path" textLength="272" lengthAdjust="spacingAndGlyphs">
            REDCODE · OFFICIAL MEMBERSHIP VERIFICATION ·
          </textPath>
        </text>
      </svg>
      {/* 盾徽（載入態用 opacity 呼吸代替 spinner） */}
      <img
        src={CREST_IMG}
        alt=""
        className={`absolute inset-0 m-auto h-28 w-28 object-contain md:h-32 md:w-32 ${breathing ? 'vv-breathe' : ''}`}
        style={{
          filter: dimmed
            ? 'grayscale(1) drop-shadow(0 10px 28px rgba(0, 0, 0, 0.5))'
            : 'drop-shadow(0 10px 28px rgba(201, 163, 95, 0.35))',
          opacity: dimmed ? 0.55 : undefined,
        }}
      />
    </div>
  );
}

/* ---------- 資料行（label／value＋hairline 分隔） ---------- */
function CertRow({
  label,
  children,
  dimmed,
  last,
}: {
  label: string;
  children: React.ReactNode;
  dimmed?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-4 py-3"
      style={last ? undefined : { borderBottom: `1px solid ${dimmed ? 'rgba(245, 234, 214, 0.10)' : 'rgba(201, 163, 95, 0.22)'}` }}
    >
      <span
        className="font-serif-tc shrink-0 text-[13px] tracking-[0.2em]"
        style={{ color: dimmed ? 'rgba(245, 234, 214, 0.42)' : 'rgba(252, 225, 182, 0.62)' }}
      >
        {label}
      </span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/* ---------- 證書卡（有效＝金屬框；到期＝同款灰階收斂；零圓角） ---------- */
function CertCard({ data }: { data: VerifyOk }) {
  const isGold = data.tier === 'GOLD';
  const dimmed = !data.valid;
  /* 金＝香檳金漸變框；銀＝鉑金銀漸變框（全部合約色） */
  const frame = isGold
    ? `linear-gradient(135deg, ${CHAMPAGNE} 0%, ${GOLD} 34%, ${CHAMPAGNE} 52%, ${GOLD} 76%, ${CHAMPAGNE} 100%)`
    : `linear-gradient(135deg, ${PLATINUM_LIGHT} 0%, ${PLATINUM} 34%, ${PLATINUM_LIGHT} 52%, ${PLATINUM} 76%, ${PLATINUM_LIGHT} 100%)`;
  const accent = isGold ? GOLD : PLATINUM;
  const accentBright = isGold ? CHAMPAGNE : PLATINUM_LIGHT;
  /* 成就行門檻用升級嗰刻嘅快照（thresholdCents）；舊後端冇回就先落返 by-tier 舊欄 */
  const thresholdCents =
    data.thresholdCents ?? (isGold ? data.goldThresholdCents : data.silverThresholdCents);

  return (
    <div className="vv-enter" style={dimmed ? { filter: 'grayscale(1)', opacity: 0.78 } : undefined}>
      {/* 狀態標題 */}
      <p
        className="text-center font-serif-tc text-xl font-semibold tracking-[0.28em] md:text-2xl"
        style={{ color: dimmed ? 'rgba(245, 234, 214, 0.72)' : accentBright }}
      >
        {dimmed ? '會員已到期' : '有效會員'}
      </p>
      <p
        className="mt-2 text-center font-display-en text-[11px] uppercase tracking-[0.3em]"
        style={{ color: dimmed ? 'rgba(245, 234, 214, 0.38)' : 'rgba(252, 225, 182, 0.55)' }}
      >
        {dimmed ? 'Membership Expired' : 'Verified Member'}
      </p>

      {/* 金屬框（1.5px 漸變框＋espresso 內底；證書零圓角） */}
      <div
        className="mt-7 p-[1.5px]"
        style={{
          background: frame,
          boxShadow: dimmed
            ? '0 18px 48px rgba(0, 0, 0, 0.45)'
            : isGold
              ? '0 24px 64px rgba(201, 163, 95, 0.22), 0 8px 24px rgba(0, 0, 0, 0.4)'
              : '0 18px 48px rgba(126, 135, 148, 0.20), 0 8px 24px rgba(0, 0, 0, 0.4)',
        }}
      >
        <div className="relative px-6 py-8 md:px-9 md:py-10" style={{ background: ESPRESSO }}>
          {/* 頂部金屬反光 hairline */}
          <div
            aria-hidden="true"
            className="absolute inset-x-8 top-0 h-px"
            style={{ background: `linear-gradient(90deg, transparent, ${dimmed ? 'rgba(245, 234, 214, 0.25)' : 'rgba(252, 225, 182, 0.4)'}, transparent)` }}
          />

          {/* 級別大字 */}
          <div className="text-center">
            <p
              className="font-display-en text-[10px] uppercase tracking-[0.3em]"
              style={{ color: dimmed ? 'rgba(245, 234, 214, 0.4)' : accent }}
            >
              {isGold ? 'Gold Membership' : 'Silver Membership'}
            </p>
            <h2
              className="mt-2 font-serif-tc text-[26px] font-bold tracking-[0.12em] md:text-3xl"
              style={{ color: dimmed ? 'rgba(245, 234, 214, 0.85)' : CREAM }}
            >
              {isGold ? '金會員' : '銀會員'}
              {isGold && (
                <span className="ml-2" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.6)' : GOLD }} aria-hidden="true">
                  ✦
                </span>
              )}
            </h2>
          </div>

          {/* 資料行 */}
          <div className="mt-7">
            <CertRow label="客戶姓名" dimmed={dimmed}>
              <span className="font-serif-tc text-lg font-semibold" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.85)' : CREAM }}>
                {data.name}
              </span>
            </CertRow>
            <CertRow label="會員編號" dimmed={dimmed}>
              <span className="font-mono text-base tracking-[0.12em]" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.8)' : accentBright }}>
                {data.memberNo}
              </span>
            </CertRow>
            <CertRow label="生效日期" dimmed={dimmed}>
              <span className="font-mono text-[15px]" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.8)' : CREAM }}>
                {formatDate(data.effectiveAt)}
              </span>
            </CertRow>
            <CertRow label="有效期至" dimmed={dimmed}>
              <span className="font-mono text-[15px]" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.8)' : CREAM }}>
                {formatDate(data.expiresAt)}
              </span>
            </CertRow>
            <CertRow label="會員期限" dimmed={dimmed} last>
              <span className="font-serif-tc text-[15px]" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.8)' : CREAM }}>
                {data.durationMonths} 個月
              </span>
            </CertRow>
          </div>

          {/* 消費門檻成就行（金 accent 強調） */}
          <p className="mt-7 text-center font-serif-tc text-[15px] leading-relaxed" style={{ color: dimmed ? 'rgba(245, 234, 214, 0.55)' : 'rgba(245, 234, 214, 0.82)' }}>
            憑 2026 年度消費滿{' '}
            <span
              className="font-mono text-lg font-medium tracking-[0.04em]"
              style={{ color: dimmed ? 'rgba(245, 234, 214, 0.75)' : accent }}
            >
              {formatHKD(thresholdCents)}
            </span>{' '}
            晉升
          </p>

          {dimmed && (
            <p className="mt-5 text-center font-serif-tc text-[13px] leading-relaxed" style={{ color: 'rgba(245, 234, 214, 0.45)' }}>
              此證書之會員資格已於 {formatDate(data.expiresAt)} 屆滿，
              最新級別以官網會員中心為準。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 無效態（ok:false／連結不完整／網絡錯）：灰階收斂 ---------- */
function InvalidCard({ reason }: { reason: string }) {
  return (
    <div className="vv-enter">
      <p
        className="text-center font-serif-tc text-xl font-semibold tracking-[0.28em] md:text-2xl"
        style={{ color: 'rgba(245, 234, 214, 0.72)' }}
      >
        無法驗證此證書
      </p>
      <p
        className="mt-2 text-center font-display-en text-[11px] uppercase tracking-[0.3em]"
        style={{ color: 'rgba(245, 234, 214, 0.38)' }}
      >
        Verification Failed
      </p>
      <div
        className="mt-7 px-6 py-8 text-center md:px-9"
        style={{
          border: '1px solid rgba(245, 234, 214, 0.16)',
          background: 'rgba(245, 234, 214, 0.03)',
        }}
      >
        <p className="font-serif-tc text-[15px] leading-[1.9]" style={{ color: 'rgba(245, 234, 214, 0.62)' }}>
          {reason}
        </p>
        <p className="mt-4 font-serif-tc text-[13px] leading-relaxed" style={{ color: 'rgba(245, 234, 214, 0.4)' }}>
          如有疑問，請透過官網右下角 WhatsApp 聯絡我哋核實。
        </p>
      </div>
    </div>
  );
}

/* ---------- 載入態：盾徽 opacity 呼吸（唔用預設 spinner） ---------- */
function LoadingState() {
  return (
    <div className="flex flex-col items-center">
      <CrestSeal breathing />
      <p
        className="mt-6 font-serif-tc text-sm tracking-[0.3em]"
        style={{ color: 'rgba(252, 225, 182, 0.6)' }}
      >
        正在驗證證書
      </p>
      <p
        className="mt-2 font-display-en text-[10px] uppercase tracking-[0.3em]"
        style={{ color: 'rgba(245, 234, 214, 0.3)' }}
      >
        Verifying Certificate
      </p>
    </div>
  );
}

export default function VipVerify() {
  const { c, s } = useVerifyQuery();
  const linkComplete = c.length > 0 && s.length > 0;

  const query = trpc.vip.verifyVipCert.useQuery(
    { c, s },
    {
      enabled: linkComplete,
      retry: false,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );

  /* 狀態判定 */
  let body: React.ReactNode;
  let crestDimmed = false;
  if (!linkComplete) {
    crestDimmed = true;
    body = <InvalidCard reason="連結不完整：缺少證書編號或驗證簽名。請掃描會員證書上嘅完整 QR Code。" />;
  } else if (query.isPending) {
    body = <LoadingState />;
  } else if (query.isError) {
    crestDimmed = true;
    body = <InvalidCard reason="暫時未能連接驗證服務，請稍後再掃一次。" />;
  } else if (!query.data.ok) {
    crestDimmed = true;
    body = <InvalidCard reason={query.data.reason || '此證書未能通過驗證。'} />;
  } else {
    crestDimmed = !query.data.valid;
    body = <CertCard data={query.data} />;
  }

  /* 載入中由 LoadingState 自帶呼吸盾徽；其他狀態（包括連結不完整）都顯示頂部盾徽 */
  const showCrest = !(linkComplete && query.isPending);

  return (
    <div
      className="relative -mt-px overflow-hidden"
      style={{ background: ESPRESSO, color: CREAM }}
    >
      {/* 頂部香檳金暈（低調奢華氛圍光） */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[52vh]"
        style={{ background: 'radial-gradient(ellipse 75% 55% at 50% 0%, rgba(201, 163, 95, 0.14) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 mx-auto w-full max-w-[560px] px-5 pb-20 pt-16 md:pt-20">
        {/* ===== 頁首：盾徽＋旋轉文字環 ===== */}
        {showCrest ? <CrestSeal dimmed={crestDimmed} /> : null}

        {/* ===== 英文大標（全大寫 letter-spacing 0.3em serif） ===== */}
        <header className="mt-8 text-center">
          <h1
            className="font-display-en text-lg font-semibold uppercase md:text-xl"
            style={{ letterSpacing: '0.3em', color: CREAM }}
          >
            Membership Verification
          </h1>
          <p
            className="mt-3 font-serif-tc text-sm tracking-[0.32em]"
            style={{ color: 'rgba(252, 225, 182, 0.68)' }}
          >
            RedCode 官方會員驗證
          </p>
          {/* hairline 金線 */}
          <div
            aria-hidden="true"
            className="mx-auto mt-6 h-px w-24"
            style={{ background: `linear-gradient(90deg, transparent, ${GOLD}, transparent)` }}
          />
        </header>

        {/* ===== 狀態內容 ===== */}
        <div className="mt-10">{body}</div>

        {/* ===== 頁尾：Gloria 簽名＋落款 ===== */}
        <footer className="mt-14 flex flex-col items-center">
          <div
            aria-hidden="true"
            className="mb-8 h-px w-40"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(201, 163, 95, 0.5), transparent)' }}
          />
          <img
            src={GLORIA_SIGN_IMG}
            alt="Gloria 親筆簽名"
            className="h-14 w-auto"
            style={{ filter: 'invert(0.88) sepia(0.55) saturate(1.4) brightness(1.05)', opacity: 0.92 }}
          />
          <p className="mt-2 font-serif-tc text-[13px] tracking-[0.2em]" style={{ color: 'rgba(245, 234, 214, 0.55)' }}>
            Gloria 上・RedCode 創辦人
          </p>

          {/* CTA 返官網（底線文字掣，唔係色塊） */}
          <Link
            to="/"
            className="mt-9 font-serif-tc text-[15px] tracking-[0.18em] transition-opacity hover:opacity-75"
            style={{
              color: CHAMPAGNE,
              textDecoration: 'none',
              borderBottom: `1px solid ${GOLD}`,
              paddingBottom: '4px',
            }}
          >
            返回 RedCode 官網
          </Link>
          <p
            className="mt-8 font-display-en text-[10px] uppercase"
            style={{ letterSpacing: '0.3em', color: 'rgba(245, 234, 214, 0.28)' }}
          >
            RedCode · Official Certificate Registry
          </p>
        </footer>
      </div>

      {/* 頁面專屬動效：全部淨 opacity/transform；reduced-motion 全停 */}
      <style>{`
        .vv-ring {
          animation: vv-ring-rotate 12s linear infinite;
        }
        @keyframes vv-ring-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .vv-breathe {
          animation: vv-breathe 2.6s ease-in-out infinite;
        }
        @keyframes vv-breathe {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .vv-enter {
          animation: vv-enter 700ms var(--ease-expo) both;
        }
        @keyframes vv-enter {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .vv-ring, .vv-breathe, .vv-enter { animation: none; opacity: 1; }
        }
      `}</style>
    </div>
  );
}
