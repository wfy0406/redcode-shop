import { useState } from 'react';
import { Archive, ArchiveRestore, Copy, Facebook, ImageDown, Pencil, Plus, Share2, Ticket, Trash2, Trophy } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';
import LuckyDrawExcelImport from './LuckyDrawExcelImport';
import { downloadAnnouncementPng } from '@/lib/luckyAnnouncementPng';

/**
 * LuckyDrawEventPanel —— 抽獎劵活動管理（v2.5.6，LuckyDrawPanel 劵模式右欄）
 *
 * 合約（api/luckyDrawRouter.ts 現況）：
 *   adminCreateEvent{name(≤128), maxWinsPerPerson(1–100)}——限中係全活動累計（pending+confirmed 計），
 *     建立時設定，冇 update endpoint → 現有活動唯讀顯示口径；
 *   adminListEvents→＋entryCount/totalTickets/drawnCount/archivedAt；
 *   adminSetEventArchived（歸檔＝唔再匯入/抽得，紀錄留底）；
 *   v2.5.8（老闆指令）：adminRenameEvent（改名，唔郁劵數/紀錄）＋ adminDeleteEvent
 *     （刪成個活動：中獎紀錄解綁留底，訂單唔受影響；確認＋mutation pending 防雙擊）；
 *   adminEventWinners（每場活動內部中獎名單＝真實抽獎結果＋跟進資料）；
 *   adminListEventEntries{eventId}→entries(+winCount)＋totalTickets；
 *   adminDeleteEventEntry（有中獎紀錄 FK 擋 → CONFLICT 原句彈出）。
 * Excel 匯入抽獎劵由 LuckyDrawExcelImport（kind="ticket"）處理。
 */

export type DrawEvent = {
  id: number;
  name: string;
  maxWinsPerPerson: number;
  entryCount: number;
  totalTickets: number;
  drawnCount: number;
  archivedAt: string | Date | null;
  archivedByName: string | null;
  createdAt: string | Date;
  createdByName: string | null;
};

type EventEntry = {
  id: number;
  holderName: string;
  ticketCount: number;
  winCount: number;
  createdByName: string | null;
  createdAt: string | Date;
};

/** v2.5.8：內部中獎名單 row（adminEventWinners）——真實抽獎結果＋跟進資料 */
type EventWinner = {
  id: number;
  status: string;
  drawDate: string;
  createdAt: string | Date;
  winnerNameSnap: string | null;
  winnerName: string | null;
  notifiedAt: string | Date | null;
  redrawOfId: number | null;
  cancelNote: string | null;
  drawnByName: string | null;
  orderNo: string | null;
  orderStatus: string | null;
  prizeName: string;
  prizeSku: string;
  prizePrice: number;
};

/** 內部名單狀態徽章口径（同 LuckyDrawPanel historyBadge 精簡版，唔搬全份） */
function winnerStatusLabel(status: string): string {
  if (status === 'pending') return '待確定';
  if (status === 'confirmed') return '已確認';
  if (status === 'declined') return '客人唔要';
  if (status === 'cancelled') return '已取消';
  return status;
}

