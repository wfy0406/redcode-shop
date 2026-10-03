import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gift, History, Plus, Search, Sparkles, Trash2, Trophy, Upload, Users, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { getToken } from '@/lib/auth';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';

/**
 * v2.2.46 直播抽獎大輪盤（老闆 2026-10-03 指令：「整到好華麗，會直播比客睇」）
 *
 * 佈局：
 * ① 輪盤舞台（左大）：揀獎品（頂部有剩餘件數計數）→ 大金掣抽獎 → 輪盤轉 6 秒（中間滾動客名）→
 *    煙花爆開＋中間彈出中獎客人名 → 會員抽：✓ 冇問題下一件 ／ ✦ 特別重抽 ／ ✕ 取消中獎；
 *    自訂名單抽：手打名中獎 → ✓ 確定中獎（出 0 元單去 WMS）／ ✦ 重抽 ／ ✕ 取消；
 *    官網會員中獎 → server 已彈通知，佢自己揀地址，得 ✦ 重抽 ／ ✕ 取消 ／ ✓ 好，繼續
 * ② 參加名單（右欄，分兩個模式 tab）：
 *    「會員條件名單」——本月消費／累積消費／消費滿$X／官網會員／買過指定產品／
 *    已綁定推送客人（可複選）→ 即睇人數＋名單；
 *    「自訂名單」——揀/建/刪一份名單：手貼客人名＋由官網會員搜尋加入，可混搭
 *    （今日中過嘅 server 自動跳過）
 * ③ 獎品管理（下）：加/減獎品——名、貨號、價錢、上傳圖
 * ④ 中獎紀錄（下）：按抽獎日分組，撳某日展開睇邊個中咩（可取消中獎；
 *    admin 仲可以刪除成筆紀錄，有 0 元單會一併取消）；
 *    confirmed 行按 WMS orderStatus 顯示結案綠燈／審批中琥珀燈
 *
 * 設計鐵律：動畫淨用 transform/opacity（輪盤係 canvas 繪圖，唔係 CSS layout 動畫）；
 * 層次用 DOM 順序唔用 z-index；prefers-reduced-motion → 跳過長旋轉，即刻開獎。
 * 規則：一件獎品一個有效中獎人（抽完就無得抽）；當日一人最多中一件（server 強制）。
 */

// ───────────────────────────── 型別 ─────────────────────────────

type Prize = {
  id: number;
  // 名/圖而家選填（server 會用貨號商品名/官網圖頂上）；舊 data 可能 null → 顯示時用 sku 頂
  name: string | null;
  sku: string;
  price: number;
  imagePath: string | null;
  session: string; // 場次（空字串＝未分場）
  active: boolean;
  drawCount: number;
  takenBy: { name: string; status: string; drawDate: string } | null;
};

type Participant = { id: number; name: string; phone: string };

type DrawResult = {
  draw: { id: number; listId?: number | null };
  // 名單抽獎 winner 有 kind：member＝官網會員（server 彈通知，佢自己揀地址）；manual＝手打名（要出 0 元單）
  winner: { id: number; name: string; phone?: string; kind?: 'member' | 'manual' };
  prize: Prize;
  cancelledDrawId?: number;
};

type NameList = {
  id: number;
  name: string;
  names: string[];
  members: { id: number; name: string }[]; // 由官網會員加入嘅
  createdByName: string;
  createdAt: string | Date;
};

type HistoryRow = {
  id: number;
  status: string;
  drawDate: string;
  createdAt: string | Date;
  redrawOfId: number | null;
  cancelNote: string | null;
  drawnByName: string | null;
  orderId: number | null;
  winnerName: string;
  winnerPhone: string;
  winnerNameSnap: string | null;
  listId: number | null;
  orderStatus: string | null;
  orderNo: string | null;
  prizeId: number;
  prizeName: string;
  prizeSku: string;
  prizePrice: number;
  prizeImagePath: string;
};

/** 錯誤 toast 美化：zod 陣列錯誤係 raw JSON（[{"origin":...}]），拆返第一條 message 出嚟 */
function fmtErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('[{')) {
    try {
      const arr = JSON.parse(msg);
      if (Array.isArray(arr) && arr[0]?.message) return arr[0].message;
    } catch {
      /* fallthrough */
    }
  }
  return msg;
}

// ───────────────────────────── 輪盤（canvas）─────────────────────────────

const WHEEL_SIZE = 600; // canvas 像素（CSS 縮放）
const SEG_COLORS = ['#22103C', '#170B28']; // 深紫金交替（夜空底）
const GOLD = '#F5C518';
const GOLD_SOFT = '#F7D774';
const PINK = '#FF8FBF';

