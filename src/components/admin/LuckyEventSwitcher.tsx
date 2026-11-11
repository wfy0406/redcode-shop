import { useEffect, useId, useState } from 'react';
import { Check, ChevronDown, Ticket } from 'lucide-react';

export type DrawEvent = {
  id: number;
  name: string;
  maxWinsPerPerson: number;
  scheduledDrawDate: string | null;
  winnersPublic: boolean;
  entryCount: number;
  totalTickets: number;
  drawnCount: number;
  archivedAt: string | Date | null;
  archivedByName: string | null;
  createdAt: string | Date;
  createdByName: string | null;
};

/** 目前活動一行摘要＋原位展開索引；活動再多都唔會長期排滿管理頁。 */
export default function LuckyEventSwitcher({
  events,
  selectedEventId,
  onSelectEvent,
}: {
  events: DrawEvent[];
  selectedEventId: number | null;
  onSelectEvent: (id: number) => void;
}) {
  const selected = events.find((event) => event.id === selectedEventId) ?? null;
  const [expanded, setExpanded] = useState(selectedEventId == null);
  const listId = useId();

  useEffect(() => {
    setExpanded(selectedEventId == null);
  }, [selectedEventId]);

  const choose = (id: number) => {
    onSelectEvent(id);
    setExpanded(false);
  };

  return (
    <section
      className="overflow-hidden rounded-xl border"
      aria-label="抽獎券活動選擇器"
      style={{
        borderColor: expanded ? 'rgba(245,197,24,0.52)' : 'var(--space-line)',
        background: selected
          ? 'radial-gradient(circle at 100% 0%, rgba(245,197,24,0.10), transparent 46%), linear-gradient(145deg, rgba(245,197,24,0.055), rgba(255,255,255,0.018))'
          : 'rgba(255,255,255,0.018)',
        boxShadow: expanded ? '0 14px 40px rgba(0,0,0,0.22), inset 0 1px rgba(255,246,216,0.06)' : 'inset 0 1px rgba(255,255,255,0.035)',
      }}
    >
      <style>{`
        @keyframes luckyEventSwitchIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) { .lucky-event-switch-list { animation: none !important; } }
        .lucky-event-switch-button:focus-visible { outline: 2px solid #F9E27D; outline-offset: -3px; }
      `}</style>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={listId}
        className="lucky-event-switch-button block w-full min-w-0 px-3 py-3 text-left transition-colors hover:bg-white/[0.025]"
      >
        <span className="flex w-full min-w-0 items-start gap-2.5">
          <Ticket size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-gold" />
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[9.5px] font-semibold uppercase tracking-[0.20em] text-gold-soft">
              Current draw・目前活動
            </span>
            <span className="mt-1 block break-words font-serif-tc text-[14px] font-bold leading-snug text-txt-1">
              {selected?.name ?? '請揀一個抽獎券活動'}
            </span>
            {selected && (
              <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10.5px] leading-relaxed text-txt-3">
                <span>[{selected.entryCount} 人]</span>
                <span>[{selected.totalTickets} 張券]</span>
                <span>[已抽 {selected.drawnCount} 件]</span>
                <span className={selected.archivedAt ? 'text-pink-soft' : 'text-gold-soft'}>
                  [{selected.archivedAt ? '已歸檔' : '進行中'}]
                </span>
              </span>
            )}
          </span>
        </span>
        <span className="mt-2.5 flex w-full items-center justify-between gap-3 border-t pt-2" style={{ borderColor: 'rgba(245,197,24,0.16)' }}>
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-txt-3">活動索引・共 {events.length} 場</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-gold-soft">
            {expanded ? '收埋列表' : `揀活動（${events.length}）`}
            <ChevronDown
              size={14}
              aria-hidden="true"
              style={{ transition: 'transform 180ms ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
            />
          </span>
        </span>
      </button>

      {expanded && (
        <div
          id={listId}
          role="group"
          aria-label="所有抽獎券活動"
          className="lucky-event-switch-list max-h-[340px] overflow-y-auto border-t"
          style={{
            borderColor: 'rgba(245,197,24,0.22)',
            animation: 'luckyEventSwitchIn 180ms cubic-bezier(0.2,0.8,0.2,1)',
            scrollbarColor: 'rgba(245,197,24,0.45) transparent',
          }}
        >
          {events.map((event) => {
            const active = event.id === selectedEventId;
            const archived = event.archivedAt != null;
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => choose(event.id)}
                aria-pressed={active}
                className="lucky-event-switch-button flex w-full min-w-0 items-start gap-2.5 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.04]"
                style={{
                  borderColor: 'var(--space-line)',
                  background: active ? 'linear-gradient(90deg, rgba(245,197,24,0.14), rgba(245,197,24,0.025))' : 'transparent',
                  opacity: archived && !active ? 0.62 : 1,
                }}
              >
                <span className={`mt-0.5 w-4 shrink-0 font-mono text-[12px] ${active ? 'text-gold' : 'text-txt-3'}`} aria-hidden="true">
                  {active ? <Check size={14} /> : '·'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block break-words text-[12.5px] leading-snug ${active ? 'font-bold text-gold-soft' : 'font-semibold text-txt-1'}`}>
                    {event.name}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] leading-relaxed text-txt-3">
                    <span>[{event.entryCount} 人]</span>
                    <span>[{event.totalTickets} 張]</span>
                    <span>[已抽 {event.drawnCount}]</span>
                    {archived && <span className="text-pink-soft">[已歸檔]</span>}
                    {!archived && event.winnersPublic === false && <span>[公告關]</span>}
                  </span>
                </span>
                <span className={`shrink-0 pt-0.5 text-[10px] ${active ? 'text-gold' : 'text-txt-3'}`}>
                  {active ? '使用中' : '揀呢場'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
