/**
 * TicketDrawStage —— 抽獎劵舞台（非輪盤版・controlled 展示元件）
 *
 * 定位：LuckyDrawPanel 嘅輪盤係「管理員撳掣即場轉」；呢個舞台係「活動/直播畫面」用嘅
 * 純展示層 —— 由父層（之後嘅整合）話俾佢知而家咩階段、中獎者係邊個。
 *
 * 誠實鐵律（同老闆既定規矩一致）：
 *  - drawing 階段只講事實：「伺服器開獎中」—— 唔會喺 client 滾動假名單扮「緊張抽緊」，
 *    中獎者永遠由後端結果（winner prop）決定；phase='revealed' 但 winner 未到手 →
 *    照實顯示「結果核實中」，唔會空場扮揭曉。
 *  - 動畫淨用 transform/opacity（compositor-only）；reducedMotion（prop 或系統設定）
 *    → 唔翻牌、唔掃光、唔爆金屑，直接靜態揭曉。
 *  - 持續循環動效（飄浮/掃光/呼吸光暈）喺背景分頁（visibilitychange）或離開視口
 *    （IntersectionObserver）時 animation-play-state:paused，慳電；一過性揭曉動畫
 *    本來就單次，背景分頁瀏覽器自動凍結。
 *  - a11y：aria-live="polite" 即場宣讀真結果（唔係齋靠金色）；狀態全部有文字；
 *    320px/平板/桌面唔會橫向溢出（min()＋clamp()＋overflowWrap）。
 *
 * 設計語言：黑金舞台（沿用抽獎家族 #241505 深棕黑 / #F5C518 金 / #FFF6D8 米白）。
 * 揭曉編排（純 transform/opacity）：翻牌 0.75s → 三層光暈錯峰擴散（120ms stagger）→
 * 金框四邊順序描畫（90ms stagger，模擬路徑描邊感）→ 內容逐行浮現（80ms stagger，
 * cubic-bezier(0.25,0.1,0.25,1)）→ 金光掃過一次 → 18 塊金屑黃金角單次爆開（定死座標，
 * 唔使 Math.random，render 可重現）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Trophy, Ticket } from 'lucide-react';

// ───────────────────────────── 型別（對外合約） ─────────────────────────────

export type DrawPhase = 'idle' | 'drawing' | 'revealed';

export interface DrawWinner {
  name: string;
  /** 中獎劵號（後端有先顯示，冇就唔顯） */
  ticketNo?: string | number | null;
  /** member＝官網會員；manual＝登記名單 —— 只影響小字標籤，可留空 */
  kind?: 'member' | 'manual';
}

export interface DrawPrize {
  name: string;
  imageUrl?: string | null;
  /** 展示用價值/備註（例如 "HK$1,280"），可留空 */
  value?: string | null;
}

export interface TicketDrawStageProps {
  /** 活動名（顯示喺劵面楣位） */
  eventName: string;
  /** 獎品基本資料（劵尾存根展示） */
  prize: DrawPrize;
  /** 階段由父層控制：idle 待開獎 → drawing 伺服器開獎中 → revealed 揭曉 */
  phase: DrawPhase;
  /** 中獎者 —— 只會喺 phase='revealed' 先讀取；未到『revealed』即使傳入都唔會顯示 */
  winner?: DrawWinner | null;
  /** 全場抽獎劵總數（揭曉時講明「N 張劵抽出 1 張」） */
  winnerTicketCount?: number | null;
  /** 強制減動效；唔傳就跟系統 prefers-reduced-motion，仲會即時跟蹤系統切換 */
  reducedMotion?: boolean;
  /** 揭曉動畫播完（減動效＝即刻）觸發一次；revealed 但 winner 未到手唔會觸發 */
  onRevealComplete?: () => void;
  className?: string;
}

// ───────────────────────────── 常數 ─────────────────────────────

const GOLD = '#F5C518';
const GOLD_LIGHT = '#F9E27D';
const GOLD_DEEP = '#C99B0F';
const BG_DEEP = '#241505';
const CREAM = '#FFF6D8';

