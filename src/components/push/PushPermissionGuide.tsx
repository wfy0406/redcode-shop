import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, ExternalLink, X } from 'lucide-react';
import { subscribeLivePush } from '@/lib/pushClient';

/**
 * 直播開播通知權限講解 modal（v2.2.0，老闆特別要求：有啲客唔識設定）
 *
 * 流程：
 * 1. intro：講解「跟住瀏覽器會彈出通知權限，請撳『允許』」＋簡單示意（假通知卡）
 *    - iPhone/iPad 偵測（/iP(hone|ad|od)/）→ 額外提示要先喺 Safari「加至主畫面」
 * 2. 撳「允許通知」先真正觸發 Notification.requestPermission()（subscribeLivePush 入面）
 * 3. Notification.permission === 'denied'（之前拒絕過）→ 分 Chrome/Android、Safari/iOS
 *    圖文步驟教去瀏覽器設定開返，「我已開返，再試一次」重試
 * 4. 成功 → ✓ 畫面；失敗 → 友善訊息（可稍後會員中心開返），唔阻塞原本流程
 *
 * 用法：
 *   const [showGuide, setShowGuide] = useState(false);
 *   <PushPermissionGuide open={showGuide} onClose={(ok) => { setShowGuide(false); ... }} />
 */

type Step = 'iosSetup' | 'intro' | 'busy' | 'success' | 'denied' | 'error';

/** iPhone／iPad／iPod 偵測（iOS Web Push 要 PWA 加至主畫面先收到） */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

/** 係咪已經「加至主畫面」開緊（iOS PWA standalone 模式先有 Web Push） */
export function isInstalledPwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // 舊 iOS Safari 專用屬性
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** v2.2.16（老闆指令：教學要靚、要有圖）：iPhone「加至主畫面」三步圖文教學 */
const IOS_STEPS = [
  {
    n: 1,
    img: '/ios-guide/step1.png',
    alt: '步驟一示意圖：Safari 底欄嘅分享掣',
    text: '喺 Safari 底欄撳「分享」掣（方形加個向上箭嘴嗰個）',
  },
  {
    n: 2,
    img: '/ios-guide/step2.png',
    alt: '步驟二示意圖：分享選單入面嘅「加至主畫面」',
    text: '喺選單碌落搵「加至主畫面」，撳右上角「新增」',
  },
  {
    n: 3,
    img: '/ios-guide/step3.png',
    alt: '步驟三示意圖：主畫面嘅 RedCode 圖示',
    text: '喺主畫面撳 RedCode 圖示開返官網，再撳「通知我開播」',
  },
] as const;

/** 假通知示意卡（intro 步用，等客知道跟住會見到咩） */
function MockNotification() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none mx-auto w-full max-w-[300px] rounded-2xl border px-4 py-3 text-left"
      style={{
        background: 'var(--space-3)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex items-start gap-3">
        <img src="/logo.png" alt="" className="mt-0.5 h-8 w-8 rounded-lg object-cover" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-txt-1">🔴 RedCode 直播開始啦！</p>
          <p className="mt-0.5 text-[12px] leading-[1.5] text-txt-3">快啲入嚟睇啦！</p>
        </div>
      </div>
      {/* 模擬瀏覽器權限彈窗嘅「允許」掣位置提示 */}
      <div className="mt-2.5 flex justify-end gap-2 border-t pt-2" style={{ borderColor: 'var(--space-line)' }}>
        <span className="rounded-lg px-3 py-1 text-[12px] text-txt-3">唔准</span>
        <span
          className="rounded-lg px-3 py-1 text-[12px] font-semibold"
          style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
        >
          允許 ← 撳呢個
        </span>
      </div>
    </div>
  );
}

/** denied 狀態嘅圖文步驟（分 Chrome/Android 同 Safari/iOS） */
function DeniedSteps() {
  const apple = isAppleMobile();
  return (
    <div className="mt-5 space-y-4 text-left">
      {apple ? (
        <div
          className="rounded-xl border px-4 py-3.5"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
        >
          <p className="text-[14px] font-semibold text-txt-1">Safari／iPhone 開返通知步驟</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-[1.7] text-txt-2">
            <li>開 iPhone「設定」→ 搵「通知」</li>
            <li>喺列表搵到「RedCode」（主畫面圖示個 app）</li>
            <li>開啟「允許通知」</li>
            <li>返嚟撳下面「我已開返，再試一次」</li>
          </ol>
        </div>
      ) : (
        <div
          className="rounded-xl border px-4 py-3.5"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
        >
          <p className="text-[14px] font-semibold text-txt-1">Chrome／Android 開返通知步驟</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-[1.7] text-txt-2">
            <li>撳網址列左邊嘅「鎖頭」圖示</li>
            <li>搵到「通知」→ 揀「允許」</li>
            <li>（搵唔到就去瀏覽器「設定 → 網站設定 → 通知」搵 redcode.red 開返）</li>
            <li>返嚟撳下面「我已開返，再試一次」</li>
          </ol>
        </div>
      )}
      <p className="text-[12px] leading-[1.7] text-txt-3">
        開返之後通知先送得到你部機；任何時候都可以喺會員中心取消綁定。
      </p>
    </div>
  );
}