/** 公開公告 URL（HashRouter：/…#/lucky-results/:eventId） */
function publicResultsUrl(eventId: number): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/lucky-results/${eventId}`;
}

function fmtErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('[{')) {
    try {
      const arr = JSON.parse(msg);
      if (Array.isArray(arr) && arr[0]?.message) return arr[0].message as string;
    } catch {
      /* fallthrough */
    }
  }
  return msg;
}

export default function LuckyDrawEventPanel({
  selectedEventId,
  onSelectEvent,
  toast,
}: {
  selectedEventId: number | null;
  onSelectEvent: (id: number | null) => void;
  toast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const utils = trpc.useUtils();
  const [newName, setNewName] = useState('');
  const [newMaxWins, setNewMaxWins] = useState('1');
  const [showEntries, setShowEntries] = useState(true);
  // v2.5.8：改名 inline 編輯＋中獎名單展開＋公告動作 state
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [showWinners, setShowWinners] = useState(false);
  const [pngBusy, setPngBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const eventsQuery = trpc.luckyDraw.adminListEvents.useQuery(undefined, { refetchOnWindowFocus: false });
  const events = (eventsQuery.data ?? []) as DrawEvent[];
  const selected = events.find((e) => e.id === selectedEventId) ?? null;

  const entriesQuery = trpc.luckyDraw.adminListEventEntries.useQuery(
    { eventId: selectedEventId ?? 0 },
    { enabled: selectedEventId != null, refetchOnWindowFocus: false },
  );
  const entries = (entriesQuery.data?.entries ?? []) as EventEntry[];
  const totalTickets = entriesQuery.data?.totalTickets ?? 0;

  const invalidateEvents = () => {
    void utils.luckyDraw.adminListEvents.invalidate();
    void utils.luckyDraw.adminListEventEntries.invalidate();
  };

  const createMut = trpc.luckyDraw.adminCreateEvent.useMutation({
    onSuccess: (ev) => {
      toast(`活動《${ev.name}》已建立（每人全活動限中 ${ev.maxWinsPerPerson} 次）`, 'success');
      invalidateEvents();
      onSelectEvent(ev.id);
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  const archiveMut = trpc.luckyDraw.adminSetEventArchived.useMutation({
    onSuccess: (_r, v) => {
      toast(v.archived ? '活動已歸檔（唔再匯入／抽得，紀錄留底）' : '活動已放返未歸檔', 'success');
      invalidateEvents();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  const deleteEntryMut = trpc.luckyDraw.adminDeleteEventEntry.useMutation({
    onSuccess: () => {
      toast('劵持有人已刪除', 'success');
      invalidateEvents();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  // v2.5.8（老闆指令）：活動改名（唔郁劵數／限中／已抽紀錄）
  const renameMut = trpc.luckyDraw.adminRenameEvent.useMutation({
    onSuccess: (r) => {
      toast(`活動已改名做《${r.name}》`, 'success');
      setRenaming(false);
      invalidateEvents();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  // v2.5.8（老闆指令）：刪除成個活動——中獎紀錄解綁留底，訂單唔受影響
  const deleteEventMut = trpc.luckyDraw.adminDeleteEvent.useMutation({
    onSuccess: (r) => {
      toast(`活動已刪除（${r.detachedDraws} 筆中獎紀錄已留底，訂單唔受影響）`, 'success');
      onSelectEvent(null);
      invalidateEvents();
      void utils.luckyDraw.adminHistory.invalidate();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  // v2.5.8：每場活動內部中獎名單（展開先載入；真實抽獎結果＋跟進資料）
  const winnersQuery = trpc.luckyDraw.adminEventWinners.useQuery(
    { eventId: selectedEventId ?? 0 },
    { enabled: selectedEventId != null && showWinners, refetchOnWindowFocus: false },
  );
  const winners = (winnersQuery.data?.winners ?? []) as EventWinner[];

  const create = () => {
    const name = newName.trim();
    const mw = Math.floor(Number(newMaxWins));
    if (!name) {
      toast('活動名唔准空', 'error');
      return;
    }
    if (!Number.isFinite(mw) || mw < 1 || mw > 100) {
      toast('每人限中次數要係 1–100', 'error');
      return;
    }
    createMut.mutate({ name, maxWinsPerPerson: mw });
    setNewName('');
    setNewMaxWins('1');
  };

  const busy =
    createMut.isPending ||
    archiveMut.isPending ||
    deleteEntryMut.isPending ||
    renameMut.isPending ||
    deleteEventMut.isPending;

  /** v2.5.8：改名提交（空名／無改動唔出 request） */
  const commitRename = () => {
    if (!selected) return;
    const name = renameValue.trim();
    if (!name) {
      toast('活動名唔准空', 'error');
      return;
    }
    if (name === selected.name) {
      setRenaming(false);
      return;
    }
    renameMut.mutate({ eventId: selected.id, name });
  };

  /** v2.5.8：刪活動（確認講明後果＋pending 防雙擊） */
  const confirmDeleteEvent = () => {
    if (!selected || deleteEventMut.isPending) return;
    if (
      window.confirm(
        `確定刪除活動《${selected.name}》？\n\n` +
          `・${selected.entryCount} 位劵持有人資料會一併刪除\n` +
          `・已抽出嘅 ${selected.drawnCount} 筆中獎紀錄會留底（同活動解綁），官網訂單同其他業務資料唔受影響\n` +
          `・公開公告頁會即時顯示「活動已刪除」\n\n刪咗唔返得轉。`,
      )
    ) {
      deleteEventMut.mutate({ eventId: selected.id });
    }
  };

  /** v2.5.8：複製公開公告連結 */
  const copyPublicLink = async () => {
    if (!selected) return;
    const url = publicResultsUrl(selected.id);
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      window.prompt('複製公開公告連結：', url);
    }
  };

  /** v2.5.8：下載公告 PNG（1080×1350；內容＝真實中獎結果，同公開頁同一口径） */
  const downloadPng = async () => {
    if (!selected || pngBusy) return;
    setPngBusy(true);
    try {
      const rows = (await utils.luckyDraw.adminEventWinners.fetch({ eventId: selected.id })).winners as EventWinner[];
      const standing = rows.filter((r) => r.status === 'pending' || r.status === 'confirmed');
      const last = standing[standing.length - 1];
      const ok = await downloadAnnouncementPng(
        {
          eventName: selected.name,
          drawnAtLabel: last ? fmtDateTime(String(last.createdAt)) : null,
          winners: standing.map((r) => ({
            name: r.winnerNameSnap ?? r.winnerName ?? '',
            prizeName: r.prizeName,
          })),
        },
        `RedCode中獎公告-${selected.name.replace(/[\\/:*?"<>|]/g, '')}.png`,
      );
      if (ok) toast('公告 PNG 已下載（1080×1350）', 'success');
      else toast('呢個瀏覽器整唔到 PNG，請用 Chrome/Safari 再試', 'error');
    } catch (e) {
      toast(fmtErr(e), 'error');
    } finally {
      setPngBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      {/* 活動 picker */}
      {eventsQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊活動…" />
      ) : eventsQuery.isError ? (
        <div className="rounded-lg border px-2.5 py-2 text-[12.5px] text-pink-soft" style={{ borderColor: 'rgba(255,0,84,0.4)' }} role="alert">
          活動載入失敗：{fmtErr(eventsQuery.error)}
          <button
            type="button"
            onClick={() => void eventsQuery.refetch()}
            className="ml-2 underline underline-offset-2 hover:text-txt-1"
          >
            重試
          </button>
        </div>
      ) : events.length === 0 ? (
        <p className="text-[12.5px] text-txt-3">仲未有抽獎劵活動，下面開第一個 ✦</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {events.map((ev) => {
            const active = ev.id === selectedEventId;
            const archived = ev.archivedAt != null;
            return (
              <button
                key={ev.id}
                type="button"
                onClick={() => onSelectEvent(ev.id)}
                aria-pressed={active}
                title={ev.name}
                className={`max-w-full rounded-full border px-2.5 py-1 text-left text-[12.5px] transition-colors ${
                  active ? 'text-txt-1' : 'text-txt-2 hover:text-txt-1'
                } ${archived ? 'opacity-55' : ''}`}
                style={{
                  borderColor: active ? '#F5C518' : 'var(--space-line)',
                  background: active ? 'rgba(245,197,24,0.12)' : 'transparent',
                }}
              >
                <span className="inline-block max-w-[200px] truncate align-middle">{ev.name}</span>
                <span className="ml-1 font-mono text-[11px] text-txt-3">
                  （{ev.entryCount} 人・{ev.totalTickets} 張{archived ? '・已歸檔' : ''}）
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 開活動 */}
      <div className="grid min-w-0 grid-cols-1 gap-2 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]" style={{ borderColor: 'var(--space-line)' }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="活動名（例：11月週年祭抽獎劵）"
          maxLength={128}
          className="min-w-0 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-[12.5px] text-txt-1 outline-none focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <label className="flex items-center gap-1.5 text-[12px] text-txt-2">
          每人限中
          <input
            type="number"
            min={1}
            max={100}
            value={newMaxWins}
            onChange={(e) => setNewMaxWins(e.target.value)}
            className="w-16 rounded-lg border bg-transparent px-2 py-1 text-center font-mono text-[12.5px] text-txt-1 outline-none focus:border-lavender"
            style={{ borderColor: 'var(--space-line)' }}
          />
          次
        </label>
        <button
          type="button"
          onClick={create}
          disabled={busy || !newName.trim()}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-[12.5px] font-bold disabled:opacity-40"
          style={{ background: '#F5C518', color: '#241505' }}
        >
          <Plus size={13} aria-hidden="true" />
          開活動
        </button>
        <p className="text-[11px] leading-relaxed text-txt-3 sm:col-span-3">
          限中口径：全活動累計——同一持有人喺呢個活動中夠 N 次（待回應＋已確認都計）就抽唔中；取消／客人唔要唔計。開咗之後唔改得。
        </p>
      </div>

      {/* 揀中活動：詳情＋劵名單＋匯入 */}
      {selected && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-txt-2">
            <Ticket size={13} aria-hidden="true" className="shrink-0 text-gold" />
            {renaming ? (
              /* v2.5.8：inline 改名（原位展開，唔用全屏彈窗） */
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  maxLength={128}
                  aria-label="新活動名"
                  className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1 text-[12.5px] text-txt-1 outline-none focus:border-lavender"
                  style={{ borderColor: '#F5C518' }}
                />
                <button
                  type="button"
                  onClick={commitRename}
                  disabled={renameMut.isPending}
                  className="shrink-0 rounded-lg border px-2.5 py-1 text-[11.5px] font-bold text-gold disabled:opacity-40"
                  style={{ borderColor: 'rgba(245,197,24,0.5)' }}
                >
                  {renameMut.isPending ? '改名緊…' : '確定'}
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  className="shrink-0 rounded-lg border px-2.5 py-1 text-[11.5px] text-txt-3"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  取消
                </button>
              </span>
            ) : (
              <b className="min-w-0 max-w-full truncate text-txt-1" title={selected.name}>
                {selected.name}
              </b>
            )}
            <span className="font-mono text-[11.5px] text-txt-3">
              {selected.entryCount} 人・共 {selected.totalTickets} 張劵・已抽出 {selected.drawnCount} 件・每人限中 {selected.maxWinsPerPerson} 次
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* v2.5.8（老闆指令）：改名掣 */}
              <button
                type="button"
                onClick={() => {
                  setRenameValue(selected.name);
                  setRenaming(true);
                }}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] text-txt-3 transition-colors hover:text-gold disabled:opacity-40"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Pencil size={11} aria-hidden="true" />
                改名
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = selected.archivedAt == null;
                  if (
                    window.confirm(
                      target
                        ? `歸檔活動《${selected.name}》？歸檔後唔再匯入、唔再抽得；中獎紀錄照舊睇到。`
                        : `放返活動《${selected.name}》出嚟？`,
                    )
                  ) {
                    archiveMut.mutate({ eventId: selected.id, archived: target });
                  }
                }}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] text-txt-3 transition-colors hover:text-gold disabled:opacity-40"
                style={{ borderColor: 'var(--space-line)' }}
              >
                {selected.archivedAt == null ? <Archive size={11} aria-hidden="true" /> : <ArchiveRestore size={11} aria-hidden="true" />}
                {selected.archivedAt == null ? '歸檔' : '取消歸檔'}
              </button>
              {/* v2.5.8（老闆指令）：刪除成個活動（中獎紀錄留底，訂單唔受影響） */}
              <button
                type="button"
                onClick={confirmDeleteEvent}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-40"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Trash2 size={11} aria-hidden="true" />
                {deleteEventMut.isPending ? '刪除緊…' : '刪除活動'}
              </button>
            </span>
          </div>

          {/* v2.5.8（老闆指令「每場活動有位置睇中獎人」）：內部中獎名單——
              全部係真實抽獎結果＋現有跟進資料（狀態／通知／單號），唔會虛構或重抽 */}
          <div className="rounded-lg border" style={{ borderColor: 'var(--space-line)' }}>
            <button
              type="button"
              onClick={() => setShowWinners((s) => !s)}
              aria-expanded={showWinners}
              className="flex w-full items-center justify-between px-2.5 py-2 text-left text-[12px] text-txt-2 transition-colors hover:bg-white/5"
            >
              <span className="inline-flex items-center gap-1.5">
                <Trophy size={12} aria-hidden="true" className="text-gold" />
                中獎名單（真實抽獎結果・{selected.drawnCount} 筆企得硬）
              </span>
              <span
                aria-hidden="true"
                className="inline-block text-txt-3"
                style={{ transition: 'transform 200ms', transform: showWinners ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                ▾
              </span>
            </button>
            {showWinners && (
              winnersQuery.isLoading ? (
                <p className="px-2.5 pb-2 text-[12px] text-txt-3">載入緊…</p>
              ) : winnersQuery.isError ? (
                <p className="px-2.5 pb-2 text-[12px] text-pink-soft" role="alert">
                  載入失敗：{fmtErr(winnersQuery.error)}
                  <button type="button" onClick={() => void winnersQuery.refetch()} className="ml-2 underline underline-offset-2">重試</button>
                </p>
              ) : winners.length === 0 ? (
                <p className="px-2.5 pb-2 text-[12px] text-txt-3">呢場仲未抽過獎</p>
              ) : (
                <ul className="max-h-[260px] space-y-1 overflow-y-auto px-2.5 pb-2 pr-1">
                  {winners.map((w) => (
                    <li
                      key={w.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px]"
                      style={{ borderColor: 'var(--space-line)' }}
                    >
                      <span className="min-w-0 truncate text-txt-1" title={w.winnerNameSnap ?? w.winnerName ?? ''}>
                        {w.winnerNameSnap ?? w.winnerName}
                      </span>
                      <span
                        className="shrink-0 rounded-full border px-2 py-px text-[10.5px]"
                        style={{
                          color: w.status === 'confirmed' ? '#7BD88F' : w.status === 'pending' ? 'var(--gold-soft)' : 'var(--text-3, #9d93b8)',
                          borderColor: w.status === 'confirmed' ? 'rgba(123,216,143,0.45)' : w.status === 'pending' ? 'rgba(245,197,24,0.45)' : 'var(--space-line)',
                        }}
                      >
                        {winnerStatusLabel(w.status)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt-3" title={w.prizeName}>
                        {w.prizeName}
                        <span className="font-mono">（{w.prizeSku}・HK${w.prizePrice}）</span>
                      </span>
                      <span className="shrink-0 font-mono text-[10.5px] text-txt-3">
                        {fmtDateTime(String(w.createdAt))}
                        {w.orderNo ? `・${w.orderNo}` : ''}
                        {w.status === 'pending' ? (w.notifiedAt ? '・已通知' : '・未通知') : ''}
                        {w.redrawOfId ? `・重抽取代 #${w.redrawOfId}` : ''}
                        {w.cancelNote ? `・${w.cancelNote}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          {/* v2.5.8（老闆指令「公開抽獎公告」）：公開頁連結＋FB 分享＋公告 PNG */}
          <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: 'rgba(245,197,24,0.35)' }}>
            <p className="text-[12px] font-semibold text-gold-soft">公開中獎公告（對外只放活動名＋抽獎時間＋中獎人名，唔放電話／會員編號／地址）</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void copyPublicLink()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11.5px] text-txt-2 transition-colors hover:text-gold disabled:opacity-40"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Copy size={11} aria-hidden="true" />
                {linkCopied ? '已複製 ✓' : '複製公開連結'}
              </button>
              <a
                href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicResultsUrl(selected.id))}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11.5px] text-txt-2 transition-colors hover:text-gold"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Share2 size={11} aria-hidden="true" />
                Facebook 分享
              </a>
              <a
                href={publicResultsUrl(selected.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11.5px] text-txt-2 transition-colors hover:text-gold"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Facebook size={11} aria-hidden="true" />
                預覽公開頁
              </a>
              <button
                type="button"
                onClick={() => void downloadPng()}
                disabled={busy || pngBusy}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-bold disabled:opacity-40"
                style={{ background: '#F5C518', color: '#241505' }}
              >
                <ImageDown size={11} aria-hidden="true" />
                {pngBusy ? '整緊 PNG…' : '下載公告 PNG（1080×1350）'}
              </button>
            </div>
          </div>

          {/* 劵名單（每人劵數＋已中次數） */}
          <div className="rounded-lg border" style={{ borderColor: 'var(--space-line)' }}>
            <button
              type="button"
              onClick={() => setShowEntries((s) => !s)}
              aria-expanded={showEntries}
              className="flex w-full items-center justify-between px-2.5 py-2 text-left text-[12px] text-txt-2 transition-colors hover:bg-white/5"
            >
              <span>
                參加者劵數列表（{entries.length} 人・總共 {totalTickets} 張）
              </span>
              <span
                aria-hidden="true"
                className="inline-block text-txt-3"
                style={{ transition: 'transform 200ms', transform: showEntries ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                ▾
              </span>
            </button>
            {showEntries && (
              entriesQuery.isLoading ? (
                <p className="px-2.5 pb-2 text-[12px] text-txt-3">載入緊…</p>
              ) : entriesQuery.isError ? (
                <p className="px-2.5 pb-2 text-[12px] text-pink-soft" role="alert">
                  載入失敗：{fmtErr(entriesQuery.error)}
                  <button type="button" onClick={() => void entriesQuery.refetch()} className="ml-2 underline underline-offset-2">重試</button>
                </p>
              ) : entries.length === 0 ? (
                <p className="px-2.5 pb-2 text-[12px] text-txt-3">仲未有劵——下面用 Excel 匯入</p>
              ) : (
                <ul className="max-h-[220px] space-y-1 overflow-y-auto px-2.5 pb-2 pr-1">
                  {entries.map((en) => (
                    <li
                      key={en.id}
                      className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px]"
                      style={{ borderColor: 'var(--space-line)' }}
                    >
                      <span className="min-w-0 truncate text-txt-1" title={en.holderName}>
                        {en.holderName}
                        {en.winCount > 0 && (
                          <span className="ml-1.5 rounded-full border px-1.5 py-px text-[10.5px] text-gold" style={{ borderColor: 'rgba(245,197,24,0.4)' }}>
                            已中 {en.winCount}/{selected.maxWinsPerPerson}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[11.5px] text-txt-3">{en.ticketCount} 張</span>
                        <button
                          type="button"
                          aria-label={`刪除劵持有人 ${en.holderName}`}
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`刪除「${en.holderName}」（${en.ticketCount} 張劵）？`)) {
                              deleteEntryMut.mutate({ entryId: en.id });
                            }
                          }}
                          className="rounded-md border p-1 text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-40"
                          style={{ borderColor: 'var(--space-line)' }}
                        >
                          <Trash2 size={11} aria-hidden="true" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          <LuckyDrawExcelImport
            kind="ticket"
            eventId={selected.id}
            eventArchived={selected.archivedAt != null}
            toast={toast}
            onCommitted={() => invalidateEvents()}
          />

          <p className="font-mono text-[10.5px] text-txt-3">
            開立：{fmtDateTime(String(selected.createdAt))}{selected.createdByName ? `・${selected.createdByName}` : ''}
            {selected.archivedAt ? `・已歸檔 ${fmtDateTime(String(selected.archivedAt))}${selected.archivedByName ? `・${selected.archivedByName}` : ''}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
