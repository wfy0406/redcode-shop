import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ChevronDown, ChevronUp, Clock, ImagePlus, Radio, Send, Square, Trash2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { getToken } from '@/lib/auth';
import WishingStar from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 直播開播推送面板（v2.2.0，2026-09-30 老闆指令）—— 員工後台用
 * - 發送表單：直播日期／場次（預設「晚上場」）／Facebook 網址／自訂一句（選填）
 * - 即時通知預覽卡：睇落似真通知（title／body／發送時間）
 * - 角色分工（role 由 auth.me 攞）：
 *   staff →「提交申請（待主管審批）」（pending，audit）
 *   supervisor/admin →「立即發送」（後端直接 send 畀全部已綁定裝置）
 * - 待批清單：申請人／日期場次／網址／批准／拒絕＋note（approveLivePush，supervisor 限定）
 * - 發送紀錄：近 50 筆（狀態徽章／日期場次／URL／申請人／審批人／來源 SHOP・WMS／發送時間／成功失敗數）
 */

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink focus:outline-none';
const labelCls = 'mb-1.5 block text-[13px] text-txt-2';

/** v2.2.52（老闆指令）：場次統一「第N場」——純數字自動包「第N場」；
 *  舊紀錄（晚上場 嗰啲字）原樣顯示，唔會變「第晚上場場」 */
const fmtSession = (s: string): string => (/^\d+$/.test(s.trim()) ? `第${s.trim()}場` : s);

type Campaign = {
  id: number;
  liveDate: string;
  liveSession: string;
  url: string;
  status: string;
  source: string;
  requestedByName: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  sentAt: string | Date | null;
  sentCount: number | null;
  failCount: number | null;
  createdAt: string | Date;
  endedAt: string | Date | null;
  // v2.2.16：直播回顧顯示順序（後台 ↑↓ 調；null＝跟日期新→舊）
  replayOrder: number | null;
  // v2.2.23：手動上傳嘅回顧縮圖（/uploads/...；null＝自動摷圖）
  thumbUrl: string | null;
  // v2.2.37（老闆指令）：三功能欄位
  skipNotify: boolean;
  directReplay: boolean;
  extendedMinutes: number;
};

const STATUS_META: Record<string, { label: string; color: string; border: string }> = {
  pending: { label: '待審批', color: 'var(--gold-soft)', border: 'rgba(245, 197, 24, 0.5)' },
  sending: { label: '發送中', color: 'var(--lavender)', border: 'rgba(201, 166, 255, 0.5)' },
  sent: { label: '已發送', color: 'var(--success)', border: 'rgba(52, 211, 153, 0.5)' },
  rejected: { label: '已拒絕', color: 'var(--pink-soft)', border: 'rgba(255, 77, 141, 0.5)' },
  failed: { label: '發送失敗', color: 'var(--pink-soft)', border: 'rgba(255, 77, 141, 0.5)' },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? {
    label: status,
    color: 'var(--text-3)',
    border: 'var(--space-line)',
  };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.08em]"
      style={{ color: meta.color, borderColor: meta.border }}
    >
      {meta.label}
    </span>
  );
}

/** HKT HH:mm（預覽卡嘅「發送時間」用而家時間示意） */
function hktNow(): string {
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** 上傳圖片去 /api/upload，回傳伺服器 path（做法同 PraiseManager 一模一樣：Bearer JWT + FormData file 欄位，回 {path}） */
async function uploadImage(file: File): Promise<string> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? '上傳失敗，請稍後再試');
  }
  const { path } = (await res.json()) as { path: string };
  return path;
}

/**
 * v2.2.23（老闆實測：FB 縮圖喺 Render 長期摷唔到）：每個已發送批次嘅縮圖格。
 * 有自訂縮圖（/uploads/ 開頭）→ 顯示細預覽＋「還原自動摷圖」；冇 → 顯示「自動」狀態。
 * 「上傳縮圖」行 /api/upload 攞 path，再經 push.setLiveCampaignThumb 落庫。
 */
