import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapPin, PartyPopper } from 'lucide-react';
import { Link } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import GloCutout from '@/components/GloCutout';
import RegionStationPicker from '@/components/shop/RegionStationPicker';

/**
 * v2.2.46 中獎賀卡彈窗（老闆指令：「客人中獎後登入，彈出嚟中獎方塊…要放煙花，
 * 由小精靈 Glo Glo 飛嚟恭喜佢（動態影片）」）
 *
 * - 全域掛喺 Layout（同 MarketingConsentModal 一齊）：首次登入或已登入，
 *    一見到有 pending 中獎就彈；「遲啲先」只係今次收埋，下次入嚟會再彈
 * - 煙花 canvas 爆開＋小精靈 alpha 影片飛入（GloCutout 三層兜底，reduced-motion 自動靜態）
 * - 兩個掣：「多謝，請寄送」→ 揀地址（預設順豐站/地址直接用；冇就 RegionStationPicker
 *   揀——GPS 搵最近／分類別／輸入地址，同結帳一樣）；「唔要」→ declined，獎品返池
 * - 確認後 server 生成 0 元訂單飛 WMS 等審批（訂單日期＝抽獎日，備註中獎商品・包郵）
 *
 * 設計鐵律：動畫淨用 transform/opacity；層次靠 DOM 順序（煙花層最後出自然壓頂）。
 */

/** 煙花粒子（v2.2.56 加強版，同後台輪盤同款：拖尾火星＋金色衝擊波環＋錯峰爆；金/粉紅/白/紫） */
function useFireworks(active: boolean) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !active) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = (canvas.width = canvas.offsetWidth * 2);
    const H = (canvas.height = canvas.offsetHeight * 2);
    type P = { x: number; y: number; px: number; py: number; vx: number; vy: number; life: number; max: number; color: string; size: number };
    type Ring = { x: number; y: number; r: number; vr: number; alpha: number };
    const colors = ['#F5C518', '#F5C518', '#F7D774', '#FF8FBF', '#FFFFFF', '#C4B5FD'];
    const parts: P[] = [];
    const rings: Ring[] = [];
    const burst = (bx: number, by: number) => {
      rings.push({ x: bx, y: by, r: 10, vr: 6, alpha: 0.8 });
      for (let i = 0; i < 100; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 6.5;
        parts.push({
          x: bx, y: by, px: bx, py: by,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
          life: 0, max: 60 + Math.random() * 45,
          color: colors[Math.floor(Math.random() * colors.length)],
          size: 1.8 + Math.random() * 3.2,
        });
      }
    };
    burst(W * 0.28, H * 0.3);
    const timers = [
      window.setTimeout(() => burst(W * 0.72, H * 0.26), 240),
      window.setTimeout(() => burst(W * 0.5, H * 0.14), 500),
    ];
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      let any = false;
      for (const rg of rings) {
        if (rg.alpha <= 0.02) continue;
        any = true;
        rg.r += rg.vr;
        rg.vr *= 0.965;
        rg.alpha *= 0.94;
        ctx.globalAlpha = rg.alpha;
        ctx.beginPath();
        ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#F7D774';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      for (const p of parts) {
        if (p.life >= p.max) continue;
        any = true;
        p.life++;
        p.px = p.x;
        p.py = p.y;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.09;
        p.vx *= 0.985;
        const fade = 1 - p.life / p.max;
        ctx.globalAlpha = fade * 0.9;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.8, p.size * 0.55);
        ctx.stroke();
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + fade * 0.6), 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (any) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      for (const t of timers) window.clearTimeout(t);
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, W, H); // 早切步驟都唔會留「冰封火星」
    };
  }, [active]);
  return ref;
}

type Step = 'win' | 'addr' | 'done';