/** 金屑：黃金角分佈（定死，唔用 random —— render 結果可重現、可測） */
const SPARKS = Array.from({ length: 18 }, (_, i) => {
  const angle = i * 137.508 * (Math.PI / 180);
  const dist = 96 + (i % 5) * 22;
  return {
    tx: Math.cos(angle) * dist,
    ty: Math.sin(angle) * dist * 0.72 - 24,
    rot: (i % 2 ? 1 : -1) * (40 + (i % 4) * 30),
    size: 4 + (i % 3) * 2,
    delay: 0.55 + (i % 6) * 0.03,
    round: i % 3 === 0,
  };
});

/** 揭曉總時長（同下面 CSS 編排對齊：翻牌 0.75s + 尾段掃光緩衝） */
const REVEAL_MS = 1300;

type FrameEdge = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  width?: number;
  height?: number;
  origin: 'top' | 'right' | 'bottom' | 'left';
  d: number;
  axis: 'x' | 'y';
};

/** 金框四邊順序描畫；optional 座標令每條邊只需宣告實際使用嘅方向 */
const FRAME_EDGES: FrameEdge[] = [
  { top: 0, left: 0, right: 0, height: 2, origin: 'left', d: 0.45, axis: 'x' },
  { top: 0, bottom: 0, right: 0, width: 2, origin: 'top', d: 0.54, axis: 'y' },
  { bottom: 0, left: 0, right: 0, height: 2, origin: 'right', d: 0.63, axis: 'x' },
  { top: 0, bottom: 0, left: 0, width: 2, origin: 'bottom', d: 0.72, axis: 'y' },
];

// ───────────────────────────── 元件 ─────────────────────────────

