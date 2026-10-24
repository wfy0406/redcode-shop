import { useState } from 'react';
import { Archive, ArchiveRestore, Plus, Ticket, Trash2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';
import LuckyDrawExcelImport from './LuckyDrawExcelImport';

/**
 * LuckyDrawEventPanel —— 抽獎劵活動管理（v2.5.6，LuckyDrawPanel 劵模式右欄）
 *
 * 合約（api/luckyDrawRouter.ts 現況）：
 *   adminCreateEvent{name(≤128), maxWinsPerPerson(1–100)}——限中係全活動累計（pending+confirmed 計），
 *     建立時設定，冇 update endpoint → 現有活動唯讀顯示口径；
 *   adminListEvents→＋entryCount/totalTickets/drawnCount/archivedAt；
 *   adminSetEventArchived（歸檔＝唔再匯入/抽得，紀錄留底；活動唔硬刪 by design）；
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

  const busy = createMut.isPending || archiveMut.isPending || deleteEntryMut.isPending;

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
            <b className="min-w-0 max-w-full truncate text-txt-1" title={selected.name}>
              {selected.name}
            </b>
            <span className="font-mono text-[11.5px] text-txt-3">
              {selected.entryCount} 人・共 {selected.totalTickets} 張劵・已抽出 {selected.drawnCount} 件・每人限中 {selected.maxWinsPerPerson} 次
            </span>
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
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] text-txt-3 transition-colors hover:text-gold disabled:opacity-40"
              style={{ borderColor: 'var(--space-line)' }}
            >
              {selected.archivedAt == null ? <Archive size={11} aria-hidden="true" /> : <ArchiveRestore size={11} aria-hidden="true" />}
              {selected.archivedAt == null ? '歸檔' : '取消歸檔'}
            </button>
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