function ThumbCell({
  c,
  toast,
}: {
  c: Campaign;
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const custom = typeof c.thumbUrl === 'string' && c.thumbUrl.startsWith('/uploads/');

  const setThumbMutation = trpc.push.setLiveCampaignThumb.useMutation({
    onSuccess: async (_r, vars) => {
      toast(vars.thumbUrl ? '縮圖已更新 ✓' : '已還原自動摷圖', 'success');
      await utils.push.listLivePush.invalidate();
      await utils.push.liveHistory.invalidate();
    },
    onError: (err) => toast(err.message || '縮圖更新失敗，請再試', 'error'),
    onSettled: () => setBusy(false),
  });

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    try {
      const path = await uploadImage(file);
      setThumbMutation.mutate({ id: c.id, thumbUrl: path });
    } catch (err) {
      setBusy(false);
      toast(err instanceof Error ? err.message : '上傳失敗，請稍後再試', 'error');
    }
  };

  const restoreAuto = () => {
    if (busy) return;
    setBusy(true);
    setThumbMutation.mutate({ id: c.id, thumbUrl: null });
  };

  return (
    <div className="mt-2 space-y-1.5 text-left">
      {custom && c.thumbUrl ? (
        <img
          src={c.thumbUrl}
          alt={`${c.liveDate} ${fmtSession(c.liveSession)} 回顧縮圖`}
          className="h-[54px] w-24 rounded-md object-cover"
          style={{ border: '1px solid var(--glass-border)' }}
        />
      ) : (
        <p className="text-[11px] text-txt-3">縮圖：自動摷圖</p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden="true"
        onChange={onPick}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: 'var(--space-line)', color: 'var(--gold-soft)' }}
        >
          <ImagePlus size={12} aria-hidden="true" />
          {busy ? '上傳緊…' : '上傳縮圖'}
        </button>
        {custom && (
          <button
            type="button"
            onClick={restoreAuto}
            disabled={busy}
            className="text-[11px] text-txt-3 underline underline-offset-2 transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            還原自動摷圖
          </button>
        )}
      </div>
    </div>
  );
}