/** 畫輪盤：names 平均分佈；angle＝當前旋轉弧度 */
function drawWheel(ctx: CanvasRenderingContext2D, names: string[], angle: number) {
  const n = Math.max(names.length, 1);
  const cx = WHEEL_SIZE / 2;
  const cy = WHEEL_SIZE / 2;
  const R = WHEEL_SIZE / 2 - 8;
  const seg = (Math.PI * 2) / n;

  ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // 扇形
  for (let i = 0; i < n; i++) {
    const a0 = i * seg;
    const a1 = a0 + seg;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = SEG_COLORS[i % 2];
    ctx.fill();
    ctx.strokeStyle = 'rgba(245,197,24,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 客人名（沿半径寫，最多 6 字）
    const label = (names[i] ?? '').slice(0, 6);
    if (label) {
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${n > 14 ? 17 : 21}px 'Noto Sans TC', sans-serif`;
      ctx.fillStyle = '#F3ECFF';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillText(label, R - 18, 0);
      ctx.restore();
    }
  }

  // 外圈金環＋鉚釘
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 6;
  ctx.stroke();
  const rivets = 24;
  for (let i = 0; i < rivets; i++) {
    const a = (i / rivets) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * R, Math.sin(a) * R, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = GOLD_SOFT;
    ctx.fill();
  }
  // 內圈金線
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.34, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(245,197,24,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** 煙花粒子（開獎嗰刻爆 3 串；金／粉紅／白） */
function launchFireworks(canvas: HTMLCanvasElement, reduced: boolean) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => undefined;
  const W = (canvas.width = canvas.offsetWidth * 2);
  const H = (canvas.height = canvas.offsetHeight * 2);
  type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number };
  const parts: P[] = [];
  const colors = [GOLD, GOLD_SOFT, PINK, '#FFFFFF', '#C4B5FD'];
  const burst = (bx: number, by: number) => {
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 6) * (reduced ? 0.6 : 1);
      parts.push({
        x: bx, y: by,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
        life: 0, max: 60 + Math.random() * 40,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 2 + Math.random() * 3.5,
      });
    }
  };
  burst(W * 0.3, H * 0.32);
  burst(W * 0.7, H * 0.28);
  burst(W * 0.5, H * 0.18);
  let raf = 0;
  let alive = true;
  const tick = () => {
    if (!alive) return;
    ctx.clearRect(0, 0, W, H);
    let active = false;
    for (const p of parts) {
      if (p.life >= p.max) continue;
      active = true;
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.09; // 重力
      p.vx *= 0.985;
      const fade = 1 - p.life / p.max;
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.5 + fade * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (active) raf = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, W, H);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
  };
}

// ───────────────────────────── 主面板 ─────────────────────────────

export default function LuckyDrawPanel({ toast }: { toast: (msg: string, kind?: 'success' | 'error') => void }) {
  const utils = trpc.useUtils();
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // 名單模式：member＝會員條件剔選；list＝自訂名單
  const [mode, setMode] = useState<'member' | 'list'>('member');
  const [selectedListId, setSelectedListId] = useState<number | null>(null);

  // 名單剔選
  const [flt, setFlt] = useState({
    thisMonth: true,
    cumulative: false,
    minSpend: '' as string,
    allMembers: false,
    productId: null as number | null,
    pushBound: false,
    thisMonthMinSpend: '' as string, // 空字串＝唔剔；剔咗先入金額
    newThisMonth: false,
    joinedBefore: '' as string, // YYYY-MM-DD，空＝唔剔
    joinedAfter: '' as string,
  });
  const previewInput = useMemo(
    () => ({
      thisMonth: flt.thisMonth,
      cumulative: flt.cumulative,
      minSpend: flt.minSpend.trim() ? Math.max(0, Math.floor(Number(flt.minSpend) || 0)) : null,
      allMembers: flt.allMembers,
      productId: flt.productId,
      pushBound: flt.pushBound,
      thisMonthMinSpend: flt.thisMonthMinSpend.trim()
        ? Math.max(0, Math.floor(Number(flt.thisMonthMinSpend) || 0))
        : null,
      newThisMonth: flt.newThisMonth,
      joinedBefore: flt.joinedBefore || null,
      joinedAfter: flt.joinedAfter || null,
    }),
    [flt],
  );
  const hasAnySource =
    previewInput.thisMonth || previewInput.cumulative || (previewInput.minSpend ?? 0) > 0 ||
    previewInput.allMembers || previewInput.productId != null || previewInput.pushBound ||
    (previewInput.thisMonthMinSpend ?? 0) > 0 || previewInput.newThisMonth ||
    previewInput.joinedBefore != null || previewInput.joinedAfter != null;
  const participantsQuery = trpc.luckyDraw.adminPreviewParticipants.useQuery(previewInput, {
    enabled: hasAnySource && mode === 'member', // 自訂名單模式唔使預覽會員
    refetchOnWindowFocus: false,
  });
  const participants = (participantsQuery.data?.rows ?? []) as Participant[];

  // 自訂名單
  const listsQuery = trpc.luckyDraw.adminListLists.useQuery(undefined, {
    enabled: mode === 'list',
    refetchOnWindowFocus: false,
  });
  const lists = (listsQuery.data ?? []) as NameList[];
  const selectedList = lists.find((l) => l.id === selectedListId) ?? null;

  // 獎品
  const prizesQuery = trpc.luckyDraw.adminListPrizes.useQuery(undefined, { refetchOnWindowFocus: false });
  const prizes = (prizesQuery.data ?? []) as Prize[];
  // 場次（成個頁共用：揀邊場，獎品池＋獎品管理＋計數都係邊場；空字串＝未分場）
  const [activeSession, setActiveSession] = useState('');
  const sessions = useMemo(() => {
    const set = new Set<string>(prizes.map((p) => p.session ?? ''));
    set.add(activeSession); // 新場次仲未有獎品都要喺下拉見到
    return [...set];
  }, [prizes, activeSession]);
  const sessionPrizes = prizes.filter((p) => (p.session ?? '') === activeSession);
  const availablePrizes = sessionPrizes.filter((p) => p.active && !p.takenBy);
  const activeTotal = sessionPrizes.filter((p) => p.active).length;
  const [prizeId, setPrizeId] = useState<number | null>(null);
  const prize = availablePrizes.find((p) => p.id === prizeId) ?? availablePrizes[0] ?? null;

  // 抽獎狀態機
  const [phase, setPhase] = useState<'idle' | 'spinning' | 'revealed'>('idle');
  const [result, setResult] = useState<DrawResult | null>(null);
  const [lastDrawKind, setLastDrawKind] = useState<'member' | 'manual'>('member');
  const [lastWinnerKind, setLastWinnerKind] = useState<'member' | 'manual'>('member');
  const wheelRef = useRef<HTMLCanvasElement | null>(null);
  const fireworksRef = useRef<HTMLCanvasElement | null>(null);
  const centerNameRef = useRef<HTMLSpanElement | null>(null);
  const spinCleanupRef = useRef<(() => void) | null>(null);
  const inFlightRef = useRef(false);

  const drawMut = trpc.luckyDraw.adminDraw.useMutation();
  const drawManualMut = trpc.luckyDraw.adminDrawManual.useMutation();
  const confirmManualMut = trpc.luckyDraw.adminConfirmManual.useMutation();
  const createListMut = trpc.luckyDraw.adminCreateList.useMutation();
  const deleteListMut = trpc.luckyDraw.adminDeleteList.useMutation();
  const redrawMut = trpc.luckyDraw.adminRedraw.useMutation();
  const cancelMut = trpc.luckyDraw.adminCancelWin.useMutation();
  const deleteDrawMut = trpc.luckyDraw.adminDeleteDraw.useMutation();
  const upsertMut = trpc.luckyDraw.adminUpsertPrize.useMutation();
  const deleteMut = trpc.luckyDraw.adminDeletePrize.useMutation();

  // 輪盤落畫（名單變/角度變都重畫）；自訂名單模式＝手打名＋官網會員名
  const wheelNames = useMemo(() => {
    const names =
      mode === 'list'
        ? [...(selectedList?.names ?? []), ...(selectedList?.members ?? []).map((m) => m.name)]
        : participants.map((p) => p.name);
    // 輪盤最多 20 格：多過就抽樣顯示（抽獎本身係 server 全池隨機，唔受顯示影響）；
    // 開獎時會將中獎人放入輪盤先落畫
    const MAX_SEG = 20;
    if (names.length <= MAX_SEG) return names;
    const shuffled = [...names];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, MAX_SEG);
  }, [mode, selectedList, participants]);
  const wheelNamesRef = useRef<string[]>(wheelNames);
  useEffect(() => {
    wheelNamesRef.current = wheelNames;
  }, [wheelNames]);
  const angleRef = useRef(0);

  const repaint = useCallback(() => {
    const ctx = wheelRef.current?.getContext('2d');
    if (!ctx) return;
    drawWheel(ctx, wheelNamesRef.current, angleRef.current);
  }, []);

  useEffect(() => {
    if (phase === 'idle') repaint();
  }, [repaint, wheelNames, phase]);

  useEffect(() => () => spinCleanupRef.current?.(), []);

  /** 開抽：mutation 攞中獎人 → 輪盤轉去中獎格 → 煙花＋名弹出 */
  const startDraw = async (redrawOf?: DrawResult) => {
    if (!prize || phase === 'spinning') return;
    const manualRedraw = redrawOf != null && lastDrawKind === 'manual';
    if (redrawOf == null) {
      // 人數前置檢查（重抽用 server 舊池，唔使檢查）
      if (mode === 'list') {
        if (selectedListId == null) {
          toast('請先揀一份名單', 'error');
          return;
        }
        const poolSize = (selectedList?.names.length ?? 0) + (selectedList?.members.length ?? 0);
        if (poolSize === 0) {
          toast('名單係空——去右邊揀返或者建立一份名單', 'error');
          return;
        }
      } else if (participants.length === 0) {
        toast('名單係空——先喺右邊剔選來源', 'error');
        return;
      }
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    spinCleanupRef.current?.();
    spinCleanupRef.current = null;
    let res: DrawResult;
    try {
      if (redrawOf) {
        // 自訂名單重抽唔使傳 filter（server 用返舊 draw 嘅 listId 池）
        res = (await redrawMut.mutateAsync(
          manualRedraw ? { drawId: redrawOf.draw.id } : { drawId: redrawOf.draw.id, filter: previewInput },
        )) as unknown as DrawResult;
      } else if (mode === 'list' && selectedListId != null) {
        setLastDrawKind('manual');
        res = (await drawManualMut.mutateAsync({ prizeId: prize.id, listId: selectedListId })) as unknown as DrawResult;
      } else {
        setLastDrawKind('member');
        res = (await drawMut.mutateAsync({ prizeId: prize.id, filter: previewInput })) as unknown as DrawResult;
      }
    } catch (e) {
      inFlightRef.current = false;
      toast(fmtErr(e), 'error');
      return;
    }
    // 記低中獎人係官網會員定手打名（result card 分支用）；server 冇回 kind 就按抽獎模式推斷
    setLastWinnerKind(res.winner.kind ?? (redrawOf != null ? lastDrawKind : mode === 'list' ? 'manual' : 'member'));
    setResult(res);
    setPhase('spinning');
    inFlightRef.current = false; // 開始動畫後由 phase==='spinning' 擋雙擊

    // 輪盤格：中獎人一定要喺輪盤上（替換第一格）
    const names = [...wheelNamesRef.current];
    const winnerIdx = (() => {
      const at = names.indexOf(res.winner.name);
      if (at >= 0) return at;
      if (names.length === 0) {
        names.push(res.winner.name);
        return 0;
      }
      names[0] = res.winner.name;
      return 0;
    })();

    const canvas = wheelRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      setPhase('revealed');
      return;
    }

    const n = Math.max(names.length, 1);
    const seg = (Math.PI * 2) / n;
    // 指針喺頂（-90°）：中獎格中心要停喺度
    let target = -Math.PI / 2 - (winnerIdx * seg + seg / 2);
    const startAngle = angleRef.current;
    // normalize：保證 target ≥ startAngle + minTurns 圈，避免 target-startAngle 負數令輪盤反轉
    const twoPi = Math.PI * 2;
    const minTurns = reducedMotion ? 0 : 6;
    target += Math.max(0, Math.ceil((startAngle + minTurns * twoPi - target) / twoPi)) * twoPi;
    const duration = reducedMotion ? 600 : 6000;
    const t0 = performance.now();

    // 中間滾動客名（直接寫 DOM，唔經 React re-render）
    const roller = window.setInterval(() => {
      if (centerNameRef.current && names.length > 0) {
        centerNameRef.current.textContent = names[Math.floor(Math.random() * names.length)];
      }
    }, 70);

    const easeOut = (x: number) => 1 - Math.pow(1 - x, 5);
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      angleRef.current = startAngle + (target - startAngle) * easeOut(p);
      drawWheel(ctx, names, angleRef.current);
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        window.clearInterval(roller);
        if (centerNameRef.current) centerNameRef.current.textContent = res.winner.name;
        setPhase('revealed');
        wheelNamesRef.current = names;
        const fw = fireworksRef.current;
        if (fw) {
          spinCleanupRef.current?.();
          spinCleanupRef.current = launchFireworks(fw, reducedMotion);
        }
        // reveal 嗰刻唔好 invalidate preview（會即時踢走中獎人 → 輪盤名跳）；留返 finishAndNext 做
        void utils.luckyDraw.adminListPrizes.invalidate();
        void utils.luckyDraw.adminHistory.invalidate();
      }
    };
    raf = requestAnimationFrame(tick);
    spinCleanupRef.current = () => {
      cancelAnimationFrame(raf);
      window.clearInterval(roller);
    };
  };

  const finishAndNext = () => {
    spinCleanupRef.current?.();
    spinCleanupRef.current = null;
    setResult(null);
    setPhase('idle');
    setPrizeId(null); // 跳返第一件未抽出嘅獎品
    void utils.luckyDraw.adminPreviewParticipants.invalidate();
  };

  const cancelWin = async (drawId: number, label: string) => {
    if (!window.confirm(`真係取消 ${label} 嘅中獎？客人會即刻睇唔到中獎。`)) return;
    try {
      const r = await cancelMut.mutateAsync({ drawId });
      toast(r.orderCancelled ? '已取消中獎＋相關訂單（WMS 嗰邊記得人手拒絕）' : '已取消中獎', 'success');
      if (result?.draw.id === drawId) finishAndNext();
      void utils.luckyDraw.adminListPrizes.invalidate();
      void utils.luckyDraw.adminHistory.invalidate();
    } catch (e) {
      toast(fmtErr(e), 'error');
    }
  };

  /** 自訂名單抽獎：確定中獎 → server 出 0 元單去 WMS → 抽下一件 */
  const confirmManual = async (drawId: number) => {
    try {
      const r = await confirmManualMut.mutateAsync({ drawId });
      toast(`訂單 ${r.orderNo} 已飛去 WMS 等審批`, 'success');
      void utils.luckyDraw.adminHistory.invalidate();
      void utils.luckyDraw.adminListPrizes.invalidate();
      finishAndNext();
    } catch (e) {
      toast(fmtErr(e), 'error');
    }
  };

  /** 建立自訂名單（手打名＋官網會員混搭）：成功 → invalidate＋自動揀新嗰份（回新 list id 俾 form 清場） */
  const createList = async (name: string, names: string[], memberIds: number[]): Promise<number | null> => {
    try {
      const r = (await createListMut.mutateAsync({ name, names, memberIds })) as unknown as NameList;
      const total = (r.names?.length ?? names.length) + (r.members?.length ?? memberIds.length);
      toast(`名單「${name}」已建立（${total} 人）`, 'success');
      void utils.luckyDraw.adminListLists.invalidate();
      setSelectedListId(r.id);
      return r.id;
    } catch (e) {
      toast(fmtErr(e), 'error');
      return null;
    }
  };

  /** 刪自訂名單（confirm 由 picker 做）；刪緊揀中嗰份就清 selection */
  const deleteList = async (listId: number) => {
    try {
      await deleteListMut.mutateAsync({ listId });
      toast('名單已刪除', 'success');
      if (selectedListId === listId) setSelectedListId(null);
      void utils.luckyDraw.adminListLists.invalidate();
    } catch (e) {
      toast(fmtErr(e), 'error');
    }
  };

  /** 刪除抽獎紀錄（admin only；supervisor 會被 server FORBIDDEN 擋，錯誤 toast 照舊） */
  const deleteDraw = async (drawId: number, orderNo: string | null) => {
    if (
      !window.confirm(`確定刪除呢筆抽獎紀錄？${orderNo ? '（連官網張 0 元訂單一併刪除，刪咗唔返得轉）' : ''}`)
    ) {
      return;
    }
    try {
      await deleteDrawMut.mutateAsync({ drawId });
      toast('紀錄已刪除', 'success');
      // 獎品會返返嚟剩餘池 → 計數要啱
      void utils.luckyDraw.adminHistory.invalidate();
      void utils.luckyDraw.adminListPrizes.invalidate();
    } catch (e) {
      toast(fmtErr(e), 'error');
    }
  };

  // ───────────────────────────── Render ─────────────────────────────

  const stageLabel =
    phase === 'spinning' ? '抽緊…' : phase === 'revealed' && result ? result.winner.name : '準備就緒';

  return (
    <div className="space-y-6">
      {/* ════════ ① 輪盤舞台 ════════ */}
      <section
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
          <Sparkles size={16} aria-hidden="true" className="text-gold" />
          直播抽獎大輪盤
          <span className="font-mono text-[12px] font-normal text-txt-3">
            （一件獎品一個中獎人・當日一人最多中一件）
          </span>
        </h3>

        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_340px]">
          {/* 左：輪盤 */}
          <div className="flex flex-col items-center">
            {/* 場次選擇（成個頁共用：轉場次＝轉獎品池，「下拉列轉場次產品繼續抽」） */}
            <p className="mb-2 flex w-full items-center justify-center gap-2 text-[12.5px] text-txt-2">
              場次
              <SessionSelect sessions={sessions} value={activeSession} onChange={setActiveSession} />
            </p>

            {/* 剩餘獎品計數（按場次計；確定咗就會又減一件） */}
            <p className="mb-2 w-full text-center font-serif-tc text-[15px] font-bold text-gold">
              呢場剩餘 {availablePrizes.length} 件（總共 {activeTotal} 件）
            </p>

            {/* 揀獎品（未抽出嘅先抽得） */}
            <div className="flex w-full flex-wrap items-center justify-center gap-2">
              {availablePrizes.length === 0 ? (
                <p className="py-2 text-[13px] text-txt-3">
                  呢場冇抽得嘅獎品——去下面「獎品管理」加返，或者轉場次繼續抽
                </p>
              ) : (
                availablePrizes.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => phase === 'idle' && setPrizeId(p.id)}
                    disabled={phase !== 'idle'}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] transition-colors disabled:opacity-60 ${
                      prize?.id === p.id ? 'text-txt-1' : 'text-txt-2 hover:text-txt-1'
                    }`}
                    style={{
                      borderColor: prize?.id === p.id ? GOLD : 'var(--space-line)',
                      background: prize?.id === p.id ? 'rgba(245,197,24,0.12)' : 'transparent',
                    }}
                  >
                    {p.imagePath ? (
                      <img src={p.imagePath} alt="" className="h-6 w-6 rounded-full object-cover" />
                    ) : (
                      <span
                        className="flex h-6 w-6 items-center justify-center rounded-full border text-txt-3"
                        style={{ borderColor: 'var(--space-line)' }}
                      >
                        <Gift size={12} aria-hidden="true" />
                      </span>
                    )}
                    {p.name || p.sku}
                    <span className="font-mono text-[11px] text-txt-3">HK${p.price}</span>
                  </button>
                ))
              )}
            </div>

            {/* 輪盤本體（煙花層喺 DOM 後出，自然壓頂，唔用 z-index） */}
            <div className="relative mt-4 w-full max-w-[560px]">
              <div className="relative mx-auto aspect-square w-full max-w-[560px]">
                {/* 頂部金指針 */}
                <div
                  aria-hidden="true"
                  className="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 -translate-y-1 border-x-[14px] border-t-[22px] border-x-transparent"
                  style={{ borderTopColor: GOLD, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
                />
                <canvas ref={wheelRef} width={WHEEL_SIZE} height={WHEEL_SIZE} className="h-full w-full" />
                {/* 中間名顯示 */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className="flex h-[34%] w-[34%] items-center justify-center rounded-full border-2 text-center"
                    style={{
                      borderColor: GOLD,
                      background: 'radial-gradient(circle at 50% 35%, #2B1548 0%, #120C24 70%)',
                      boxShadow: '0 0 40px rgba(245,197,24,0.25), inset 0 0 24px rgba(0,0,0,0.6)',
                    }}
                  >
                    <span
                      ref={centerNameRef}
                      className={`px-2 font-serif-tc font-bold leading-tight text-gold ${
                        phase === 'revealed' ? 'text-[26px] md:text-[30px]' : 'text-[18px] md:text-[22px]'
                      }`}
                      style={{
                        textShadow: '0 0 18px rgba(245,197,24,0.65)',
                        transition: 'transform 300ms, opacity 300ms',
                        transform: phase === 'revealed' ? 'scale(1.12)' : 'scale(1)',
                      }}
                    >
                      {stageLabel}
                    </span>
                  </div>
                </div>
                {/* 煙花層（最後出 → 壓頂） */}
                <canvas ref={fireworksRef} className="pointer-events-none absolute inset-0 h-full w-full" />
              </div>
            </div>

            {/* 抽獎大金掣 */}
            {phase !== 'revealed' ? (
              <button
                type="button"
                onClick={() => void startDraw()}
                disabled={
                  !prize ||
                  phase === 'spinning' ||
                  (mode === 'list'
                    ? (selectedList?.names.length ?? 0) + (selectedList?.members.length ?? 0) === 0
                    : participants.length === 0) ||
                  drawMut.isPending ||
                  drawManualMut.isPending
                }
                className="mt-5 rounded-full px-10 py-3.5 font-serif-tc text-[17px] font-bold tracking-[0.2em] transition-opacity disabled:opacity-40"
                style={{
                  background: `linear-gradient(160deg, ${GOLD_SOFT} 0%, ${GOLD} 55%, #C99B0F 100%)`,
                  color: '#241505',
                  boxShadow: '0 6px 30px rgba(245,197,24,0.35)',
                }}
              >
                {phase === 'spinning' ? '✦ 抽緊…' : drawMut.isPending || drawManualMut.isPending ? '請緊…' : '✦ 開始抽獎 ✦'}
              </button>
            ) : null}

            {/* 開獎結果卡 */}
            {phase === 'revealed' && result && (
              <div
                className="mt-5 w-full max-w-[520px] rounded-2xl border p-5 text-center"
                style={{
                  borderColor: 'rgba(245,197,24,0.55)',
                  background: 'linear-gradient(180deg, rgba(245,197,24,0.10), rgba(245,197,24,0.03))',
                  boxShadow: '0 0 50px rgba(245,197,24,0.18)',
                  animation: reducedMotion ? undefined : 'luckyPop 420ms cubic-bezier(0.2,1.4,0.4,1)',
                }}
              >
                <p className="script text-2xl text-gold">Congratulations ✦</p>
                <p className="mt-1 font-serif-tc text-[26px] font-bold text-txt-1">
                  {result.winner.name}
                </p>
                {result.winner.phone && (
                  <p className="mt-0.5 font-mono text-[13px] text-txt-3">{result.winner.phone}</p>
                )}
                <div className="mt-3 flex items-center justify-center gap-3">
                  {result.prize.imagePath ? (
                    <img
                      src={result.prize.imagePath}
                      alt={result.prize.name ?? result.prize.sku}
                      className="h-14 w-14 rounded-xl border object-cover"
                      style={{ borderColor: 'rgba(245,197,24,0.4)' }}
                    />
                  ) : (
                    <span
                      className="flex h-14 w-14 items-center justify-center rounded-xl border text-txt-3"
                      style={{ borderColor: 'rgba(245,197,24,0.4)' }}
                    >
                      <Gift size={20} aria-hidden="true" />
                    </span>
                  )}
                  <div className="text-left">
                    <p className="text-[14px] font-semibold text-txt-1">{result.prize.name || result.prize.sku}</p>
                    <p className="font-mono text-[12px] text-txt-3">
                      {result.prize.sku}・價值 HK${result.prize.price}
                    </p>
                  </div>
                </div>
                {lastDrawKind === 'manual' ? (
                  lastWinnerKind === 'member' ? (
                    <p className="mt-3 text-[14px] text-txt-2">
                      佢係官網會員——已彈中獎通知同寄 email，等佢自己登入揀地址寄送。
                    </p>
                  ) : (
                    <p className="mt-3 text-[12px] text-txt-3">
                      自訂名單抽獎：確定後會即出 0 元訂單飛去 WMS 等審批。
                    </p>
                  )
                ) : (
                  <p className="mt-3 text-[12px] text-txt-3">
                    已即時寄中獎 email＋推送畀客人；客人登入會見到中獎賀卡揀地址。
                  </p>
                )}
                <p className="mt-1.5 text-[14px] text-txt-2">
                  呢件抽完，仲剩 {availablePrizes.length} 件獎品
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {lastDrawKind === 'manual' ? (
                    <>
                      {lastWinnerKind === 'manual' ? (
                        <button
                          type="button"
                          onClick={() => void confirmManual(result.draw.id)}
                          disabled={confirmManualMut.isPending}
                          className="rounded-full px-5 py-2 text-[13.5px] font-bold disabled:opacity-40"
                          style={{ background: GOLD, color: '#241505' }}
                        >
                          ✓ 確定中獎（出 0 元單去 WMS）
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={finishAndNext}
                          className="rounded-full px-5 py-2 text-[13.5px] font-bold"
                          style={{ background: GOLD, color: '#241505' }}
                        >
                          ✓ 好，繼續
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void startDraw(result)}
                        disabled={redrawMut.isPending}
                        className="rounded-full border px-5 py-2 text-[13.5px] text-gold transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: 'rgba(245,197,24,0.55)' }}
                      >
                        ✦ 重抽
                      </button>
                      <button
                        type="button"
                        onClick={() => void cancelWin(result.draw.id, result.winner.name)}
                        disabled={cancelMut.isPending}
                        className="rounded-full border px-5 py-2 text-[13.5px] text-pink-soft transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: 'rgba(255,0,84,0.4)' }}
                      >
                        ✕ 取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={finishAndNext}
                        className="rounded-full px-5 py-2 text-[13.5px] font-bold"
                        style={{ background: GOLD, color: '#241505' }}
                      >
                        ✓ 冇問題，抽下一件
                      </button>
                      <button
                        type="button"
                        onClick={() => void startDraw(result)}
                        disabled={redrawMut.isPending}
                        className="rounded-full border px-5 py-2 text-[13.5px] text-gold transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: 'rgba(245,197,24,0.55)' }}
                      >
                        ✦ 中獎人唔啱・特別重抽
                      </button>
                      <button
                        type="button"
                        onClick={() => void cancelWin(result.draw.id, result.winner.name)}
                        disabled={cancelMut.isPending}
                        className="rounded-full border px-5 py-2 text-[13.5px] text-pink-soft transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: 'rgba(255,0,84,0.4)' }}
                      >
                        ✕ 取消中獎
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右：名單剔選 */}
          <aside
            className="rounded-2xl border p-4"
            style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.02)' }}
          >
            <p className="flex items-center gap-2 text-[13.5px] font-bold text-txt-1">
              <Users size={14} aria-hidden="true" className="text-lavender" />
              參加名單
            </p>

            {/* 模式切換（文字制 segmented tab：active 2px 金底線） */}
            <div className="mt-2 flex gap-5 border-b" style={{ borderColor: 'var(--space-line)' }}>
              {(
                [
                  ['member', '會員條件名單'],
                  ['list', '自訂名單'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`-mb-px border-b-2 pb-2 text-[13px] transition-colors ${
                    mode === m ? 'font-semibold text-txt-1' : 'text-txt-3 hover:text-txt-2'
                  }`}
                  style={{ borderColor: mode === m ? GOLD : 'transparent' }}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'member' ? (
              <>
            <div className="mt-3 space-y-2 text-[13px] text-txt-2">
              {(
                [
                  ['thisMonth', '本月消費嘅客人'],
                  ['cumulative', '累積消費過嘅客人'],
                  ['allMembers', '官網全部會員'],
                  ['pushBound', '已綁定推送嘅客人'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={flt[key]}
                    onChange={(e) => setFlt((s) => ({ ...s, [key]: e.target.checked }))}
                    className="h-4 w-4 accent-[#F5C518]"
                  />
                  {label}
                </label>
              ))}
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={flt.minSpend.trim() !== ''}
                  onChange={(e) =>
                    setFlt((s) => ({ ...s, minSpend: e.target.checked ? '1000' : '' }))
                  }
                  className="h-4 w-4 accent-[#F5C518]"
                />
                消費滿 HK$
                <input
                  type="number"
                  min={0}
                  value={flt.minSpend}
                  onChange={(e) => setFlt((s) => ({ ...s, minSpend: e.target.value }))}
                  placeholder="1000"
                  className="w-24 rounded-lg border bg-transparent px-2 py-1 text-[13px] text-txt-1 outline-none focus:border-lavender"
                  style={{ borderColor: 'var(--space-line)' }}
                />
              </label>
              <ProductPicker
                value={flt.productId}
                onChange={(id) => setFlt((s) => ({ ...s, productId: id }))}
              />
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={flt.thisMonthMinSpend.trim() !== ''}
                  onChange={(e) =>
                    setFlt((s) => ({ ...s, thisMonthMinSpend: e.target.checked ? '1000' : '' }))
                  }
                  className="h-4 w-4 accent-[#F5C518]"
                />
                本月消費滿 HK$
                <input
                  type="number"
                  min={0}
                  value={flt.thisMonthMinSpend}
                  onChange={(e) => setFlt((s) => ({ ...s, thisMonthMinSpend: e.target.value }))}
                  placeholder="1000"
                  disabled={flt.thisMonthMinSpend.trim() === ''}
                  className="w-24 rounded-lg border bg-transparent px-2 py-1 text-[13px] text-txt-1 outline-none focus:border-lavender disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                />
              </label>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={flt.newThisMonth}
                  onChange={(e) => setFlt((s) => ({ ...s, newThisMonth: e.target.checked }))}
                  className="h-4 w-4 accent-[#F5C518]"
                />
                本月新客戶
              </label>
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={flt.joinedBefore !== ''}
                  onChange={(e) =>
                    setFlt((s) => ({ ...s, joinedBefore: e.target.checked ? new Date().toISOString().slice(0, 10) : '' }))
                  }
                  className="h-4 w-4 accent-[#F5C518]"
                />
                <input
                  type="date"
                  value={flt.joinedBefore}
                  onChange={(e) => setFlt((s) => ({ ...s, joinedBefore: e.target.value }))}
                  disabled={flt.joinedBefore === ''}
                  className="rounded-lg border bg-transparent px-2 py-1 text-[12.5px] text-txt-1 outline-none focus:border-lavender disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                />
                之前註冊嘅客人
              </label>
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={flt.joinedAfter !== ''}
                  onChange={(e) =>
                    setFlt((s) => ({ ...s, joinedAfter: e.target.checked ? new Date().toISOString().slice(0, 10) : '' }))
                  }
                  className="h-4 w-4 accent-[#F5C518]"
                />
                <input
                  type="date"
                  value={flt.joinedAfter}
                  onChange={(e) => setFlt((s) => ({ ...s, joinedAfter: e.target.value }))}
                  disabled={flt.joinedAfter === ''}
                  className="rounded-lg border bg-transparent px-2 py-1 text-[12.5px] text-txt-1 outline-none focus:border-lavender disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                />
                或之後註冊嘅客人
              </label>
            </div>

            <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--space-line)' }}>
              {!hasAnySource ? (
                <p className="text-[12.5px] text-txt-3">剔選至少一個來源先有名單</p>
              ) : participantsQuery.isLoading ? (
                <LoadingBlock text="許願星數緊人…" />
              ) : (
                <>
                  <p className="text-[13px] text-txt-1">
                    合資格 <b className="text-gold">{participantsQuery.data?.total ?? 0}</b> 人
                    <span className="text-txt-3">（今日中過嘅已自動踢走）</span>
                  </p>
                  <ul className="mt-2 max-h-[220px] space-y-1 overflow-y-auto pr-1">
                    {participants.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-[12.5px]"
                        style={{ borderColor: 'var(--space-line)' }}
                      >
                        <span className="text-txt-1">{p.name}</span>
                        <span className="font-mono text-[11px] text-txt-3">{p.phone}</span>
                      </li>
                    ))}
                  </ul>
                  {(participantsQuery.data?.total ?? 0) > participants.length && (
                    <p className="mt-1 text-[11.5px] text-txt-3">
                      名單太長，呢度淨顯示首 {participants.length} 人；抽獎係全池隨機。
                    </p>
                  )}
                </>
              )}
            </div>
              </>
            ) : (
              <NameListPicker
                lists={lists}
                loading={listsQuery.isLoading}
                selectedListId={selectedListId}
                busy={createListMut.isPending || deleteListMut.isPending}
                toast={toast}
                onSelect={(id) => setSelectedListId(id)}
                onCreate={createList}
                onDelete={(id) => void deleteList(id)}
              />
            )}
          </aside>
        </div>
      </section>

      {/* 開獎彈出動畫 keyframes（transform/opacity only，跟設計鐵律） */}
      <style>{`@keyframes luckyPop { 0% { transform: scale(0.7); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }`}</style>

      {/* ════════ ③ 獎品管理 ════════ */}
      <PrizeManagerSection
        prizes={sessionPrizes}
        loading={prizesQuery.isLoading}
        busy={upsertMut.isPending || deleteMut.isPending}
        activeSession={activeSession}
        sessions={sessions}
        onSessionChange={setActiveSession}
        onSave={async (input) => {
          try {
            await upsertMut.mutateAsync(input);
            toast(input.id ? '獎品已更新' : '獎品已加入', 'success');
            void utils.luckyDraw.adminListPrizes.invalidate();
            return true;
          } catch (e) {
            toast(fmtErr(e), 'error');
            return false;
          }
        }}
        onDelete={async (id) => {
          try {
            await deleteMut.mutateAsync({ id });
            toast('獎品已刪除', 'success');
            void utils.luckyDraw.adminListPrizes.invalidate();
          } catch (e) {
            toast(fmtErr(e), 'error');
          }
        }}
      />

      {/* ════════ ④ 中獎紀錄（按日展開） ════════ */}
      <DrawHistorySection
        toast={toast}
        onCancel={(id, label) => void cancelWin(id, label)}
        cancelling={cancelMut.isPending}
        onDelete={(id, orderNo) => void deleteDraw(id, orderNo)}
        deleting={deleteDrawMut.isPending}
      />
    </div>
  );
}

// ───────────────────────────── 產品揀選（買過指定產品） ─────────────────────────────

function ProductPicker({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [q, setQ] = useState('');
  const productsQuery = trpc.products.adminList.useQuery(undefined, { refetchOnWindowFocus: false });
  const list = (productsQuery.data ?? []) as { id: number; name: string; sku: string }[];
  const kw = q.trim().toLowerCase();
  const hits = kw
    ? list.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(kw)).slice(0, 8)
    : [];
  const chosen = value != null ? list.find((p) => p.id === value) : null;

  return (
    <div>
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={value != null}
          onChange={(e) => onChange(e.target.checked ? (list[0]?.id ?? null) : null)}
          className="h-4 w-4 accent-[#F5C518]"
        />
        買過指定官網產品
      </label>
      {value != null && (
        <div className="ml-6 mt-1.5">
          {chosen && (
            <span
              className="mb-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] text-gold"
              style={{ borderColor: 'rgba(245,197,24,0.4)' }}
            >
              {chosen.name}
              <button
                type="button"
                aria-label="清除產品"
                onClick={() => onChange(null)}
                className="text-txt-3 hover:text-txt-1"
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          )}
          <div className="relative">
            <Search
              size={13}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-3"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="輸入產品名或貨號…"
              className="w-full rounded-lg border bg-transparent py-1.5 pl-8 pr-2 text-[12.5px] text-txt-1 outline-none focus:border-lavender"
              style={{ borderColor: 'var(--space-line)' }}
            />
          </div>
          {hits.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {hits.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p.id);
                      setQ('');
                    }}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] text-txt-2 transition-colors hover:bg-white/5 hover:text-txt-1"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    {p.name}
                    <span className="ml-2 font-mono text-[11px] text-txt-3">{p.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── 自訂名單（picker＋建立） ─────────────────────────────

/** 批量貼上 parse：換行／逗號（中/英）／頓號／分號（中/英）／空白分隔 → trim → 去空 → 去重（保留原串，大小寫唔分） */
function parseListNames(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\n,，、;；\s]+/)) {
    const name = piece.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function NameListPicker({
  lists,
  loading,
  selectedListId,
  busy,
  toast,
  onSelect,
  onCreate,
  onDelete,
}: {
  lists: NameList[];
  loading: boolean;
  selectedListId: number | null;
  busy: boolean;
  toast: (msg: string, kind?: 'success' | 'error') => void;
  onSelect: (id: number) => void;
  onCreate: (name: string, names: string[], memberIds: number[]) => Promise<number | null>;
  onDelete: (listId: number) => void;
}) {
  const [listName, setListName] = useState('');
  const [rawNames, setRawNames] = useState('');
  // 「由官網會員加入」：搜尋（300ms debounce，跟 MemberList 做法）＋已揀 chips
  const [memberQ, setMemberQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [pickedMembers, setPickedMembers] = useState<{ id: number; name: string; phone: string }[]>([]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(memberQ.trim()), 300);
    return () => window.clearTimeout(t);
  }, [memberQ]);
  const memberSearchQuery = trpc.members.list.useQuery(debouncedQ ? { q: debouncedQ } : undefined, {
    enabled: debouncedQ.length > 0,
    refetchOnWindowFocus: false,
  });
  const memberHits = ((memberSearchQuery.data ?? []) as { id: number; name: string; phone: string }[])
    .filter((m) => !pickedMembers.some((p) => p.id === m.id))
    .slice(0, 8);
  const selected = lists.find((l) => l.id === selectedListId) ?? null;

  const submit = async () => {
    const name = listName.trim();
    const names = parseListNames(rawNames);
    if (!name) {
      toast('名單名都要填', 'error');
      return;
    }
    if (names.length === 0 && pickedMembers.length === 0) {
      toast('名單係空——貼返啲客人名，或者由官網會員加入', 'error');
      return;
    }
    const id = await onCreate(name, names, pickedMembers.map((m) => m.id));
    if (id != null) {
      setListName('');
      setRawNames('');
      setPickedMembers([]);
      setMemberQ('');
    }
  };

  return (
    <div className="mt-3">
      {/* 名單 picker（chips 橫排） */}
      {loading ? (
        <LoadingBlock text="許願星搬緊名單…" />
      ) : lists.length === 0 ? (
        <p className="text-[12.5px] text-txt-3">仲未有自訂名單，下面建立第一份 ✦</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {lists.map((l) => {
            const active = l.id === selectedListId;
            return (
              <span
                key={l.id}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px]"
                style={{
                  borderColor: active ? GOLD : 'var(--space-line)',
                  background: active ? 'rgba(245,197,24,0.12)' : 'transparent',
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(l.id)}
                  className={active ? 'text-txt-1' : 'text-txt-2 hover:text-txt-1'}
                >
                  {l.name}
                  <span className="ml-1 font-mono text-[11px] text-txt-3">
                    （{l.names.length + l.members.length} 人）
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`刪除名單「${l.name}」？（唔會影響已抽嘅紀錄）`)) onDelete(l.id);
                  }}
                  className="text-[11px] text-txt-3 underline-offset-2 transition-colors hover:text-pink-soft hover:underline disabled:opacity-40"
                >
                  刪除
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* 揀中名單 → 手打名 chips（淡金邊）＋官網會員 chips（金邊＋✦ 記認） */}
      {selected && (
        <div className="mt-3">
          <p className="text-[13px] text-txt-1">
            名單共 <b className="text-gold">{selected.names.length + selected.members.length}</b> 人
            <span className="text-txt-3">（{selected.members.length} 位官網會員）</span>
          </p>
          <div className="mt-2 flex max-h-[180px] flex-wrap gap-1.5 overflow-y-auto pr-1">
            {selected.members.map((m) => (
              <span
                key={`m-${m.id}`}
                className="rounded-full border px-2 py-0.5 text-[12px] text-gold"
                style={{ borderColor: 'rgba(245,197,24,0.6)' }}
              >
                ✦ {m.name}
              </span>
            ))}
            {selected.names.map((n) => (
              <span
                key={n}
                className="rounded-full border px-2 py-0.5 text-[12px] text-txt-2"
                style={{ borderColor: 'rgba(245,197,24,0.28)' }}
              >
                {n}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[14px] text-txt-3">今日中過嘅人會自動跳過</p>
        </div>
      )}

      {/* 建立名單 form */}
      <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--space-line)' }}>
        <input
          value={listName}
          onChange={(e) => setListName(e.target.value)}
          placeholder="例：10月3日直播 VIP 場"
          className="w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-[13px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <textarea
          value={rawNames}
          onChange={(e) => setRawNames(e.target.value)}
          placeholder="一行一個客人名，或者用逗號／空格分隔批量貼上"
          rows={4}
          className="w-full resize-y rounded-lg border bg-transparent px-2.5 py-1.5 text-[13px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />

        {/* 由官網會員加入（可同手打名混搭） */}
        <div className="relative">
          <Search
            size={13}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-3"
          />
          <input
            value={memberQ}
            onChange={(e) => setMemberQ(e.target.value)}
            placeholder="由官網會員加入：輸入會員名或電話搜尋…"
            className="w-full rounded-lg border bg-transparent py-1.5 pl-8 pr-2 text-[13px] text-txt-1 outline-none focus:border-lavender"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </div>
        {debouncedQ.length > 0 && (
          <ul className="space-y-0.5">
            {memberSearchQuery.isLoading ? (
              <li className="px-2 py-1 text-[12px] text-txt-3">搜緊…</li>
            ) : memberHits.length === 0 ? (
              <li className="px-2 py-1 text-[12px] text-txt-3">搵唔到「{debouncedQ}」嘅會員</li>
            ) : (
              memberHits.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPickedMembers((s) => [...s, m]);
                      setMemberQ('');
                    }}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] text-txt-2 transition-colors hover:bg-white/5 hover:text-txt-1"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    {m.name}
                    <span className="ml-2 font-mono text-[11px] text-txt-3">{m.phone}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {pickedMembers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pickedMembers.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] text-gold"
                style={{ borderColor: 'rgba(245,197,24,0.5)' }}
              >
                ✦ {m.name}
                <span className="font-mono text-[10.5px] text-txt-3">{m.phone}</span>
                <button
                  type="button"
                  aria-label={`移除會員 ${m.name}`}
                  onClick={() => setPickedMembers((s) => s.filter((p) => p.id !== m.id))}
                  className="text-txt-3 hover:text-txt-1"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#241505' }}
        >
          <Plus size={14} aria-hidden="true" />
          建立名單
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────── 場次選擇（主抽獎區＋獎品管理共用 state） ─────────────────────────────

/** 文字制下拉：現有 distinct 場次（空字串顯示「未分場」）＋「＋ 新場次」（揀咗彈 input 輸入場次名） */
function SessionSelect({
  sessions,
  value,
  onChange,
}: {
  sessions: string[];
  value: string;
  onChange: (session: string) => void;
}) {
  const [making, setMaking] = useState(false);
  const [newName, setNewName] = useState('');
  const options = useMemo(() => {
    const set = new Set<string>(['', ...sessions]);
    set.add(value); // 新場次仲未有獎品都要顯示得到
    return [...set];
  }, [sessions, value]);

  const commit = () => {
    const v = newName.trim();
    if (v) onChange(v);
    setMaking(false);
    setNewName('');
  };

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={making ? '__new__' : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__new__') {
            setMaking(true);
            setNewName('');
          } else {
            setMaking(false);
            onChange(v);
          }
        }}
        aria-label="選擇場次"
        className="rounded-lg border bg-transparent px-2 py-1 text-[12.5px] text-txt-1 outline-none focus:border-lavender"
        style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.04)' }}
      >
        {options.map((s) => (
          <option key={s === '' ? '__none__' : s} value={s}>
            {s === '' ? '未分場' : s}
          </option>
        ))}
        <option value="__new__">＋ 新場次</option>
      </select>
      {making && (
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setMaking(false);
              setNewName('');
            }
          }}
          onBlur={commit}
          placeholder="場次名，例：10月3日 晚場"
          className="w-44 rounded-lg border bg-transparent px-2 py-1 text-[12.5px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: GOLD }}
        />
      )}
    </span>
  );
}

// ───────────────────────────── 獎品管理 ─────────────────────────────

function PrizeManagerSection({
  prizes,
  loading,
  busy,
  activeSession,
  sessions,
  onSessionChange,
  onSave,
  onDelete,
}: {
  prizes: Prize[];
  loading: boolean;
  busy: boolean;
  activeSession: string;
  sessions: string[];
  onSessionChange: (session: string) => void;
  onSave: (input: {
    id?: number;
    name?: string;
    sku: string;
    price: number;
    imagePath?: string;
    session: string;
  }) => Promise<boolean>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { authorization: `Bearer ${getToken() ?? ''}` },
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok || !data.path) throw new Error(data.error ?? `HTTP ${res.status}`);
      setImagePath(data.path);
    } catch (e) {
      setErr(fmtErr(e));
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    const p = Math.floor(Number(price));
    // 名/圖選填（server 會用貨號商品名/官網圖頂上）；淨係貨號同價錢必填
    if (!sku.trim() || !Number.isFinite(p) || p < 0) {
      setErr('貨號同價錢（0 或以上）必填');
      return;
    }
    const ok = await onSave({
      name: name.trim(),
      sku: sku.trim(),
      price: p,
      imagePath,
      session: activeSession, // 自動帶入而家揀咗嘅場次（新場次就用新名）
    });
    if (ok) {
      setName('');
      setSku('');
      setPrice('');
      setImagePath('');
      setErr(null);
    }
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-txt-1">
        <Gift size={16} aria-hidden="true" className="text-gold" />
        獎品管理
        <span className="font-mono text-[12px] font-normal text-txt-3">（可加可減；抽中咗嘅會標示）</span>
        <span className="ml-auto flex items-center gap-2 text-[12.5px] font-normal text-txt-2">
          場次
          <SessionSelect sessions={sessions} value={activeSession} onChange={onSessionChange} />
        </span>
      </h3>
      {/* 剩餘獎品計數按場次計 */}
      <p className="mt-1.5 font-mono text-[12px] text-txt-3">
        呢場剩餘 {prizes.filter((p) => p.active && !p.takenBy).length} 件（總共{' '}
        {prizes.filter((p) => p.active).length} 件）
      </p>

      {/* 新增獎品 */}
      <div
        className="mt-4 grid gap-3 rounded-xl border p-4 md:grid-cols-[140px_1fr_160px_120px_auto]"
        style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.02)' }}
      >
        <div className="flex flex-col gap-1">
        <label
          className="flex h-[88px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-[12px] text-txt-3 transition-colors hover:text-txt-1"
          style={{ borderColor: 'var(--space-line)' }}
        >
          {imagePath ? (
            <img src={imagePath} alt="獎品圖預覽" className="h-full w-full rounded-xl object-cover" />
          ) : (
            <>
              <Upload size={16} aria-hidden="true" />
              {uploading ? '上傳緊…' : '上傳獎品圖（可唔上傳）'}
            </>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </label>
        <p className="text-[12px] leading-snug text-txt-3">唔上傳會用返貨號商品嘅官網圖</p>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="獎品名（唔填會用貨號商品名）"
          className="rounded-xl border bg-transparent px-3 py-2 text-[13.5px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="貨號 SKU（入 WMS 用）"
          className="rounded-xl border bg-transparent px-3 py-2 font-mono text-[13px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          type="number"
          min={0}
          placeholder="價錢 HK$"
          className="rounded-xl border bg-transparent px-3 py-2 font-mono text-[13px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || uploading}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-[13.5px] font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#241505' }}
        >
          <Plus size={14} aria-hidden="true" />
          加獎品
        </button>
        {err && <p className="text-[12.5px] text-pink-soft md:col-span-5">{err}</p>}
      </div>

      {/* 獎品列表 */}
      {loading ? (
        <LoadingBlock text="許願星搬緊獎品…" />
      ) : prizes.length === 0 ? (
        <p className="py-6 text-center text-[13.5px] text-txt-3">呢場仲未有獎品，上面加第一件 ✦</p>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {prizes.map((p) => (
            <li
              key={p.id}
              className="rounded-xl border p-3"
              style={{
                borderColor: p.takenBy ? 'rgba(245,197,24,0.4)' : 'var(--space-line)',
                background: 'rgba(255,255,255,0.02)',
                opacity: p.active ? 1 : 0.45,
              }}
            >
              <div className="flex items-center gap-3">
                {p.imagePath ? (
                  <img
                    src={p.imagePath}
                    alt={p.name ?? p.sku}
                    className="h-14 w-14 shrink-0 rounded-lg border object-cover"
                    style={{ borderColor: 'var(--space-line)' }}
                  />
                ) : (
                  <span
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border text-txt-3"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <Gift size={20} aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-txt-1">{p.name || p.sku}</p>
                  <p className="font-mono text-[11.5px] text-txt-3">
                    {p.sku}・HK${p.price}
                  </p>
                  <p className="mt-0.5 text-[11.5px]">
                    {!p.active ? (
                      <span className="text-txt-3">已移走</span>
                    ) : p.takenBy ? (
                      <span className="text-gold">
                        已抽出 → {p.takenBy.name}（{p.takenBy.status === 'pending' ? '待客人回應' : '已確認寄送'}）
                      </span>
                    ) : (
                      <span className="text-txt-3">未抽出</span>
                    )}
                  </p>
                </div>
                {/* 任何狀態都刪得（真刪除）；有抽獎紀錄嘅 server 會 CONFLICT 彈原句 */}
                <button
                  type="button"
                  aria-label={`刪除獎品 ${p.name ?? p.sku}`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`刪除「${p.name || p.sku}」？`)) void onDelete(p.id);
                  }}
                  className="shrink-0 rounded-lg border p-2 text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────────── 中獎紀錄（按日展開） ─────────────────────────────

const GREEN = '#7BD88F'; // 老闆指定結案燈嘅柔和綠

type BadgeMeta = { label: string; color: string; border: string; bg?: string };

/** 每行狀態徽章衍生：confirmed 要睇埋 WMS orderStatus；pending 分自訂名單/會員行 */
function historyBadge(r: HistoryRow): BadgeMeta {
  if (r.status === 'confirmed') {
    if (r.orderStatus && ['approved', 'shipped', 'completed'].includes(r.orderStatus)) {
      // 結案燈：綠點＋綠字＋1px 綠邊框住
      return { label: '● 已確認', color: GREEN, border: GREEN, bg: 'rgb(123 216 143 / 0.10)' };
    }
    if (r.orderStatus && ['pending_payment', 'payment_review'].includes(r.orderStatus)) {
      return { label: '● WMS 審批中', color: GOLD, border: 'rgba(245,197,24,0.45)' };
    }
    if (r.orderId == null) {
      return { label: '已確認', color: GOLD, border: 'rgba(245,197,24,0.45)' };
    }
    return { label: '已確認寄送', color: '#34D399', border: 'rgba(52,211,153,0.4)' };
  }
  if (r.status === 'pending') {
    const manual = r.winnerNameSnap != null || r.listId != null;
    return {
      label: manual ? '待確定' : '待回覆',
      color: 'var(--text-3, #9d93b8)',
      border: 'var(--space-line)',
    };
  }
  if (r.status === 'declined') {
    return { label: '客人唔要', color: 'var(--text-3, #9d93b8)', border: 'var(--space-line)' };
  }
  if (r.status === 'cancelled') {
    return { label: '已取消', color: 'var(--pink-tint)', border: 'rgba(255,0,84,0.4)' };
  }
  return { label: r.status, color: 'var(--text-3, #9d93b8)', border: 'var(--space-line)' };
}

function DrawHistorySection({
  toast,
  onCancel,
  cancelling,
  onDelete,
  deleting,
}: {
  toast: (msg: string, kind?: 'success' | 'error') => void;
  onCancel: (drawId: number, label: string) => void;
  cancelling: boolean;
  onDelete: (drawId: number, orderNo: string | null) => void;
  deleting: boolean;
}) {
  // 刪除紀錄係 admin only（跟 Admin.tsx 嘅 role pattern；supervisor 交畀 server FORBIDDEN 擋）
  const { user: me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const utils = trpc.useUtils();
  const [openDate, setOpenDate] = useState<string | null>(null);
  const historyQuery = trpc.luckyDraw.adminHistory.useQuery(undefined, { refetchOnWindowFocus: false });
  const days = (historyQuery.data ?? []) as { date: string; rows: HistoryRow[] }[];
  const deleteDayMut = trpc.luckyDraw.adminDeleteDrawsByDate.useMutation();

  /** 成日刪除（admin only）：未審批 0 元訂單一併取消；有已批訂單 server 會 CONFLICT 彈原句 */
  const deleteDay = async (date: string, count: number) => {
    const ymd = date.replaceAll('-', ''); // history date 係 YYYYMMDD；保險起見兼容 YYYY-MM-DD
    const label = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    if (
      !window.confirm(
        `確定刪除 ${label} 全部 ${count} 筆抽獎紀錄？連結嘅官網 0 元訂單會一併刪除（WMS 嗰邊自己處理），刪咗唔返得轉。`,
      )
    ) {
      return;
    }
    try {
      const r = await deleteDayMut.mutateAsync({ drawDate: ymd });
      toast(`已刪除 ${r.deleted} 筆紀錄（官網訂單一併刪咗 ${r.ordersDeleted} 張）`, 'success');
      void utils.luckyDraw.adminHistory.invalidate();
      void utils.luckyDraw.adminListPrizes.invalidate();
    } catch (e) {
      toast(fmtErr(e), 'error');
    }
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <History size={16} aria-hidden="true" className="text-lavender" />
        中獎紀錄
        <span className="font-mono text-[12px] font-normal text-txt-3">（撳某日展開睇中獎人）</span>
      </h3>

      {historyQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊紀錄…" />
      ) : days.length === 0 ? (
        <p className="py-6 text-center text-[13.5px] text-txt-3">仲未有抽獎紀錄。</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {days.map((d) => {
            const open = openDate === d.date;
            const ymd = d.date.replaceAll('-', ''); // YYYYMMDD（兼容 YYYY-MM-DD）
            const dateLabel = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
            return (
              <li key={d.date} className="rounded-xl border" style={{ borderColor: 'var(--space-line)' }}>
                <button
                  type="button"
                  onClick={() => setOpenDate(open ? null : d.date)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
                >
                  <span className="flex items-center gap-2.5 text-[13.5px] font-semibold text-txt-1">
                    <Trophy size={14} aria-hidden="true" className="text-gold" />
                    {dateLabel}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-[12px] text-txt-3">{d.rows.length} 次抽獎</span>
                    {isAdmin && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation(); // 唔好觸發展開/收合
                          void deleteDay(d.date, d.rows.length);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            void deleteDay(d.date, d.rows.length);
                          }
                        }}
                        className={`text-[12px] underline-offset-2 transition-opacity hover:underline ${
                          deleteDayMut.isPending ? 'pointer-events-none opacity-40' : ''
                        }`}
                        style={{ color: '#E88B8B' }}
                      >
                        刪除成日
                      </span>
                    )}
                    <span
                      aria-hidden="true"
                      className="inline-block text-txt-3"
                      style={{
                        transition: 'transform 200ms',
                        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      ▾
                    </span>
                  </span>
                </button>
                {open && (
                  <ul className="space-y-2 border-t px-4 py-3" style={{ borderColor: 'var(--space-line)' }}>
                    {d.rows.map((r) => {
                      const meta = historyBadge(r);
                      const displayName = r.winnerNameSnap ?? r.winnerName;
                      const shadowAccount = r.winnerPhone.startsWith('DRAW#');
                      return (
                        <li
                          key={r.id}
                          className="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5"
                          style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.02)' }}
                        >
                          <img
                            src={r.prizeImagePath}
                            alt={r.prizeName}
                            className="h-11 w-11 shrink-0 rounded-lg border object-cover"
                            style={{ borderColor: 'var(--space-line)' }}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-txt-1">
                              {displayName}
                              {shadowAccount ? (
                                <span
                                  className="ml-2 rounded-full border px-2 py-px text-[10.5px] font-normal text-gold"
                                  style={{ borderColor: 'rgba(245,197,24,0.4)' }}
                                >
                                  自訂名單
                                </span>
                              ) : (
                                <span className="ml-2 font-mono text-[11.5px] font-normal text-txt-3">
                                  {r.winnerPhone}
                                </span>
                              )}
                            </p>
                            <p className="mt-0.5 text-[12px] text-txt-2">
                              {r.prizeName}
                              <span className="ml-2 font-mono text-[11px] text-txt-3">
                                {r.prizeSku}・HK${r.prizePrice}
                                {r.orderId ? `・訂單 #${r.orderId}` : ''}
                                {r.redrawOfId ? `・特別重抽（取代 #${r.redrawOfId}）` : ''}
                              </span>
                            </p>
                            <p className="mt-0.5 font-mono text-[11px] text-txt-3">
                              {fmtDateTime(String(r.createdAt))}
                              {r.drawnByName ? `・${r.drawnByName} 抽` : ''}
                              {r.cancelNote ? `・${r.cancelNote}` : ''}
                            </p>
                          </div>
                          <span
                            className="shrink-0 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold"
                            style={{
                              color: meta.color,
                              borderColor: meta.border,
                              background: meta.bg ?? 'transparent',
                            }}
                          >
                            {meta.label}
                          </span>
                          {(r.status === 'pending' || r.status === 'confirmed') && (
                            <button
                              type="button"
                              disabled={cancelling}
                              onClick={() => onCancel(r.id, displayName)}
                              className="shrink-0 rounded-full border px-3 py-1 text-[12px] text-pink-soft transition-colors hover:bg-white/5 disabled:opacity-40"
                              style={{ borderColor: 'rgba(255,0,84,0.4)' }}
                            >
                              取消中獎
                            </button>
                          )}
                          {r.orderNo && (
                            <span className="shrink-0 font-mono text-[11px] text-txt-3">{r.orderNo}</span>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={() => onDelete(r.id, r.orderNo)}
                              className="shrink-0 text-[12px] underline-offset-2 transition-opacity hover:underline disabled:opacity-40"
                              style={{ color: '#E88B8B' }}
                            >
                              刪除
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