export default function PrizeWinModal() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [dismissedDrawId, setDismissedDrawId] = useState<number | null>(null);
  const [step, setStep] = useState<Step>('win');
  const [useOtherStation, setUseOtherStation] = useState(false);
  const [stationId, setStationId] = useState<string | undefined>(undefined);
  const [stationName, setStationName] = useState<string | undefined>(undefined);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const winQuery = trpc.luckyDraw.myPendingWin.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: true,
  });
  const win = winQuery.data ?? null;

  const respond = trpc.luckyDraw.respondWin.useMutation();

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const fireworksRef = useFireworks(!!win && step === 'win' && !reducedMotion);

  // 新中獎（另一筆）→ 重置返去慶祝步；用 ref 記上一個 drawId，唔靠 win object identity
  // （refetchOnWindowFocus refetch 後 win 會係新 object，淨比 drawId 先穩陣）
  const prevDrawIdRef = useRef<number | null>(null);
  useEffect(() => {
    const id = win?.drawId ?? null;
    if (id !== prevDrawIdRef.current) {
      prevDrawIdRef.current = id;
      if (id != null && id !== dismissedDrawId) {
        setStep('win');
        setUseOtherStation(false);
        setStationId(undefined);
        setStationName(undefined);
        setOrderNo(null);
        setErr(null);
      }
    }
  }, [win, dismissedDrawId]);

  if (!user || !win || win.drawId === dismissedDrawId) return null;

  const drawDateLabel = `${win.drawDate.slice(0, 4)}-${win.drawDate.slice(4, 6)}-${win.drawDate.slice(6, 8)}`;

  // 預設取貨：sf_*＋站名／送貨地址；有就先問「用預設？」
  // 舊 session／邊界情況 auth.me 可能冇 deliveryMethod（undefined）→ 有地址就當 'address'
  const method = user.deliveryMethod ?? (user.address?.trim() ? 'address' : undefined);
  const hasPreset =
    !useOtherStation &&
    ((!!method && method !== 'address' && !!user.pickupPoint?.trim()) ||
      (method === 'address' && !!user.address?.trim()));
  const presetLabel =
    method === 'sf_locker'
      ? `智能櫃：${user.pickupPoint}`
      : method === 'sf_station'
        ? `順豐站／自提點：${user.pickupPoint}`
        : `送貨上門：${user.address}`;

  const decline = async () => {
    if (!window.confirm('真係唔要呢份禮物？揀咗就冇得返轉頭㗎。')) return;
    setErr(null);
    try {
      await respond.mutateAsync({ drawId: win.drawId, action: 'decline' });
      setDismissedDrawId(win.drawId);
      void utils.luckyDraw.myPendingWin.invalidate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失敗，請再試');
    }
  };

  const ship = async (choice: 'preset' | 'station') => {
    setErr(null);
    try {
      const r = await respond.mutateAsync({
        drawId: win.drawId,
        action: 'ship',
        choice,
        stationId: choice === 'station' ? stationId : undefined,
      });
      if ('orderNo' in r && r.orderNo) {
        setOrderNo(r.orderNo);
        setStep('done');
        void utils.luckyDraw.myPendingWin.invalidate();
        void utils.orders.myOrders.invalidate();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失敗，請再試');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto p-4">
      <div className="absolute inset-0" style={{ background: 'rgba(4,2,10,0.86)' }} aria-hidden="true" />
      {/* 煙花層（DOM 後出自然壓頂；淨係第一步慶祝時爆） */}
      <canvas ref={fireworksRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />

      {/* 外層 wrapper：卡片保持 overflow-hidden，小精靈用普通流（卡片上方 sibling）
          以 marginBottom:-56px 企上卡頂邊——唔再 absolute，唔會再移位 */}
      <div className="relative my-auto w-full max-w-md">
        {/* 小精靈 Glo Glo 拍手恭喜（新正方素材；alpha 影片；reduced-motion 自動靜態 poster） */}
        {step === 'win' && (
          <div
            aria-hidden="true"
            className="pointer-events-none relative z-10 mx-auto w-[120px]"
            style={{
              margin: '0 auto -56px',
              animation: reducedMotion ? undefined : 'fairyFlyIn 1400ms cubic-bezier(0.2,1.1,0.3,1) 200ms both',
            }}
          >
            <GloCutout
              videoSrc="/fairy-clap-alpha.webm"
              animSrc="/fairy-clap-anim.webp"
              poster="/fairy-clap-poster.webp"
              alt=""
              posterW={480}
              posterH={480}
              eager
            />
          </div>
        )}

        <div
          role="dialog"
          aria-modal="true"
          aria-label="恭喜中獎"
          className="relative w-full overflow-hidden rounded-3xl border"
          style={{
            borderColor: 'rgba(245,197,24,0.55)',
            background: 'linear-gradient(180deg, #1B0E33 0%, #120C24 60%)',
            boxShadow: '0 0 80px rgba(245,197,24,0.22)',
            animation: reducedMotion ? undefined : 'prizeCardIn 500ms cubic-bezier(0.2,1.3,0.4,1)',
          }}
        >
          <div className="relative px-6 pb-6 pt-7 text-center">
            {step === 'win' && (
              <>
                {/* mt-9 留位俾企喺卡頂嘅小精靈（56px overlap），唔會壓住標題 */}
                <p className="script mt-9 text-3xl text-gold">Congratulations ✦</p>
              <h2 className="mt-1 font-serif-tc text-[24px] font-bold leading-[1.3] text-txt-1">
                恭喜寶寶中獎！
              </h2>
              <p className="mt-1 text-[13px] text-txt-2">
                {user.name}，Glo Glo 喺 {drawDateLabel} 直播抽獎抽中你 ♥
              </p>

              <div
                className="mx-auto mt-4 w-fit max-w-full rounded-2xl border p-3"
                style={{
                  borderColor: 'rgba(245,197,24,0.45)',
                  background: 'rgba(245,197,24,0.08)',
                }}
              >
                <img
                  src={win.prizeImagePath}
                  alt={win.prizeName}
                  className="mx-auto h-40 w-40 rounded-xl object-cover"
                />
                <p className="mt-2 text-[15px] font-bold text-txt-1">{win.prizeName}</p>
                <p className="mt-0.5 font-mono text-[12px] text-gold-soft">
                  價值 HK${win.prizePrice.toLocaleString('en-HK')}・中獎日 {drawDateLabel}
                </p>
              </div>

              <div className="mt-5 flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => setStep('addr')}
                  className="w-full rounded-full py-3 font-serif-tc text-[15.5px] font-bold tracking-[0.12em]"
                  style={{
                    background: 'linear-gradient(160deg, #F7D774 0%, #F5C518 55%, #C99B0F 100%)',
                    color: '#241505',
                    boxShadow: '0 6px 26px rgba(245,197,24,0.35)',
                  }}
                >
                  多謝，請寄送 ♥
                </button>
                <button
                  type="button"
                  onClick={() => void decline()}
                  disabled={respond.isPending}
                  className="w-full rounded-full border py-2.5 text-[13.5px] text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  唔要
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedDrawId(win.drawId)}
                  className="mx-auto mt-1 text-[12px] text-txt-3 underline underline-offset-4 hover:text-txt-2"
                >
                  遲啲先揀
                </button>
              </div>
            </>
          )}

          {step === 'addr' && (
            <>
              <p className="flex items-center justify-center gap-2 font-serif-tc text-[20px] font-bold text-txt-1">
                <MapPin size={18} aria-hidden="true" className="text-gold" />
                揀取貨方式
              </p>
              <p className="mt-1 text-[12.5px] text-txt-3">
                {win.prizeName}・中獎包郵，唔使俾一分錢
              </p>

              {hasPreset ? (
                <div className="mt-4 space-y-3 text-left">
                  <div
                    className="rounded-2xl border p-4"
                    style={{ borderColor: 'rgba(245,197,24,0.4)', background: 'rgba(245,197,24,0.06)' }}
                  >
                    <p className="text-[12px] tracking-[0.1em] text-txt-3">你嘅預設取貨方式</p>
                    <p className="mt-1 text-[14.5px] font-semibold text-txt-1">{presetLabel}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void ship('preset')}
                    disabled={respond.isPending}
                    className="w-full rounded-full py-3 text-[14.5px] font-bold disabled:opacity-40"
                    style={{ background: '#F5C518', color: '#241505' }}
                  >
                    {respond.isPending ? '確認緊…' : '用呢個，確認寄送 ✓'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseOtherStation(true)}
                    className="w-full rounded-full border py-2.5 text-[13px] text-txt-2 transition-colors hover:text-txt-1"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    改用其他順豐站／自提點／智能櫃
                  </button>
                </div>
              ) : (
                <div className="mt-4 text-left">
                  <RegionStationPicker
                    region="HK"
                    method="sf_station"
                    value={stationId}
                    onChange={(id, name) => {
                      setStationId(id);
                      setStationName(name);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void ship('station')}
                    disabled={!stationId || respond.isPending}
                    className="mt-3 w-full rounded-full py-3 text-[14.5px] font-bold disabled:opacity-40"
                    style={{ background: '#F5C518', color: '#241505' }}
                  >
                    {respond.isPending
                      ? '確認緊…'
                      : stationName
                        ? `寄去「${stationName}」，確認 ✓`
                        : '請先揀站點'}
                  </button>
                  {(!!user.pickupPoint?.trim() || !!user.address?.trim()) && (
                    <button
                      type="button"
                      onClick={() => setUseOtherStation(false)}
                      className="mt-2 w-full text-[12.5px] text-txt-3 underline underline-offset-4 hover:text-txt-2"
                    >
                      返去用預設
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {step === 'done' && (
            <>
              <PartyPopper size={40} aria-hidden="true" className="mx-auto text-gold" />
              <h2 className="mt-2 font-serif-tc text-[22px] font-bold text-txt-1">搞掂！禮物準備出發 ♥</h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-txt-2">
                訂單 <span className="font-mono text-gold-soft">{orderNo}</span> 已生成（0 元・包郵），
                訂單日期係你嘅中獎日 {drawDateLabel}。我哋審批後就會寄出，
                進度隨時喺「我的訂單」睇到。
              </p>
              <div className="mt-5 flex flex-col gap-2.5">
                <Link
                  to="/orders"
                  className="w-full rounded-full py-3 text-center text-[14.5px] font-bold"
                  style={{ background: '#F5C518', color: '#241505' }}
                >
                  去「我的訂單」睇中獎訂單
                </Link>
                <button
                  type="button"
                  onClick={() => setDismissedDrawId(win.drawId)}
                  className="w-full rounded-full border py-2.5 text-[13px] text-txt-2 transition-colors hover:text-txt-1"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  收埋
                </button>
              </div>
            </>
          )}

          {err && <p className="mt-3 text-[12.5px] text-pink-soft">{err}</p>}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes prizeCardIn { 0% { transform: scale(0.82) translateY(24px); opacity: 0; } 100% { transform: scale(1) translateY(0); opacity: 1; } }
        @keyframes fairyFlyIn { 0% { transform: translate(-40px, 30px) scale(0.6); opacity: 0; } 100% { transform: none; opacity: 1; } }
      `}</style>
    </div>,
    document.body,
  );
}