export default function PushPermissionGuide({
  open,
  onClose,
}: {
  open: boolean;
  /** 流程完結（成功／放棄／失敗後關閉）；subscribed = 今次有冇成功綁定 */
  onClose: (subscribed: boolean) => void;
}) {
  const [step, setStep] = useState<Step>('intro');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const apple = isAppleMobile();

  // 每次打開重置：之前拒絕過（denied）就直接入教學步驟；
  // iPhone/iPad 未「加至主畫面」→ 先入圖文教學（v2.2.16 老闆指令：教學要靚、有圖）
  useEffect(() => {
    if (!open) return;
    setErrorMsg('');
    const denied =
      typeof Notification !== 'undefined' && Notification.permission === 'denied';
    if (denied) {
      setStep('denied');
      return;
    }
    setStep(apple && !isInstalledPwa() ? 'iosSetup' : 'intro');
  }, [open, apple]);

  if (!open) return null;

  /** 撳「允許通知」／「再試一次」：真正觸發 requestPermission＋訂閱 */
  const handleConfirm = async () => {
    if (step === 'busy') return;
    // iPhone 教學步撳「我加咗啦」但仲係 Safari 度開緊 → 提返佢要喺主畫面圖示開，唔好硬撞 error
    if (step === 'iosSetup' && apple && !isInstalledPwa()) {
      setErrorMsg(
        '仲係偵測唔到主畫面版本——加咗之後，記得喺主畫面撳 RedCode 圖示開返官網，先再撳呢個掣。',
      );
      return;
    }
    setStep('busy');
    const res = await subscribeLivePush();
    if (res.ok) {
      setStep('success');
      return;
    }
    // 權限俾瀏覽器擋咗 → 入圖文教學；其他失敗 → 友善錯誤
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      setErrorMsg(res.message);
      setStep('denied');
    } else {
      setErrorMsg(res.message);
      setStep('error');
    }
  };

  const close = () => onClose(step === 'success');

  // v2.2.32（老闆實測：Samsung「開播通知」modal 跑晒位、iPhone 要放大先睇到）：
  // 首頁嗰個掛載點喺 hero-enter 動畫 div 入面——transform 緊嘅祖先會令 position:fixed
  // 以佢做定位基準（唔再係 viewport），成個 modal 縮埋一角落。改 portal 直掛 body，
  // 邊度 mount 都一定全屏置中；純排版修正，三態邏輯（LivePushEntry）完全冇郁。
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center px-4 pb-6 sm:items-center sm:pb-0"
      role="dialog"
      aria-modal="true"
      aria-label="開啟直播開播通知"
    >
      {/* 半透明底（撳唔郁，防止誤觸關閉；用戶要用右上角 ×） */}
      <button
        type="button"
        aria-label="關閉"
        onClick={close}
        className="absolute inset-0 cursor-default"
        style={{ background: 'rgba(5, 2, 12, 0.78)' }}
      />

      <div
        className="push-guide-in relative w-full max-w-[400px] rounded-3xl border p-6 text-center md:p-8"
        style={{
          background: 'var(--space-1)',
          borderColor: 'rgba(245, 197, 24, 0.35)',
        }}
      >
        <button
          type="button"
          onClick={close}
          aria-label="關閉視窗"
          className="absolute right-4 top-4 rounded-full p-1.5 text-txt-3 transition-opacity hover:opacity-70"
        >
          <X size={18} aria-hidden="true" />
        </button>

        {/* 頂部圖示＋標題（所有步驟共用） */}
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border"
          style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
        >
          <Bell size={22} aria-hidden="true" />
        </span>
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.3em] text-gold">
          Live Alert
        </p>

        {step === 'iosSetup' && (
          <>
            <h2 className="mt-2 font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1">
              iPhone 要多一步（30 秒搞掂）
            </h2>
            <p className="mt-3 text-[13px] leading-[1.8] text-txt-2">
              Apple 規定 iPhone 嘅網站通知，要先将 RedCode
              <b className="text-gold-soft">「加至主畫面」</b>
              先收得到——一次設定，之後 Glo Glo 一開播即刻彈通知。
            </p>

            {/* 三步圖文教學：左右碌 snap 卡（官網自家教學插圖） */}
            <div className="-mx-6 mt-4 overflow-x-auto px-6 pb-1 md:-mx-8 md:px-8">
              <div className="flex snap-x snap-mandatory gap-3">
                {IOS_STEPS.map((s) => (
                  <div key={s.n} className="w-[68%] shrink-0 snap-center">
                    <div
                      className="relative overflow-hidden rounded-2xl border"
                      style={{ borderColor: 'rgba(245, 197, 24, 0.35)' }}
                    >
                      <img src={s.img} alt={s.alt} className="block w-full" loading="lazy" />
                      <span
                        className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full font-mono text-[13px] font-bold"
                        style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
                      >
                        {s.n}
                      </span>
                    </div>
                    <p className="mt-2 text-left text-[12px] leading-[1.7] text-txt-2">{s.text}</p>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-1 font-mono text-[10px] tracking-[0.25em] text-txt-3">
              ← 左右碌睇晒 3 步 →
            </p>

            {errorMsg && (
              <p role="alert" className="mt-3 text-[13px] leading-[1.7] text-pink-soft">
                {errorMsg}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleConfirm()}
              className="btn btn-primary mt-5 w-full"
            >
              我加咗啦，繼續設定通知
            </button>
            <button
              type="button"
              onClick={close}
              className="mt-3 text-[13px] text-txt-3 underline underline-offset-4 transition-opacity hover:opacity-70"
            >
              遲啲先
            </button>
          </>
        )}

        {step === 'intro' && (
          <>
            <h2 className="mt-2 font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1">
              開播即刻通知你
            </h2>
            <p className="mt-3 text-[14px] leading-[1.8] text-txt-2">
              跟住瀏覽器會彈出通知權限視窗，
              <b className="text-txt-1">請撳「允許」</b>
              ——之後 Glo Glo 一開播，你部機就會收到通知，唔會再錯過任何一場。
            </p>
            <div className="mt-5">
              <MockNotification />
            </div>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              className="btn btn-primary mt-6 w-full"
            >
              好，允許通知
            </button>
            <button
              type="button"
              onClick={close}
              className="mt-3 text-[13px] text-txt-3 underline underline-offset-4 transition-opacity hover:opacity-70"
            >
              而家唔駛，遲啲先
            </button>
          </>
        )}

        {step === 'busy' && (
          <>
            <h2 className="mt-2 font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1">
              等你確認緊…
            </h2>
            <p className="mt-3 text-[14px] leading-[1.8] text-txt-2">
              請喺瀏覽器彈出嘅視窗撳「允許」。冇見到彈窗？睇下網址列左邊有冇通知圖示。
            </p>
            <p className="mt-6 text-[13px] text-txt-3">處理中…</p>
          </>
        )}

        {step === 'success' && (
          <>
            <span
              className="mx-auto mt-4 flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
            >
              <Check size={28} aria-hidden="true" />
            </span>
            <h2 className="mt-4 font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1">
              搞掂！已綁定呢部裝置
            </h2>
            <p className="mt-3 text-[14px] leading-[1.8] text-txt-2">
              之後每次開播你都會收到通知。想取消的話，隨時喺會員中心「直播開播通知」取消綁定。
            </p>
            <button type="button" onClick={close} className="btn btn-primary mt-6 w-full">
              完成
            </button>
          </>
        )}

        {step === 'denied' && (
          <>
            <h2 className="mt-2 font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1">
              通知權限之前被封鎖咗
            </h2>
            <p className="mt-3 text-[14px] leading-[1.8] text-txt-2">
              唔緊要，跟住下面步驟喺瀏覽器設定開返就得：
            </p>
            <DeniedSteps />
            {errorMsg && (
              <p role="alert" className="mt-3 text-[13px] text-pink-soft">
                {errorMsg}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleConfirm()}
              className="btn btn-primary mt-5 w-full"
            >
              我已開返，再試一次
            </button>
            <button
              type="button"
              onClick={close}
              className="mt-3 text-[13px] text-txt-3 underline underline-offset-4 transition-opacity hover:opacity-70"
            >
              而家唔搞住，遲啲先
            </button>
          </>
        )}

        {step === 'error' && (
          <>
            <h2 className="mt-2 font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1">
              今次綁定唔到
            </h2>
            <p role="alert" className="mt-3 text-[14px] leading-[1.8] text-txt-2">
              {errorMsg || '發生咗啲問題，請稍後再試。'}
            </p>
            <p className="mt-2 text-[13px] leading-[1.7] text-txt-3">
              可以稍後喺會員中心「直播開播通知」開返，唔影響你而家嘅操作。
            </p>
            <button type="button" onClick={close} className="btn btn-secondary mt-6 w-full">
              <ExternalLink size={15} aria-hidden="true" />
              知道啦
            </button>
          </>
        )}
      </div>

      {/* 進場動畫：淨 opacity/transform（老闆鐵律） */}
      <style>{`
        .push-guide-in {
          animation: push-guide-in 320ms var(--ease-expo, ease) both;
        }
        @keyframes push-guide-in {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .push-guide-in { animation: none; }
        }
      `}</style>
    </div>,
    document.body,
  );
}