export default function LivePushPanel({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const { user: me } = useAuth();
  // role 由 auth.me 攞：staff 申請；supervisor/admin 直接發送
  const canSendDirect = me?.role === 'supervisor' || me?.role === 'admin';

  const [liveDate, setLiveDate] = useState('');
  const [liveSession, setLiveSession] = useState('1');
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  // v2.2.37（老闆指令）：兩個互斥剔選——剔咗其中一個另一個即刻唔俾剔；
  // 取消剔選先可以揀返（避免一場直播又唔送通知又入回顧嘅矛盾組合）
  const [skipNotify, setSkipNotify] = useState(false);
  const [directReplay, setDirectReplay] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 每張待批卡嘅拒絕/批准備註（key = campaign id）
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [reviewBusyId, setReviewBusyId] = useState<number | null>(null);

  // v2.2.8：推送前即檢查條 FB 連結官網播唔播到（debounce 600ms，唔好逐字打就逐字查）
  const [urlForCheck, setUrlForCheck] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setUrlForCheck(url.trim()), 600);
    return () => clearTimeout(t);
  }, [url]);
  const previewQuery = trpc.push.previewLiveUrl.useQuery(
    { url: urlForCheck },
    { enabled: /^https?:\/\/.+/.test(urlForCheck), retry: false, staleTime: 60_000 },
  );
  // 淨係顯示「同而家輸入框一樣嘅 URL」嘅檢查結果，避免舊結果誤導
  const preview = urlForCheck === url.trim() ? previewQuery.data : undefined;

  const listQuery = trpc.push.listLivePush.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  // 後端回 { items: [...] }（近 50 筆）
  const campaigns = useMemo(
    () => ((listQuery.data?.items ?? []) as Campaign[]),
    [listQuery.data],
  );
  const pending = campaigns.filter((c) => c.status === 'pending');

  const requestMutation = trpc.push.requestLivePush.useMutation({
    onSuccess: async (_r, vars) => {
      // v2.2.37：toast 講明剔選效果，等老闆知發生緊咩事
      const flagTail = vars.directReplay
        ? '——已剔「直接放入直播回顧」：唔會送通知，唔會出現直播中'
        : vars.skipNotify
          ? '——已剔「不發送直播通知」：首頁照樣顯示直播中'
          : '';
      toast(
        canSendDirect
          ? `直播批次已送出${flagTail || '，通知發送緊，紀錄會顯示成功/失敗數'}`
          : `已提交申請，等主管審批${flagTail}`,
        'success',
      );
      setUrl('');
      setMessage('');
      setSkipNotify(false);
      setDirectReplay(false);
      setFormError(null);
      await utils.push.listLivePush.invalidate();
    },
    onError: (err) => setFormError(err.message || '提交失敗，請再試'),
  });

  const approveMutation = trpc.push.approveLivePush.useMutation({
    onSuccess: async (_r, vars) => {
      toast(vars.approve ? '已批准，通知發送緊' : '已拒絕申請', vars.approve ? 'success' : 'info');
      setReviewBusyId(null);
      await utils.push.listLivePush.invalidate();
    },
    onError: (err) => {
      setReviewBusyId(null);
      toast(err.message || '操作失敗，請再試', 'error');
    },
  });

  const submit = () => {
    if (requestMutation.isPending) return;
    setFormError(null);
    if (!liveDate) {
      setFormError('請揀直播日期');
      return;
    }
    if (!liveSession.trim()) {
      setFormError('請填場次（例如：晚上場）');
      return;
    }
    if (!/^https?:\/\/.+/.test(url.trim())) {
      setFormError('請填完整 Facebook 直播網址（https:// 開頭）');
      return;
    }
    requestMutation.mutate({
      liveDate,
      liveSession: liveSession.trim(),
      url: url.trim(),
      ...(message.trim() ? { message: message.trim() } : {}),
      // v2.2.37：兩個剔選照實落批次（互斥由 UI 把關）
      skipNotify,
      directReplay,
    });
  };

  const review = (id: number, approve: boolean) => {
    if (reviewBusyId != null) return;
    setReviewBusyId(id);
    const note = notes[id]?.trim();
    approveMutation.mutate({ id, approve, ...(note ? { reviewNote: note } : {}) });
  };

  // ─── v2.2.2（老闆指令）：而家官網顯示緊嘅直播＋一掣落畫 ───────────────
  const nowLiveQuery = trpc.push.currentLive.useQuery(undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const nowLive = nowLiveQuery.data?.live ?? null;
  const endLiveMutation = trpc.push.endLiveNow.useMutation({
    onSuccess: async (r) => {
      if (r.ok) {
        toast(`已落畫：${r.liveDate} ${fmtSession(r.liveSession)} 唔會再喺首頁／直播頁顯示`, 'success');
      } else {
        toast(r.message ?? '而家冇顯示緊嘅直播', 'info');
      }
      await utils.push.currentLive.invalidate();
    },
    onError: (err) => toast(err.message || '落畫失敗，請再試', 'error'),
  });
  const endLive = () => {
    if (endLiveMutation.isPending) return;
    if (!window.confirm('確定落畫？首頁同直播頁會即刻唔再顯示呢場直播（已發出嘅通知唔受影響）。')) return;
    endLiveMutation.mutate();
  };

  // ─── v2.2.37（老闆指令）：直播中延長 60 分鐘——90 分鐘到可以自己延，每掣 +60（累計上限 240）───
  const extendLiveMutation = trpc.push.extendLiveNow.useMutation({
    onSuccess: async (r) => {
      if (r.ok) {
        toast(`已延長 60 分鐘（累計延長 ${r.extendedMinutes} 分鐘）`, 'success');
      } else {
        toast(r.message ?? '延唔到，請再試', 'info');
      }
      await utils.push.currentLive.invalidate();
      await utils.push.listLivePush.invalidate();
    },
    onError: (err) => toast(err.message || '延長失敗，請再試', 'error'),
  });
  const extendLive = () => {
    if (extendLiveMutation.isPending) return;
    extendLiveMutation.mutate();
  };

  // ─── v2.2.5（老闆指令）：刪除直播回顧 ───────────────
  // 規則同後端一致：顯示緊（sent＋90 分鐘內＋未落畫）／pending／sending 唔俾刪。
  const deleteMutation = trpc.push.deleteLiveCampaign.useMutation({
    onSuccess: async (r) => {
      if (r.ok) {
        toast('已刪除呢筆直播回顧', 'success');
      } else {
        toast(r.message ?? '刪唔到，請再試', 'error');
      }
      await utils.push.listLivePush.invalidate();
      await utils.push.liveHistory.invalidate();
    },
    onError: (err) => toast(err.message || '刪除失敗，請再試', 'error'),
  });
  const [deleteBusyId, setDeleteBusyId] = useState<number | null>(null);
  const nowMs = Date.now();
  // v2.2.37：顯示窗口要跟延長（90 分鐘＋extendedMinutes）——同後端 effectiveLiveWindowMs 對齊
  const liveWindowOf = (c: (typeof campaigns)[number]) =>
    90 * 60 * 1000 + Math.max(0, c.extendedMinutes ?? 0) * 60 * 1000;
  const canDelete = (c: (typeof campaigns)[number]) =>
    c.status !== 'pending' &&
    c.status !== 'sending' &&
    !(
      c.status === 'sent' &&
      !c.endedAt &&
      c.sentAt != null &&
      nowMs - new Date(c.sentAt).getTime() < liveWindowOf(c)
    );

  // ─── v2.2.16（老闆指令）：直播回顧順序 ↑↓ 調 ───────────────
  // 資格同後端一致：sent 兼（已落畫 或 過咗 90 分鐘窗口）＝回顧清單入面嗰啲。
  const [moveBusyId, setMoveBusyId] = useState<number | null>(null);
  const moveReplayMutation = trpc.push.moveLiveReplay.useMutation({
    onSuccess: async (r) => {
      if (!r.ok) toast(r.error ?? '調唔到，請再試', 'info');
      setMoveBusyId(null);
      await utils.push.listLivePush.invalidate();
      await utils.push.liveHistory.invalidate();
    },
    onError: (err) => {
      setMoveBusyId(null);
      toast(err.message || '調順序失敗，請再試', 'error');
    },
  });
  const isReplay = (c: (typeof campaigns)[number]) =>
    c.status === 'sent' &&
    (c.endedAt != null ||
      (c.sentAt != null && nowMs - new Date(c.sentAt).getTime() >= liveWindowOf(c)));
  const moveReplay = (id: number, direction: 'up' | 'down') => {
    if (moveBusyId != null) return;
    setMoveBusyId(id);
    moveReplayMutation.mutate({ id, direction });
  };
  const removeCampaign = (c: (typeof campaigns)[number]) => {
    if (deleteMutation.isPending) return;
    if (!window.confirm(`確定刪除「${c.liveDate} ${fmtSession(c.liveSession)}」呢筆回顧？刪咗直播頁會即刻唔再顯示，冇得還原。`)) return;
    setDeleteBusyId(c.id);
    deleteMutation.mutate(
      { id: c.id },
      { onSettled: () => setDeleteBusyId(null) },
    );
  };

  return (
    <div className="space-y-8">
      {/* ============ 而家顯示緊（v2.2.2）：有直播先見到，一掣落畫 ============ */}
      {nowLive && (
        <div
          className="rounded-2xl border p-5 md:p-6"
          style={{ borderColor: 'rgba(255, 0, 84, 0.45)', background: 'var(--space-1)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="push-live-dot inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--pink)' }} aria-hidden="true" />
              <div>
                <p className="font-serif-tc text-[15px] font-bold text-txt-1">
                  官網而家顯示緊：{nowLive.liveDate}・{fmtSession(nowLive.liveSession)}
                </p>
                <p className="mt-0.5 text-[12px] text-txt-3">
                  {/* v2.2.37：顯示窗口講明 90 分鐘＋已延長幾多；到點可以自己延 */}
                  首頁同直播頁會顯示到推播後 90 分鐘
                  {(nowLive.extendedMinutes ?? 0) > 0
                    ? `＋已延長 ${nowLive.extendedMinutes} 分鐘`
                    : ''}
                  ；想即刻收返就撳「立即落畫」。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {/* v2.2.37（老闆指令）：直播中可自己延長——每掣 +60 分鐘（累計上限 240） */}
              <button
                type="button"
                onClick={extendLive}
                disabled={
                  extendLiveMutation.isPending ||
                  (nowLive.extendedMinutes ?? 0) >= 240
                }
                title={
                  (nowLive.extendedMinutes ?? 0) >= 240
                    ? '已達延長上限（額外 240 分鐘）'
                    : '顯示窗口延長 60 分鐘'
                }
                className="inline-flex items-center gap-2 rounded-full border px-5 py-2 text-[13px] font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: 'rgba(245, 197, 24, 0.55)', color: 'var(--gold-soft)' }}
              >
                <Clock size={14} aria-hidden="true" />
                {extendLiveMutation.isPending ? '延長緊…' : '延長 60 分鐘'}
              </button>
              <button
                type="button"
                onClick={endLive}
                disabled={endLiveMutation.isPending}
                className="inline-flex items-center gap-2 rounded-full border px-5 py-2 text-[13px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-60"
                style={{ borderColor: 'rgba(255, 77, 141, 0.6)', color: 'var(--pink-soft)' }}
              >
                <Square size={14} aria-hidden="true" />
                {endLiveMutation.isPending ? '落畫緊…' : '立即落畫'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 發送表單＋通知預覽 ============ */}
      <div
        className="rounded-2xl border p-6 md:p-8"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
          >
            <Radio size={20} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-serif-tc text-lg font-bold text-txt-1">發送直播開播通知</h2>
            <p className="text-sm text-txt-3">
              {canSendDirect
                ? '主管／管理員撳「立即發送」，通知會即時推送畀全部已綁定裝置'
                : '員工提交申請後，要主管／管理員審批先會發送'}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* 左：表單 */}
          <div className="space-y-4">
            <div>
              <label htmlFor="lp-date" className={labelCls}>
                直播日期
              </label>
              <input
                id="lp-date"
                type="date"
                value={liveDate}
                onChange={(e) => setLiveDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="lp-session" className={labelCls}>
                場次
              </label>
              {/* v2.2.52（老闆指令）：場次快揀掣改做第1場～第5場（存 '1'..'5'），撳完照樣可以手改 */}
              <div className="mb-2 flex flex-wrap gap-2">
                {(['1', '2', '3', '4', '5'] as const).map((s) => {
                  const active = liveSession === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setLiveSession(s)}
                      aria-pressed={active}
                      className="rounded-full border px-3.5 py-1.5 text-[12px] transition-colors"
                      style={
                        active
                          ? { borderColor: 'var(--pink)', background: 'var(--pink-haze)', color: 'var(--txt-1)', fontWeight: 600 }
                          : { borderColor: 'var(--space-line)', background: 'var(--space-2)', color: 'var(--txt-3)' }
                      }
                    >
                      {`第${s}場`}
                    </button>
                  );
                })}
              </div>
              <input
                id="lp-session"
                type="text"
                value={liveSession}
                onChange={(e) => setLiveSession(e.target.value)}
                placeholder="1"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="lp-url" className={labelCls}>
                Facebook 直播網址
              </label>
              <input
                id="lp-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.facebook.com/redcodexhk/live/..."
                className={inputCls}
              />
              {/* v2.2.8 連結檢查：話你知條 link 官網播唔播到（短鏈會自動解鏈） */}
              {previewQuery.isFetching && (
                <p className="mt-1.5 text-[12px] text-txt-3">檢查緊條連結…</p>
              )}
              {preview?.embeddable && (
                <p className="mt-1.5 text-[12px] text-gold-soft">
                  ✓ 呢條連結官網可以原位播{preview.changed ? '（短鏈已自動解做正式連結）' : ''}，推播撳入去亦會直開 FB app
                </p>
              )}
              {/* v2.2.15 縮圖診斷：伺服器摷唔摷到真預覽圖，後台一眼睇到 */}
              {preview?.embeddable && preview.thumbNote === 'ok' && preview.thumbUrl && (
                <div className="mt-1.5 flex items-center gap-2.5">
                  <img
                    src={preview.thumbUrl}
                    alt="直播縮圖預覽"
                    className="h-16 w-16 rounded-lg object-cover"
                    style={{ border: '1px solid var(--glass-border)' }}
                  />
                  <p className="text-[12px] text-txt-3">
                    ✓ 縮圖摷到——官網直播位同回顧卡會顯示呢張真預覽圖
                  </p>
                </div>
              )}
              {preview?.embeddable && preview.thumbNote && preview.thumbNote !== 'ok' && (
                <p className="mt-1.5 text-[12px] text-txt-3">
                  ⚠️ 縮圖暫時摷唔到（{preview.thumbNote === 'fetch_fail' ? '伺服器連 FB 嗰下被擋，遲啲會自動好返' : 'FB 播放器頁冇提供縮圖'}）——官網會用返設計圖代替，唔影響播放
                </p>
              )}
              {preview && !preview.embeddable && (
                <div className="mt-1.5 rounded-xl border border-space-line bg-space-2 px-3.5 py-3">
                  <p className="text-[12px] text-pink-soft">
                    ⚠️ 官網認唔到呢條係邊條片——推送照樣發得、客人撳到會彈去 FB app 睇，只係官網唔會原位播。
                  </p>
                  <p className="mt-2 text-[12px] font-medium text-txt-2">想官網都播到？攞「長連結」三步：</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5 text-[12px] leading-relaxed text-txt-3">
                    <li>喺手機瀏覽器（Chrome/Safari）開 <span className="font-mono text-gold-soft">facebook.com</span>，入去 RedCode 專頁</li>
                    <li>撳入嗰條直播片，等條片開始播</li>
                    <li>撳最頂地址欄 → 全選 → 複製（嗰條有 <span className="font-mono">videos/一串數字</span> 嘅就係），貼返落呢度</li>
                  </ol>
                </div>
              )}
            </div>
            <div>
              <label htmlFor="lp-message" className={labelCls}>
                自訂一句（選填，會取代通知第一句「快啲入嚟睇啦！」）
              </label>
              <input
                id="lp-message"
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="例如：今晚有快閃價！"
                maxLength={80}
                className={inputCls}
              />
            </div>

            {/* v2.2.37（老闆指令）：兩個互斥剔選——剔咗其中一個，另一個即刻唔俾剔；
                取消剔選先可以揀返。兩個都唔剔＝正常送通知＋顯示直播中。 */}
            <div className="space-y-2.5 rounded-xl border border-space-line bg-space-2 px-4 py-3.5">
              <label
                className="flex cursor-pointer items-start gap-2.5 text-[13px] text-txt-2"
                style={directReplay ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              >
                <input
                  type="checkbox"
                  checked={skipNotify}
                  disabled={directReplay}
                  onChange={(e) => setSkipNotify(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-pink"
                />
                <span>
                  不發送直播通知
                  <span className="mt-0.5 block text-[12px] leading-[1.5] text-txt-3">
                    唔會送 push 通知；首頁同直播頁照樣顯示「直播中」90 分鐘
                  </span>
                </span>
              </label>
              <label
                className="flex cursor-pointer items-start gap-2.5 text-[13px] text-txt-2"
                style={skipNotify ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              >
                <input
                  type="checkbox"
                  checked={directReplay}
                  disabled={skipNotify}
                  onChange={(e) => setDirectReplay(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-pink"
                />
                <span>
                  直接放入直播回顧
                  <span className="mt-0.5 block text-[12px] leading-[1.5] text-txt-3">
                    唔會送通知，亦唔會出現「直播中」——直接就落入直播回顧
                  </span>
                </span>
              </label>
            </div>

            {formError && (
              <p role="alert" className="text-[13px] text-pink-soft">
                {formError}
              </p>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={requestMutation.isPending}
              className="btn btn-primary w-full disabled:opacity-60"
            >
              {requestMutation.isPending ? (
                <WishingStar size={16} spinning />
              ) : (
                <Send size={15} aria-hidden="true" />
              )}
              {canSendDirect ? '立即發送' : '提交申請（待主管審批）'}
            </button>
          </div>

          {/* 右：即時通知預覽（v2.2.2：撳預覽＝試真通知跳轉，一樣經 live-go 跳板開 FB app） */}
          <div>
            <p className={labelCls}>通知預覽（撳一下＝試真通知跳轉）</p>
            <button
              type="button"
              onClick={() => {
                const u = url.trim();
                if (!/^https?:\/\/.+/.test(u)) return;
                // 同真推播完全一致：FB 連結先經 /live-go-v6.html 跳板（手機開 FB app，冇裝→網頁版）
                const isFb = /^https:\/\/([^/]+\.)?(facebook\.com|fb\.watch|fb\.me)(\/|$)/i.test(u);
                window.open(isFb ? `/live-go-v6.html?u=${encodeURIComponent(u)}` : u, '_blank', 'noopener,noreferrer');
              }}
              className="block w-full rounded-2xl border p-4 text-left transition-opacity hover:opacity-85"
              style={{ borderColor: 'var(--glass-border)', background: 'var(--space-1)' }}
              aria-label="試跳轉：撳通知會去嘅地方"
            >
              <div className="flex items-start gap-3">
                <img src="/push-icon.png" alt="" className="mt-0.5 h-9 w-9 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-[13px] font-semibold text-txt-1">
                      🔴 RedCode 直播開始啦！
                    </p>
                    <span className="shrink-0 font-mono text-[11px] text-txt-3">而家</span>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-[13px] leading-[1.6] text-txt-2">
                    {`${message.trim() || '快啲入嚟睇啦！'}\n📅 ${liveDate || '（未揀日期）'} ${fmtSession(liveSession || '1')}\n🕒 發送時間 ${hktNow()}`}
                  </p>
                  <p className="mt-2 truncate font-mono text-[11px] text-txt-3">
                    {url.trim() || '（撳通知會直接開 Facebook app；冇裝 app 就開網頁版）'}
                  </p>
                </div>
              </div>
            </button>
            <p className="mt-2 text-[12px] leading-[1.7] text-txt-3">
              預覽僅供參考，實際顯示跟唔同裝置/瀏覽器會有少少出入；發送時間係伺服器實際發出嗰刻。
              撳預覽卡會試真通知嘅跳轉：手機有裝 Facebook 會直接開 app，冇裝就開網頁版。
            </p>
            {/* v2.2.37：剔咗選項要喺預覽下方講明實際效果，唔好以為照樣送通知 */}
            {directReplay && (
              <p className="mt-2 text-[12px] font-medium leading-[1.6] text-gold-soft">
                ⚠️ 已剔「直接放入直播回顧」：呢張通知<strong>唔會送出</strong>，直播唔會出現喺首頁「直播中」，直接就落入直播回顧。
              </p>
            )}
            {!directReplay && skipNotify && (
              <p className="mt-2 text-[12px] font-medium leading-[1.6] text-gold-soft">
                ⚠️ 已剔「不發送直播通知」：呢張通知<strong>唔會送出</strong>，但首頁同直播頁照樣會顯示「直播中」90 分鐘。
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ============ 待批清單 ============ */}
      <div
        className="rounded-2xl border p-6 md:p-8"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h2 className="font-serif-tc text-lg font-bold text-txt-1">
          待批申請{pending.length > 0 ? `（${pending.length}）` : ''}
        </h2>
        {pending.length === 0 ? (
          <p className="mt-4 text-[14px] text-txt-3">而家冇待批嘅直播推送申請。</p>
        ) : (
          <div className="mt-5 space-y-4">
            {pending.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-space-line bg-space-2 px-4 py-4"
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <StatusBadge status={c.status} />
                  <p className="font-serif-tc text-[15px] font-semibold text-txt-1">
                    {c.liveDate}・{fmtSession(c.liveSession)}
                  </p>
                  <p className="text-[12px] text-txt-3">
                    申請人：{c.requestedByName ?? '—'}
                    {c.source === 'WMS' ? '（WMS）' : ''}
                  </p>
                  {/* v2.2.37：審批人要睇到申請剔咗咩——批准之後會照旗號行事 */}
                  {c.directReplay && (
                    <p className="text-[12px] font-medium text-gold-soft">已剔：直接放入直播回顧</p>
                  )}
                  {!c.directReplay && c.skipNotify && (
                    <p className="text-[12px] font-medium text-gold-soft">已剔：不發送直播通知</p>
                  )}
                </div>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 block break-all font-mono text-[12px] text-lavender underline underline-offset-2 transition-colors hover:text-txt-1"
                >
                  {c.url}
                </a>
                {canSendDirect ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <input
                      type="text"
                      value={notes[c.id] ?? ''}
                      onChange={(e) =>
                        setNotes((prev) => ({ ...prev, [c.id]: e.target.value }))
                      }
                      placeholder="審批備註（選填）"
                      className="h-10 min-w-[180px] flex-1 rounded-xl border border-space-line bg-space-1 px-3 text-[13px] text-txt-1 placeholder:text-txt-disabled focus:border-pink focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => review(c.id, true)}
                      disabled={reviewBusyId === c.id}
                      className="rounded-full px-5 py-2 text-[13px] font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
                      style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
                    >
                      批准並發送
                    </button>
                    <button
                      type="button"
                      onClick={() => review(c.id, false)}
                      disabled={reviewBusyId === c.id}
                      className="rounded-full border px-5 py-2 text-[13px] transition-opacity hover:opacity-80 disabled:opacity-50"
                      style={{ borderColor: 'var(--pink-soft)', color: 'var(--pink-soft)' }}
                    >
                      拒絕
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[12px] text-txt-3">等主管／管理員審批。</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============ 發送紀錄（近 50 筆） ============ */}
      <div
        className="rounded-2xl border p-6 md:p-8"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h2 className="font-serif-tc text-lg font-bold text-txt-1">發送紀錄（近 50 筆）</h2>
        {listQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <WishingStar size={24} spinning />
          </div>
        ) : listQuery.isError ? (
          <p role="alert" className="mt-4 text-[13px] text-pink-soft">
            紀錄載入失敗，請稍後重新整理。
          </p>
        ) : campaigns.length === 0 ? (
          <p className="mt-4 text-[14px] text-txt-3">仲未有發送紀錄。</p>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead>
                <tr
                  className="border-b text-left text-[12px] tracking-[0.08em] text-txt-3"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <th className="py-2.5 pr-3 font-bold">狀態</th>
                  <th className="py-2.5 pr-3 font-bold">日期・場次</th>
                  <th className="py-2.5 pr-3 font-bold">網址</th>
                  <th className="py-2.5 pr-3 font-bold">申請人</th>
                  <th className="py-2.5 pr-3 font-bold">審批人</th>
                  <th className="py-2.5 pr-3 font-bold">來源</th>
                  <th className="py-2.5 pr-3 font-bold">發送時間</th>
                  <th className="py-2.5 font-bold">成功／失敗</th>
                  <th className="py-2.5 pl-3 text-right font-bold">回顧</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b align-top"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <td className="py-2.5 pr-3">
                      <StatusBadge status={c.status} />
                      {/* v2.2.37：三功能徽章——一眼睇到邊啲場無送通知／直入回顧／延長過 */}
                      {c.directReplay && (
                        <p className="mt-1.5 text-[11px] leading-[1.4] text-gold-soft">直入回顧</p>
                      )}
                      {!c.directReplay && c.skipNotify && (
                        <p className="mt-1.5 text-[11px] leading-[1.4] text-txt-3">無發通知</p>
                      )}
                      {(c.extendedMinutes ?? 0) > 0 && (
                        <p className="mt-1.5 text-[11px] leading-[1.4] text-txt-3">
                          已延長 {c.extendedMinutes} 分鐘
                        </p>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-txt-1">
                      {c.liveDate}
                      <br />
                      <span className="text-txt-3">{fmtSession(c.liveSession)}</span>
                    </td>
                    <td className="max-w-[180px] py-2.5 pr-3">
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-mono text-[12px] text-lavender underline underline-offset-2 transition-colors hover:text-txt-1"
                      >
                        {c.url}
                      </a>
                    </td>
                    <td className="py-2.5 pr-3 text-txt-2">{c.requestedByName ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-txt-2">{c.reviewedByName ?? '—'}</td>
                    <td className="py-2.5 pr-3">
                      <span className="font-mono text-[12px] text-txt-3">{c.source}</span>
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-2">
                      {fmtDateTime(c.sentAt)}
                    </td>
                    <td className="py-2.5 font-mono text-[12px]">
                      <span style={{ color: 'var(--success)' }}>{c.sentCount ?? 0}</span>
                      <span className="text-txt-3">／</span>
                      <span style={{ color: 'var(--pink-soft)' }}>{c.failCount ?? 0}</span>
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {/* v2.2.16（老闆指令）：回顧順序 ↑↓ 調——即時反映喺官網直播回顧區 */}
                        {isReplay(c) && (
                          <>
                            <button
                              type="button"
                              onClick={() => moveReplay(c.id, 'up')}
                              disabled={moveBusyId === c.id}
                              title="回顧移前一級"
                              aria-label={`${c.liveDate} ${fmtSession(c.liveSession)} 回顧移前`}
                              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
                              style={{ borderColor: 'var(--space-line)', color: 'var(--gold-soft)' }}
                            >
                              <ChevronUp size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveReplay(c.id, 'down')}
                              disabled={moveBusyId === c.id}
                              title="回顧移後一級"
                              aria-label={`${c.liveDate} ${fmtSession(c.liveSession)} 回顧移後`}
                              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
                              style={{ borderColor: 'var(--space-line)', color: 'var(--gold-soft)' }}
                            >
                              <ChevronDown size={14} aria-hidden="true" />
                            </button>
                          </>
                        )}
                        {/* v2.2.5：已落畫嘅回顧可以刪（直播頁即時唔再顯示）；顯示緊／審批中唔俾刪 */}
                        <button
                          type="button"
                          onClick={() => removeCampaign(c)}
                          disabled={!canDelete(c) || deleteBusyId === c.id}
                          title={
                            canDelete(c)
                              ? '刪除呢筆直播回顧'
                              : '顯示緊或者審批中嘅批次唔可以刪'
                          }
                          aria-label={`刪除 ${c.liveDate} ${fmtSession(c.liveSession)} 回顧`}
                          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-25"
                          style={{ borderColor: 'var(--space-line)', color: 'var(--pink-soft)' }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {/* v2.2.23（老闆實測：FB 摷圖長期失敗）：已發送批次可以手動上傳回顧縮圖 */}
                      {c.status === 'sent' && <ThumbCell c={c} toast={toast} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 🔴 落畫卡紅點呼吸：淨 opacity（老闆鐵律）；reduced-motion 停 */}
      <style>{`
        .push-live-dot { animation: push-live-breathe 1.6s ease-in-out infinite; }
        @keyframes push-live-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        @media (prefers-reduced-motion: reduce) { .push-live-dot { animation: none; opacity: 1; } }
      `}</style>
    </div>
  );
}