export default function TicketDrawStage({
  eventName,
  prize,
  phase,
  winner = null,
  winnerTicketCount = null,
  reducedMotion,
  onRevealComplete,
  className,
}: TicketDrawStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 減動效：prop 優先；冇傳就跟系統，仲即時跟蹤切換
  const [sysReduced, setSysReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setSysReduced(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  const reduced = reducedMotion ?? sysReduced;

  // 背景分頁 / 離開視口 → 暫停持續循環動畫（一過性揭曉動畫唔使理，瀏覽器自動凍）
  const [loopsLive, setLoopsLive] = useState(true);
  // 注意：animation 係 inline shorthand（內含 play-state:running），所以暫停一定要 inline 覆寫，
  // stylesheet 嘅 animation-play-state 會輸俾 inline shorthand —— 每個循環動畫都帶埋呢個值
  const loopPlay: 'running' | 'paused' = loopsLive ? 'running' : 'paused';
  const inViewRef = useRef(true);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const sync = () => setLoopsLive(!document.hidden && inViewRef.current);
    const onVis = () => sync();
    document.addEventListener('visibilitychange', onVis);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(
        (entries) => { inViewRef.current = entries[0]?.isIntersecting ?? true; sync(); },
        { threshold: 0.05 },
      );
      io.observe(el);
    }
    sync();
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
    };
  }, []);

  // 揭曉完成回調：只有真係有後端 winner 先算揭曉；減動效＝即刻算完
  const showWinner = phase === 'revealed' && !!winner;
  useEffect(() => {
    if (!showWinner) return;
    const t = window.setTimeout(() => onRevealComplete?.(), reduced ? 60 : REVEAL_MS);
    return () => window.clearTimeout(t);
  }, [showWinner, reduced, onRevealComplete]);

  const ticketCountTxt = winnerTicketCount != null && winnerTicketCount > 0
    ? `全場 ${winnerTicketCount.toLocaleString()} 張抽獎劵・抽出 1 張`
    : null;

  // aria-live 宣讀內容：講事實，唔靠顏色
  const liveTxt = phase === 'drawing'
    ? `伺服器開獎中，結果由伺服器抽出，請稍候。獎品：${prize.name}。`
    : showWinner
      ? `開獎結果：${winner!.name} 中獎${winner!.ticketNo != null ? `，中獎劵號 ${winner!.ticketNo}` : ''}，獎品 ${prize.name}。`
      : phase === 'revealed'
        ? '開獎結果核實中，等待伺服器確認。'
        : `待開獎。獎品：${prize.name}。`;

  const sparkEls = useMemo(() => SPARKS.map((s, i) => (
    <span
      key={i}
      aria-hidden
      className="tds-spark"
      style={{
        width: s.size, height: s.round ? s.size : s.size * 2.2,
        borderRadius: s.round ? 99 : 1.5,
        animationDelay: `${s.delay}s`,
        ['--tx' as string]: `${s.tx}px`,
        ['--ty' as string]: `${s.ty}px`,
        ['--rot' as string]: `${s.rot}deg`,
      }}
    />
  )), []);

  return (
    <div
      ref={rootRef}
      className={`tds-root${loopsLive ? '' : ' tds-paused'}${className ? ` ${className}` : ''}`}
      style={{
        position: 'relative', width: '100%', maxWidth: '100%', overflow: 'hidden', boxSizing: 'border-box',
        background: `radial-gradient(900px 420px at 50% 30%, #3A2408 0%, ${BG_DEEP} 55%, #120A02 100%)`,
        borderRadius: 20, padding: 'clamp(18px, 4vw, 40px) clamp(12px, 3vw, 28px)',
        fontFamily: 'inherit', color: CREAM,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
      }}
    >
      <style>{`
        .tds-root, .tds-root *, .tds-root *::before, .tds-root *::after { box-sizing: border-box; }
        .tds-root.tds-paused .tds-loop { animation-play-state: paused; }
        @keyframes tdsFloat { 0%,100% { transform: translateY(0) scale(1.012); } 50% { transform: translateY(-5px) scale(1.012); } }
        @keyframes tdsSheen { 0% { transform: translateX(-130%) skewX(-18deg); opacity: 0; } 18% { opacity: .55; } 55% { opacity: .55; } 100% { transform: translateX(230%) skewX(-18deg); opacity: 0; } }
        @keyframes tdsChase { 0%,100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }
        @keyframes tdsFlip { 0% { transform: rotateY(0deg); } 100% { transform: rotateY(180deg); } }
        @keyframes tdsRing { 0% { transform: translate(-50%,-50%) scale(.55); opacity: 0; } 35% { opacity: .8; } 100% { transform: translate(-50%,-50%) scale(1); opacity: .34; } }
        @keyframes tdsBreathe { 0%,100% { opacity: .3; transform: translate(-50%,-50%) scale(1); } 50% { opacity: .55; transform: translate(-50%,-50%) scale(1.035); } }
        @keyframes tdsRise { 0% { transform: translateY(9px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
        @keyframes tdsFrameX { 0% { transform: scaleX(0); opacity: 0; } 30% { opacity: 1; } 100% { transform: scaleX(1); opacity: 1; } }
        @keyframes tdsFrameY { 0% { transform: scaleY(0); opacity: 0; } 30% { opacity: 1; } 100% { transform: scaleY(1); opacity: 1; } }
        @keyframes tdsSweep { 0% { transform: translateX(-140%) skewX(-20deg); opacity: 0; } 25% { opacity: .8; } 100% { transform: translateX(260%) skewX(-20deg); opacity: 0; } }
        @keyframes tdsSpark { 0% { transform: translate(0,0) rotate(0deg) scale(1); opacity: 1; } 100% { transform: translate(var(--tx), var(--ty)) rotate(var(--rot)) scale(.4); opacity: 0; } }
        .tds-spark {
          position: absolute; left: 50%; top: 42%; pointer-events: none;
          background: linear-gradient(180deg, ${GOLD_LIGHT}, ${GOLD_DEEP});
          animation: tdsSpark 0.9s cubic-bezier(0.15, 0.6, 0.3, 1) both;
        }
        .tds-loop { will-change: transform, opacity; }
        .tds-root a:focus-visible, .tds-root button:focus-visible { outline: 2px solid ${GOLD_LIGHT}; outline-offset: 2px; border-radius: 6px; }
        @media (prefers-reduced-motion: reduce) {
          .tds-root .tds-loop, .tds-root .tds-once, .tds-root .tds-spark { animation: none !important; }
        }
      `}</style>

      {/* 楣位：活動名＋獎品（唔靠顏色，有真文字） */}
      <div style={{ textAlign: 'center', maxWidth: '100%' }}>
        <div style={{ fontSize: 11, letterSpacing: '0.28em', color: GOLD_DEEP, fontWeight: 700, overflowWrap: 'anywhere' }}>
          {eventName}
        </div>
        <div style={{ marginTop: 4, fontSize: 'clamp(15px, 2.4vw, 19px)', fontWeight: 800, color: CREAM, overflowWrap: 'anywhere' }}>
          {prize.name}{prize.value ? <span style={{ color: GOLD_LIGHT, fontWeight: 700 }}>（{prize.value}）</span> : null}
        </div>
      </div>

      {/* 舞台：idle/drawing＝抽獎劵正面；revealed＝翻去金色中獎卡 */}
      <div style={{ position: 'relative', width: 'min(560px, 100%)', perspective: 1100 }}>
        {/* 層次光暈（揭曉先出；DOM 順序墊底，pointer-events 唔攔） */}
        {showWinner && !reduced && [0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden
            className={i === 2 ? 'tds-loop' : 'tds-once'}
            style={{
              position: 'absolute', left: '50%', top: '50%', width: `${78 + i * 16}%`, aspectRatio: '1.55',
              transform: 'translate(-50%,-50%)', borderRadius: '50%', pointerEvents: 'none',
              border: `1.5px solid rgba(245,197,24,${0.5 - i * 0.13})`,
              boxShadow: `0 0 ${26 + i * 18}px rgba(245,197,24,${0.28 - i * 0.07})`,
              animationName: i === 2 ? 'tdsRing, tdsBreathe' : 'tdsRing',
              animationDuration: i === 2 ? '0.7s, 4.2s' : '0.7s',
              animationTimingFunction: i === 2 ? 'cubic-bezier(0.2, 0.7, 0.2, 1), ease-in-out' : 'cubic-bezier(0.2, 0.7, 0.2, 1)',
              animationDelay: i === 2 ? `${0.35 + i * 0.12}s, 1.2s` : `${0.35 + i * 0.12}s`,
              animationIterationCount: i === 2 ? '1, infinite' : '1',
              animationFillMode: 'both',
              animationPlayState: i === 2 ? loopPlay : undefined,
            }}
          />
        ))}

        <div
          style={{
            position: 'relative', width: '100%', transformStyle: 'preserve-3d',
            transform: showWinner ? 'rotateY(180deg)' : 'none',
            animation: showWinner && !reduced ? 'tdsFlip 0.75s cubic-bezier(0.2, 0.7, 0.2, 1) both' : undefined,
          }}
        >
          {/* ── 正面：抽獎劵 ── */}
          <div
            aria-hidden={showWinner}
            style={{
              backfaceVisibility: 'hidden', width: '100%',
              background: `linear-gradient(160deg, #33200A 0%, ${BG_DEEP} 70%)`,
              border: `1.5px solid rgba(245,197,24,0.4)`, borderRadius: 16,
              display: 'flex', alignItems: 'stretch', minHeight: 132,
              animationName: phase === 'drawing' && !reduced ? 'tdsFloat' : undefined,
              animationDuration: '2.2s', animationTimingFunction: 'ease-in-out', animationIterationCount: 'infinite',
              animationPlayState: loopPlay,
            }}
            className={phase === 'drawing' && !reduced ? 'tds-loop' : undefined}
          >
            {/* 劵身 */}
            <div style={{ flex: 1, minWidth: 0, padding: '16px 18px', position: 'relative', overflow: 'hidden', borderRadius: '16px 0 0 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GOLD_DEEP, fontSize: 10.5, letterSpacing: '0.22em', fontWeight: 700 }}>
                <Ticket size={13} aria-hidden /> 抽獎劵
              </div>
              <div style={{ marginTop: 12, fontSize: 'clamp(17px, 3vw, 22px)', fontWeight: 800, lineHeight: 1.4, color: phase === 'drawing' ? GOLD_LIGHT : CREAM }}>
                {phase === 'drawing' ? '伺服器開獎中' : phase === 'revealed' ? '結果核實中' : '待開獎'}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, color: 'rgba(255,246,216,0.62)' }}>
                {phase === 'drawing'
                  ? '結果由伺服器抽出，呢度唔會預演名單 —— 請稍候。'
                  : phase === 'revealed'
                    ? '等待伺服器確認中獎結果。'
                    : '開獎時結果會即場喺呢度揭曉。'}
              </div>
              {/* 開獎中：追光點（純示意進行中，唔係進度呃人） */}
              {phase === 'drawing' && (
                <div style={{ marginTop: 10, display: 'flex', gap: 7, alignItems: 'center' }} aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className={reduced ? undefined : 'tds-loop'}
                      style={{
                        width: 6, height: 6, borderRadius: 99, background: GOLD,
                        animationName: reduced ? undefined : 'tdsChase',
                        animationDuration: '1.05s', animationTimingFunction: 'ease-in-out',
                        animationDelay: `${i * 0.18}s`, animationIterationCount: 'infinite',
                        animationPlayState: loopPlay,
                      }}
                    />
                  ))}
                </div>
              )}
              {/* 開獎中：金光掃過（遮住層，overflow hidden 喺劵身） */}
              {phase === 'drawing' && !reduced && (
                <div
                  aria-hidden
                  className="tds-loop"
                  style={{
                    position: 'absolute', top: 0, bottom: 0, left: 0, width: '34%', pointerEvents: 'none',
                    background: `linear-gradient(90deg, transparent, rgba(249,226,125,0.35), transparent)`,
                    animationName: 'tdsSheen', animationDuration: '1.65s',
                    animationTimingFunction: 'ease-in-out', animationIterationCount: 'infinite',
                    animationPlayState: loopPlay,
                  }}
                />
              )}
            </div>
            {/* 打孔線＋存根 */}
            <div aria-hidden style={{ width: 0, borderLeft: `2px dashed rgba(245,197,24,0.45)`, margin: '10px 0', position: 'relative' }}>
              <span style={{ position: 'absolute', top: -16, left: -6, width: 10, height: 10, borderRadius: 99, border: `1.5px solid rgba(245,197,24,0.45)` }} />
              <span style={{ position: 'absolute', bottom: -16, left: -6, width: 10, height: 10, borderRadius: 99, border: `1.5px solid rgba(245,197,24,0.45)` }} />
            </div>
            <div style={{ width: 118, flexShrink: 0, padding: '14px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, textAlign: 'center' }}>
              {prize.imageUrl ? (
                <img src={prize.imageUrl} alt="" style={{ width: '100%', maxHeight: 56, objectFit: 'contain', borderRadius: 8 }} />
              ) : null}
              <div style={{ fontSize: 11, fontWeight: 700, color: GOLD_LIGHT, overflowWrap: 'anywhere', lineHeight: 1.45 }}>{prize.name}</div>
              <div style={{ fontSize: 9.5, letterSpacing: '0.2em', color: 'rgba(255,246,216,0.4)' }}>存根</div>
            </div>
          </div>

          {/* ── 背面：金色中獎卡（翻牌後先見到） ── */}
          <div
            aria-hidden={!showWinner}
            style={{
              position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)',
              background: `linear-gradient(155deg, #4A3208 0%, #2A1B04 55%, ${BG_DEEP} 100%)`,
              borderRadius: 16, overflow: 'hidden',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              padding: '18px 20px', textAlign: 'center',
              visibility: showWinner ? 'visible' : 'hidden',
            }}
          >
            {/* 金框四邊順序描畫（transform 版「路徑描邊」） */}
            {showWinner && !reduced && FRAME_EDGES.map((e, i) => (
              <span
                key={i}
                aria-hidden
                className="tds-once"
                style={{
                  position: 'absolute', ...('width' in e ? { width: e.width } : { height: e.height }),
                  top: e.top, bottom: e.bottom, left: e.left, right: e.right,
                  background: `linear-gradient(90deg, ${GOLD_LIGHT}, ${GOLD})`,
                  transformOrigin: e.origin,
                  animation: `tdsFrame${e.axis.toUpperCase()} 0.34s cubic-bezier(0.25, 0.1, 0.25, 1) ${e.d}s both`,
                }}
              />
            ))}
            {showWinner && reduced && (
              <span aria-hidden style={{ position: 'absolute', inset: 0, border: `2px solid ${GOLD}`, borderRadius: 16, pointerEvents: 'none' }} />
            )}

            {/* 內容逐行浮現（stagger 80ms） */}
            {showWinner && winner && (
              <>
                {([
                  <span key="t" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, letterSpacing: '0.3em', fontWeight: 800, color: GOLD_DEEP }}>
                    <Trophy size={13} aria-hidden /> 中獎結果
                  </span>,
                  <span key="n" style={{ fontSize: 'clamp(24px, 6vw, 40px)', fontWeight: 900, lineHeight: 1.25, letterSpacing: '0.02em', overflowWrap: 'anywhere', maxWidth: '100%', background: `linear-gradient(180deg, ${CREAM} 20%, ${GOLD_LIGHT} 55%, ${GOLD_DEEP} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
                    {winner.name}
                  </span>,
                  <span key="m" style={{ fontSize: 12.5, color: 'rgba(255,246,216,0.78)', lineHeight: 1.7, overflowWrap: 'anywhere' }}>
                    {winner.ticketNo != null ? `中獎劵號 ${winner.ticketNo}・` : ''}{winner.kind === 'member' ? '官網會員・' : winner.kind === 'manual' ? '登記名單・' : ''}獎品 {prize.name}
                  </span>,
                  ...(ticketCountTxt ? [<span key="c" style={{ fontSize: 11, color: 'rgba(255,246,216,0.5)' }}>{ticketCountTxt}</span>] : []),
                ] as const).map((node, i) => (
                  <div
                    key={i}
                    className={reduced ? undefined : 'tds-once'}
                    style={reduced ? undefined : { animation: `tdsRise 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) ${0.5 + i * 0.08}s both` }}
                  >
                    {node}
                  </div>
                ))}
              </>
            )}
            {phase === 'revealed' && !winner && (
              <div style={{ fontSize: 13.5, color: 'rgba(255,246,216,0.75)', lineHeight: 1.8 }}>
                結果核實中 —— 等待伺服器確認中獎者，請稍候。
              </div>
            )}

            {/* 金光掃過一次 */}
            {showWinner && !reduced && (
              <div
                aria-hidden
                className="tds-once"
                style={{
                  position: 'absolute', top: 0, bottom: 0, left: 0, width: '30%', pointerEvents: 'none',
                  background: `linear-gradient(90deg, transparent, rgba(255,246,216,0.5), transparent)`,
                  animation: 'tdsSweep 1.1s cubic-bezier(0.3, 0.1, 0.3, 1) 0.6s both',
                }}
              />
            )}
          </div>
        </div>

        {/* 金屑單次爆開（揭曉限定；減動效冇） */}
        {showWinner && !reduced && <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{sparkEls}</div>}
      </div>

      {/* 可見狀態行（唔好齋靠顏色）＋ aria-live 宣讀 */}
      <div
        role="status"
        aria-live="polite"
        style={{ fontSize: 12, color: phase === 'drawing' ? GOLD_LIGHT : 'rgba(255,246,216,0.65)', lineHeight: 1.7, textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere' }}
      >
        {liveTxt}
      </div>
    </div>
  );
}
