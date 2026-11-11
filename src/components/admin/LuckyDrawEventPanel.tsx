import { useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Copy, Facebook, ImageDown, Megaphone, Pencil, Plus, Share2, Ticket, TicketCheck, Trash2, Trophy } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';
import LuckyDrawExcelImport from './LuckyDrawExcelImport';
import { downloadAnnouncementPng } from '@/lib/luckyAnnouncementPng';
import { resetLuckyAnnouncementPublicQueries } from '@/lib/luckyAnnouncementVisibility';

/**
 * LuckyDrawEventPanel —— 抽獎劵活動管理（v2.5.6，LuckyDrawPanel 劵模式右欄）
 *
 * 合約（api/luckyDrawRouter.ts 現況）：
 *   adminCreateEvent{name(≤128), maxWinsPerPerson(1–100), scheduledDrawDate(YYYYMMDD 真實曆日)}——
 *     限中係全活動累計（pending+confirmed 計），建立時設定，冇 update endpoint → 現有活動唯讀顯示口径；
 *     預定抽獎日（v2026.10.26.2）建立必填真實曆日，開咗之後可以用 adminSetEventScheduledDrawDate 改；
 *   adminListEvents→＋entryCount/totalTickets/drawnCount/archivedAt/scheduledDrawDate；
 *   adminSetEventArchived（歸檔＝唔再匯入/抽得，紀錄留底）；
 *   v2.5.8（老闆指令）：adminRenameEvent（改名，唔郁劵數/紀錄）＋ adminDeleteEvent
 *     （刪成個活動：中獎紀錄解綁留底，訂單唔受影響；確認＋mutation pending 防雙擊）；
 *   adminEventWinners（每場活動內部中獎名單＝真實抽獎結果＋跟進資料）；
 *   adminListEventEntries{eventId}→entries(+winCount)＋totalTickets；
 *   adminDeleteEventEntry（有中獎紀錄 FK 擋 → CONFLICT 原句彈出）；
 *   v2026.11.08：adminSetEventWinnersPublic（每場公告開關；關咗收埋公開公告 link／FB／預覽／PNG，
 *     內部中獎名單主管照舊睇到）；adminAddEventEntry（手動新增姓名＋劵數，同名 server 加劵）；
 *     adminSetEventEntryTicketCount（每列改總劵數）；adminDeleteEventEntries（批量刪除，
 *     任何已中獎者整批拒絕）；查劵公開 link（/lucky-tickets/:eventId）永遠可複製／預覽／FB 分享。
 *   v2026.11.11.2（老闆指令）：adminGetAnnouncementPublic／adminSetAnnouncementPublic——
 *     對外抽獎公告「總開關」（預設關閉；切換係管理員專用、後端強制，主管只睇到現況）。
 *     關閉＝成個對外公告功能收埋（總覽／單場 URL／Navbar 入口／首口 HTML／sitemap），
 *     只保留獨立查劵 link；對外可見＝總開關開 AND 該場 winnersPublic。
 * Excel 匯入抽獎劵由 LuckyDrawExcelImport（kind="ticket"）處理。
 */

export type DrawEvent = {
  id: number;
  name: string;
  maxWinsPerPerson: number;
  scheduledDrawDate: string | null;
  // v2026.11.08：每場公開中獎公告開關（true＝公開頁／總覽正常顯示；false＝公開收埋，內部照舊）
  winnersPublic: boolean;
  entryCount: number;
  totalTickets: number;
  drawnCount: number;
  archivedAt: string | Date | null;
  archivedByName: string | null;
  createdAt: string | Date;
  createdByName: string | null;
};

const BATCH_DELETE_LIMIT = 500;

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

/** v2026.11.08：公開查劵 URL（正式乾淨路徑 /lucky-tickets/:eventId）。
 *  後台本身係 /admin：唔可以用 pathname＋hash，否則 FB crawler 只會見到 /admin。
 *  server vite fallback 已支援呢條正式路徑；舊 #/ lucky link 仍由 main.tsx 收容。 */
function publicTicketLookupUrl(eventId: number): string {
  return `${window.location.origin}/lucky-tickets/${eventId}`;
}

/** YYYYMMDD → date input 格式 YYYY-MM-DD（null/唔啱格式 → 空串） */
function ymdToDateInput(ymd: string | null | undefined): string {
  return ymd && /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : '';
}

/** date input 值（YYYY-MM-DD）→ YYYYMMDD；唔啱格式 → null */
function dateInputToYmd(v: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.replaceAll('-', '') : null;
}

/** YYYYMMDD 係咪真實曆日（同年 API 層守衛口径：月份 01–12＋該月真實日數＋閏年） */
function isRealCalendarYmd(ymd: string): boolean {
  if (!/^\d{8}$/.test(ymd)) return false;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 顯示用：YYYYMMDD → YYYY-MM-DD */
function fmtYmd(ymd: string): string {
  return ymdToDateInput(ymd) || ymd;
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
  // v2026.11.11.2：對外公告總開關係管理員專用（後端 adminProcedure 強制）；主管只睇現況
  const { user: me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const [newName, setNewName] = useState('');
  const [newMaxWins, setNewMaxWins] = useState('1');
  // v2026.10.26.2：開活動必填預定抽獎日（date input 值 YYYY-MM-DD）
  const [newDrawDate, setNewDrawDate] = useState('');
  const [showEntries, setShowEntries] = useState(true);
  // v2.5.8：改名 inline 編輯＋中獎名單展開＋公告動作 state
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // v2026.10.26.2：所選活動 inline 改預定抽獎日（date input 值 YYYY-MM-DD）
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [showWinners, setShowWinners] = useState(false);
  const [pngBusy, setPngBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // v2026.11.08：查劵 link 複製回饋＋手動新增 entry＋每列改總劵數＋checkbox 批量刪除 state
  const [ticketLinkCopied, setTicketLinkCopied] = useState(false);
  const [addName, setAddName] = useState('');
  const [addTickets, setAddTickets] = useState('1');
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [entryTicketsValue, setEntryTicketsValue] = useState('');
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<number>>(new Set());

  const eventsQuery = trpc.luckyDraw.adminListEvents.useQuery(undefined, { refetchOnWindowFocus: false });
  const events = (eventsQuery.data ?? []) as DrawEvent[];
  const selected = events.find((e) => e.id === selectedEventId) ?? null;

  // 切換活動即取消未提交嘅日期編輯，避免將上一場嘅預填值誤套到下一場。
  useEffect(() => {
    setEditingDate(false);
    setDateValue('');
  }, [selectedEventId]);

  const entriesQuery = trpc.luckyDraw.adminListEventEntries.useQuery(
    { eventId: selectedEventId ?? 0 },
    { enabled: selectedEventId != null, refetchOnWindowFocus: false },
  );
  const entries = (entriesQuery.data?.entries ?? []) as EventEntry[];
  const totalTickets = entriesQuery.data?.totalTickets ?? 0;

  // v2026.11.08：轉活動即清批量勾選＋每列編輯，避免將上一場嘅選取誤套到下一場。
  useEffect(() => {
    setCheckedIds(new Set());
    setEditingEntryId(null);
    setEntryTicketsValue('');
  }, [selectedEventId]);
  // 名單更新後剔走已唔存在嘅勾選（例如畀人刪咗／匯入重整）
  useEffect(() => {
    setCheckedIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(entries.map((e) => e.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  // v2026.11.08：已勾選嘅 entry（供批量刪除確認列人數／總劵數）
  const checkedEntries = useMemo(() => entries.filter((e) => checkedIds.has(e.id)), [entries, checkedIds]);
  const checkedTickets = useMemo(() => checkedEntries.reduce((s, e) => s + e.ticketCount, 0), [checkedEntries]);
  // 已中獎者（winCount>0）受保護唔准勾選；可勾選先計全選
  const selectableIds = useMemo(() => entries.filter((e) => e.winCount === 0).map((e) => e.id), [entries]);
  // API 每批最多 500 人：大場全選只揀首 500 並明示分批，唔會送到 server 先彈 raw zod 錯。
  const selectableBatchIds = useMemo(() => selectableIds.slice(0, BATCH_DELETE_LIMIT), [selectableIds]);

  const invalidateEvents = () => {
    void utils.luckyDraw.adminListEvents.invalidate();
    void utils.luckyDraw.adminListEventEntries.invalidate();
    // 劵數／名單變動會影響獎品剩餘件數顯示口径，一併刷新
    void utils.luckyDraw.adminListPrizes.invalidate();
  };

  const createMut = trpc.luckyDraw.adminCreateEvent.useMutation({
    onSuccess: (ev) => {
      toast(`活動《${ev.name}》已建立（每人全活動限中 ${ev.maxWinsPerPerson} 次）`, 'success');
      // 只有伺服器確認建立先清表格；失敗時保留管理員已輸入嘅名稱、日期同限中次數。
      setNewName('');
      setNewMaxWins('1');
      setNewDrawDate('');
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
  // v2026.11.08：每場公開中獎公告開關（關咗公開頁即收，內部名單照舊；查劵頁唔受影響）
  const winnersPublicMut = trpc.luckyDraw.adminSetEventWinnersPublic.useMutation({
    onSuccess: (r, v) => {
      toast(
        r.winnersPublic
          ? '公開中獎公告已開啟——全網「更多」選單會顯示「中獎公告」；查劵 link 照舊可用'
          : '公開中獎公告已關閉——全部活動都關晒時，全網選單會收埋「中獎公告」；查劵 link 唔受影響',
        'success',
      );
      invalidateEvents();
      // 關閉要即時移走總覽／Navbar 嘅呢場舊資料；重開則由 invalidate 取返最新公開清單。
      if (!r.winnersPublic) {
        utils.luckyDraw.publicEvents.setData(undefined, (current) =>
          current?.filter((event) => event.id !== v.eventId),
        );
      }
      // 已開過嘅單場公告會有獨立快取；只 invalidate publicEvents 唔會郁佢。
      // 開關兩個方向都 reset 返初始狀態，下次入直接 URL 必須向 server 重查，唔准重播舊中獎名單。
      void utils.luckyDraw.publicEventResults.reset({ eventId: v.eventId });
      void utils.luckyDraw.publicEvents.invalidate();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  // v2026.11.11.2：對外抽獎公告「總開關」（預設關閉）。
  // 讀取主管＋管理員都得；切換係管理員專用（後端 adminProcedure 強制，UI 只係提示）。
  const announcementQuery = trpc.luckyDraw.adminGetAnnouncementPublic.useQuery(undefined, { refetchOnWindowFocus: false });
  // 未讀到／讀取失敗時保守當關閉顯示（server 本身預設關閉）
  const announcementOn = announcementQuery.data?.enabled === true;
  const announcementMut = trpc.luckyDraw.adminSetAnnouncementPublic.useMutation({
    onSuccess: (r) => {
      toast(
        r.enabled
          ? '對外抽獎公告總開關已開啟——每場 winnersPublic 開關照舊各自把關（總開＋該場公開先會出）；查劵 link 一直可用'
          : '對外抽獎公告總開關已關閉——對外總覽／單場公告／Navbar 入口／sitemap 即時收晒；查劵 link 唔受影響',
        'success',
      );
      void utils.luckyDraw.adminGetAnnouncementPublic.invalidate();
      // 即時清對外舊快取：總覽／Navbar／**全部 eventId** 嘅單場公告都 reset（唔只係揀中嗰場），
      // 唔准重播舊活動或舊名單（見 src/lib/luckyAnnouncementVisibility.ts；
      // 其他已開分頁聚焦或 ≤60 秒重查亦會收）。
      resetLuckyAnnouncementPublicQueries(utils);
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  /** 總開關切換（管理員專用；兩個方向都 confirm 講明後果；pending 防雙擊） */
  const toggleAnnouncementPublic = () => {
    if (!isAdmin || announcementMut.isPending) return;
    const target = !announcementOn;
    const ok = window.confirm(
      target
        ? '重新開啟成個對外抽獎公告功能？\n\n・對外公告總覽、單場公告 URL、Navbar「中獎公告」入口同 sitemap 會即時恢復\n・每場 winnersPublic 開關照舊各自把關——總開關開 AND 該場公開先會對外顯示\n・獨立抽獎劵查詢 link 一直唔受影響'
        : '關閉成個對外抽獎公告功能？\n\n・對外公告總覽、全部單場公告 URL、Navbar「中獎公告」入口同 sitemap 嘅公告 URL 會即時收埋（SEO noindex／首口 HTML 唔再注入公告內容）\n・舊公告連結會顯示「對外公告已關閉」，唔會殘留任何中獎名單\n・獨立抽獎劵查詢 link 同查劵 API 照常可用',
    );
    if (ok) announcementMut.mutate({ enabled: target });
  };
  // v2026.11.08：手動新增姓名＋劵數（同人 normalizedName 精確重複 → server 自動加劵）
  const addEntryMut = trpc.luckyDraw.adminAddEventEntry.useMutation({
    onSuccess: (r) => {
      toast(
        r.created
          ? `已新增「${r.entry.holderName}」（${r.addedTickets} 張劵）`
          : `「${r.entry.holderName}」本來已喺名單，已加多 ${r.addedTickets} 張（而家共 ${r.entry.ticketCount} 張）`,
        'success',
      );
      setAddName('');
      setAddTickets('1');
      invalidateEvents();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  // v2026.11.08：每列改總劵數（只改劵數，唔改名；上限由 server 鎖內重檢）
  const setTicketCountMut = trpc.luckyDraw.adminSetEventEntryTicketCount.useMutation({
    onSuccess: (r) => {
      toast(`「${r.entry.holderName}」嘅總劵數已改做 ${r.entry.ticketCount} 張`, 'success');
      setEditingEntryId(null);
      setEntryTicketsValue('');
      invalidateEvents();
    },
    onError: (e) => toast(fmtErr(e), 'error'),
  });
  // v2026.11.08：批量刪除（任何已中獎者 → server 整批 CONFLICT 拒絕，錯誤原句彈出）
  const deleteEntriesMut = trpc.luckyDraw.adminDeleteEventEntries.useMutation({
    onSuccess: (r) => {
      toast(`已刪除 ${r.deletedCount} 位劵持有人（共 ${r.ticketCount} 張劵）`, 'success');
      setCheckedIds(new Set());
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
  // v2026.10.26.2（老闆指令）：改預定抽獎日（唔郁限中／歸檔／已抽紀錄）
  const drawDateMut = trpc.luckyDraw.adminSetEventScheduledDrawDate.useMutation({
    onSuccess: (r) => {
      toast(`預定抽獎日已改做 ${fmtYmd(r.scheduledDrawDate)}`, 'success');
      setEditingDate(false);
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
    const ymd = dateInputToYmd(newDrawDate);
    if (!ymd) {
      toast('請揀預定抽獎日', 'error');
      return;
    }
    if (!isRealCalendarYmd(ymd)) {
      toast('預定抽獎日唔係真實曆日', 'error');
      return;
    }
    createMut.mutate({ name, maxWinsPerPerson: mw, scheduledDrawDate: ymd });
  };

  const busy =
    createMut.isPending ||
    archiveMut.isPending ||
    deleteEntryMut.isPending ||
    renameMut.isPending ||
    drawDateMut.isPending ||
    deleteEventMut.isPending ||
    winnersPublicMut.isPending ||
    addEntryMut.isPending ||
    setTicketCountMut.isPending ||
    deleteEntriesMut.isPending ||
    announcementMut.isPending;

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

  /** v2026.10.26.2：預定抽獎日提交（無改動／pending 唔出 request；假曆日即場擋） */
  const commitDrawDate = () => {
    if (!selected || drawDateMut.isPending) return;
    const ymd = dateInputToYmd(dateValue);
    if (!ymd) {
      toast('請揀預定抽獎日', 'error');
      return;
    }
    if (!isRealCalendarYmd(ymd)) {
      toast('預定抽獎日唔係真實曆日', 'error');
      return;
    }
    if (ymd === selected.scheduledDrawDate) {
      setEditingDate(false);
      return;
    }
    drawDateMut.mutate({ eventId: selected.id, scheduledDrawDate: ymd });
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

  /** v2026.11.08：複製公開查劵連結（唔受公告開關影響，永遠可複製） */
  const copyTicketLookupLink = async () => {
    if (!selected) return;
    const url = publicTicketLookupUrl(selected.id);
    try {
      await navigator.clipboard.writeText(url);
      setTicketLinkCopied(true);
      window.setTimeout(() => setTicketLinkCopied(false), 2000);
    } catch {
      window.prompt('複製公開查劵連結：', url);
    }
  };

  /** v2026.11.08：公告開關（關閉有確認講明後果；mutation pending 防雙擊） */
  const toggleWinnersPublic = () => {
    if (!selected || winnersPublicMut.isPending) return;
    const target = !selected.winnersPublic;
    const ok = window.confirm(
      target
        ? `重新公開活動《${selected.name}》嘅中獎公告？\n\n・公開公告頁同公告總覽會即時顯示呢場中獎名單\n・全網「更多」選單會喺至少一場公告公開時顯示「中獎公告」\n・獨立抽獎劵查詢 link 照舊可用`
        : `關閉活動《${selected.name}》嘅公開中獎公告？\n\n・公開公告頁同公告總覽會即時收埋呢場\n・如果其他活動都關晒，全網「更多」選單嘅「中獎公告」會自動消失\n・獨立抽獎劵查詢 link 唔受影響，客人照舊查到自己有幾多張劵\n・內部中獎名單主管照舊睇到`,
    );
    if (ok) winnersPublicMut.mutate({ eventId: selected.id, winnersPublic: target });
  };

  /** v2026.11.08：手動新增姓名＋劵數（同人重複 → server 自動加劵；歸檔活動 server 會擋） */
  const addEntry = () => {
    if (!selected || addEntryMut.isPending) return;
    const holderName = addName.trim();
    if (!holderName) {
      toast('姓名唔准空', 'error');
      return;
    }
    const raw = Number(addTickets);
    if (!Number.isInteger(raw) || raw < 1 || raw > 10000) {
      toast('劵數要係 1–10000（整數）', 'error');
      return;
    }
    addEntryMut.mutate({ eventId: selected.id, holderName, ticketCount: raw });
  };

  /** v2026.11.08：每列改總劵數提交（無改動／pending 唔出 request） */
  const commitEntryTickets = (en: EventEntry) => {
    if (setTicketCountMut.isPending) return;
    const raw = Number(entryTicketsValue);
    if (!Number.isInteger(raw) || raw < 1 || raw > 10000) {
      toast('劵數要係 1–10000（整數）', 'error');
      return;
    }
    if (raw === en.ticketCount) {
      setEditingEntryId(null);
      setEntryTicketsValue('');
      return;
    }
    setTicketCountMut.mutate({ entryId: en.id, ticketCount: raw });
  };

  /** v2026.11.08：批量刪除（確認列實際人數＋總劵數；已中獎者 server 整批拒絕） */
  const batchDeleteEntries = () => {
    if (!selected || checkedEntries.length === 0 || deleteEntriesMut.isPending) return;
    if (checkedEntries.length > BATCH_DELETE_LIMIT) {
      toast(`每次最多刪 ${BATCH_DELETE_LIMIT} 人，請分批揀選`, 'error');
      return;
    }
    const ok = window.confirm(
      `確定刪除已勾選嘅 ${checkedEntries.length} 位劵持有人（合共 ${checkedTickets} 張劵）？\n\n` +
        `・刪咗唔返得轉\n` +
        `・已中獎嘅人受保護：只要名單入面有任何人有中獎紀錄，成批都會被伺服器拒絕`,
    );
    if (ok) deleteEntriesMut.mutate({ eventId: selected.id, entryIds: checkedEntries.map((e) => e.id) });
  };

  /** v2026.11.08：勾選切換／當頁全選（已中獎受保護者唔喺全選範圍） */
  const toggleChecked = (id: number) => {
    if (!checkedIds.has(id) && checkedEntries.length >= BATCH_DELETE_LIMIT) {
      toast(`每次最多揀 ${BATCH_DELETE_LIMIT} 人，請先刪除呢批再揀下一批`, 'error');
      return;
    }
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setCheckedIds((prev) => {
      const allSelected = selectableBatchIds.length > 0 && selectableBatchIds.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(selectableBatchIds);
    });
    if (selectableIds.length > BATCH_DELETE_LIMIT) {
      toast(`呢場有 ${selectableIds.length} 人可揀，已揀首 ${BATCH_DELETE_LIMIT} 人；請分批刪除`, 'success');
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
          // 預定抽獎日（活動級欄，null＝舊活動未定 → PNG 如實寫「抽獎日待公佈」）
          scheduledDrawDateLabel: selected.scheduledDrawDate ? fmtYmd(selected.scheduledDrawDate) : null,
          // 實際抽出時間（最後一筆企得硬 winner；同預定日分開標示，唔會混淆）
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
      {/* v2026.11.11.2（老闆指令）：對外抽獎公告「總開關」——預設關閉；切換係管理員專用
          （後端 adminProcedure 強制），主管只睇到現況。關閉＝成個對外公告收埋，
          只保留獨立查劵 link（下面「抽獎劵查詢連結」永遠可用）。 */}
      <div
        className="rounded-lg border px-2.5 py-2"
        style={{
          borderColor: announcementOn ? 'rgba(123,216,143,0.5)' : 'rgba(255,0,84,0.45)',
          background: announcementOn ? 'rgba(123,216,143,0.06)' : 'rgba(255,0,84,0.05)',
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] font-semibold text-gold-soft">
            <Megaphone size={12} aria-hidden="true" className="mr-1 inline-block text-gold" />
            對外抽獎公告總開關（成個對外公告功能；預設關閉）
          </p>
          <button
            type="button"
            onClick={toggleAnnouncementPublic}
            disabled={!isAdmin || announcementMut.isPending || announcementQuery.isLoading}
            aria-pressed={announcementOn}
            title={
              !isAdmin
                ? '只有管理員可以切換對外公告總開關（後端強制）'
                : announcementOn
                  ? '撳一下關閉成個對外公告功能（總覽／單場公告／Navbar 入口／sitemap 即時收埋）'
                  : '撳一下重新開啟對外公告（每場 winnersPublic 開關照舊各自把關）'
            }
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-bold transition-colors disabled:opacity-40"
            style={
              announcementOn
                ? { borderColor: 'rgba(123,216,143,0.5)', color: '#7BD88F', background: 'rgba(123,216,143,0.10)' }
                : { borderColor: 'rgba(255,0,84,0.4)', color: 'var(--pink-soft)', background: 'rgba(255,0,84,0.08)' }
            }
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: announcementOn ? '#7BD88F' : 'var(--pink-soft)' }}
            />
            {announcementMut.isPending ? '切換緊…' : announcementOn ? '對外公告：開啟中' : '對外公告：已關閉'}
          </button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-txt-3">
          {announcementQuery.isError
            ? '總開關狀態載入失敗——server 預設係關閉；請重新整理或搵管理員確認。'
            : announcementOn
              ? '對外公告開啟中：對外總覽／單場公告 URL／Navbar「中獎公告」入口／sitemap 生效；每場 winnersPublic 開關照舊各自把關。'
              : '對外公告已關閉：對外總覽、全部單場公告 URL、Navbar「中獎公告」入口同 sitemap 都收埋晒，舊公告連結只會見到「對外公告已關閉」同查劵入口；每場 winnersPublic 開關保留但唔會單獨生效。'}
          獨立抽獎劵查詢 link（/lucky-tickets/:eventId）同查劵 API 唔受總開關影響，客人照舊查到自己有幾多張劵。
          {!isAdmin && '（切換要管理員權限）'}
        </p>
      </div>

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
                  （{ev.entryCount} 人・{ev.totalTickets} 張{archived ? '・已歸檔' : ''}{ev.winnersPublic === false ? '・公告關' : ''}）
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 開活動：右欄就算得三百幾 px，都保持兩欄清清楚楚，唔再將日期／按鈕迫成直書。 */}
      <div className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border p-3 sm:grid-cols-2" style={{ borderColor: 'var(--space-line)' }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="活動名（例：11月週年祭抽獎劵）"
          maxLength={128}
          className="min-w-0 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-[12.5px] text-txt-1 outline-none focus:border-lavender sm:col-span-2"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <label className="flex min-w-0 flex-col gap-1.5 text-[12px] text-txt-2">
          <span>預定抽獎日</span>
          <input
            type="date"
            value={newDrawDate}
            onChange={(e) => setNewDrawDate(e.target.value)}
            aria-label="預定抽獎日"
            className="min-w-0 w-full rounded-lg border bg-transparent px-2 py-1 font-mono text-[12.5px] text-txt-1 outline-none focus:border-lavender"
            style={{ borderColor: 'var(--space-line)', colorScheme: 'dark' }}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-[12px] text-txt-2">
          <span>每人限中次數</span>
          <span className="flex items-center gap-1.5">
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
          </span>
        </label>
        <button
          type="button"
          onClick={create}
          disabled={busy || !newName.trim() || !newDrawDate}
          className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2 text-[12.5px] font-bold disabled:opacity-40 sm:col-span-2"
          style={{ background: '#F5C518', color: '#241505' }}
        >
          <Plus size={13} aria-hidden="true" />
          開活動
        </button>
        <p className="text-[11px] leading-relaxed text-txt-3 sm:col-span-2">
          預定抽獎日係對外公佈嘅預定日期（公告頁／公告圖會照實顯示），開咗之後想改可以用活動詳情嘅「改日期」。限中口径：全活動累計——同一持有人喺呢個活動中夠 N 次（待回應＋已確認都計）就抽唔中；取消／客人唔要唔計，開咗之後唔改得。
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
            {/* v2026.10.26.2：預定抽獎日 inline 修改（Enter 提交／Escape 取消；無改動唔出 request） */}
            {editingDate ? (
              <span className="flex shrink-0 items-center gap-1.5">
                <input
                  autoFocus
                  type="date"
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitDrawDate();
                    if (e.key === 'Escape') setEditingDate(false);
                  }}
                  aria-label="新預定抽獎日"
                  className="rounded-lg border bg-transparent px-2 py-1 font-mono text-[12px] text-txt-1 outline-none focus:border-lavender"
                  style={{ borderColor: '#F5C518', colorScheme: 'dark' }}
                />
                <button
                  type="button"
                  onClick={commitDrawDate}
                  disabled={drawDateMut.isPending}
                  className="shrink-0 rounded-lg border px-2.5 py-1 text-[11.5px] font-bold text-gold disabled:opacity-40"
                  style={{ borderColor: 'rgba(245,197,24,0.5)' }}
                >
                  {drawDateMut.isPending ? '改緊…' : '確定'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingDate(false)}
                  className="shrink-0 rounded-lg border px-2.5 py-1 text-[11.5px] text-txt-3"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  取消
                </button>
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] text-txt-3">
                預定抽獎日：
                {selected.scheduledDrawDate ? (
                  <span className="text-gold-soft">{fmtYmd(selected.scheduledDrawDate)}</span>
                ) : (
                  <span>未定（對外顯示「抽獎日待公佈」）</span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDateValue(ymdToDateInput(selected.scheduledDrawDate));
                    setEditingDate(true);
                  }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] text-txt-3 transition-colors hover:text-gold disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <Pencil size={11} aria-hidden="true" />
                  改日期
                </button>
              </span>
            )}
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

          {/* v2.5.8（老闆指令「公開抽獎公告」）＋ v2026.11.08 每場公告開關：
              關閉時收埋公開 link／FB／預覽／PNG，內部中獎名單（上面）主管照舊睇到 */}
          <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: 'rgba(245,197,24,0.35)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-[12px] font-semibold text-gold-soft">
                公開中獎公告／全網選單開關（每場獨立；對外唔放電話／會員編號／地址；要上面總開關開啟先會對外顯示）
              </p>
              {/* v2026.11.08：公告開關（每場獨立；關閉有確認講明後果） */}
              <button
                type="button"
                onClick={toggleWinnersPublic}
                disabled={busy}
                aria-pressed={selected.winnersPublic}
                title={selected.winnersPublic ? '撳一下關閉此場公告；全部關晒後全網選單會收埋' : '撳一下重新公開此場公告及全網選單入口'}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-bold transition-colors disabled:opacity-40"
                style={
                  selected.winnersPublic
                    ? { borderColor: 'rgba(123,216,143,0.5)', color: '#7BD88F', background: 'rgba(123,216,143,0.10)' }
                    : { borderColor: 'rgba(255,0,84,0.4)', color: 'var(--pink-soft)', background: 'rgba(255,0,84,0.08)' }
                }
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: selected.winnersPublic ? '#7BD88F' : 'var(--pink-soft)' }}
                />
                {winnersPublicMut.isPending ? '切換緊…' : selected.winnersPublic ? '此場公告：公開中' : '此場公告：已關閉'}
              </button>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-txt-3">
              全部活動嘅公告都關閉後，全網「更多」選單會自動收埋「中獎公告」；下面嘅獨立查劵 link 唔受呢個開關影響。
              {announcementOn ? '' : '⚠️ 而家對外公告總開關係關閉中——就算呢場開咗公告，對外都唔會顯示（總開關開 AND 此場公開先會出）。'}
            </p>
            {selected.winnersPublic ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyPublicLink()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-txt-2 transition-colors hover:text-gold disabled:opacity-40"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <Copy size={11} aria-hidden="true" />
                  {linkCopied ? '已複製 ✓' : '複製公開連結'}
                </button>
                <a
                  href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicResultsUrl(selected.id))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-txt-2 transition-colors hover:text-gold"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <Share2 size={11} aria-hidden="true" />
                  Facebook 分享
                </a>
                <a
                  href={publicResultsUrl(selected.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-txt-2 transition-colors hover:text-gold"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <Facebook size={11} aria-hidden="true" />
                  預覽公開頁
                </a>
                <button
                  type="button"
                  onClick={() => void downloadPng()}
                  disabled={busy || pngBusy}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] font-bold disabled:opacity-40"
                  style={{ background: '#F5C518', color: '#241505' }}
                >
                  <ImageDown size={11} aria-hidden="true" />
                  {pngBusy ? '整緊 PNG…' : '下載公告 PNG（1080×1350）'}
                </button>
              </div>
            ) : (
              <p className="mt-2 text-[11.5px] leading-relaxed text-txt-3">
                公告已關閉：公開公告頁同公告總覽唔再顯示呢場；全部活動都關晒時，全網選單都會收埋「中獎公告」。公開 link／Facebook 分享／預覽／公告 PNG 已收埋；內部中獎名單同獨立查劵 link 唔受影響。
              </p>
            )}
          </div>

          {/* v2026.11.08：公開查劵連結——永遠可複製／預覽／Facebook 分享，唔受公告開關影響 */}
          <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: 'var(--space-line)' }}>
            <p className="text-[12px] font-semibold text-txt-2">
              <TicketCheck size={12} aria-hidden="true" className="mr-1 inline-block text-gold" />
              抽獎劵查詢連結（客人入完整姓名查自己有幾多張劵；唔受公告開關影響）
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void copyTicketLookupLink()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-txt-2 transition-colors hover:text-gold disabled:opacity-40"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Copy size={11} aria-hidden="true" />
                {ticketLinkCopied ? '已複製 ✓' : '複製查劵連結'}
              </button>
              <a
                href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicTicketLookupUrl(selected.id))}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-txt-2 transition-colors hover:text-gold"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Share2 size={11} aria-hidden="true" />
                Facebook 分享
              </a>
              <a
                href={publicTicketLookupUrl(selected.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-txt-2 transition-colors hover:text-gold"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Facebook size={11} aria-hidden="true" />
                預覽查劵頁
              </a>
            </div>
          </div>

          {/* 劵名單（每人劵數＋已中次數）；v2026.11.08：手動新增／每列改總劵數／checkbox 批量刪除 */}
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
              <div className="px-2.5 pb-2">
                {/* v2026.11.08：手動新增姓名＋劵數（同名 server 自動加劵；歸檔活動由 server 擋） */}
                <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border p-2" style={{ borderColor: 'var(--space-line)' }}>
                  <input
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addEntry();
                    }}
                    placeholder="持有人姓名"
                    maxLength={255}
                    aria-label="新增持有人姓名"
                    disabled={selected.archivedAt != null}
                    className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-[12.5px] text-txt-1 outline-none focus:border-lavender disabled:opacity-40"
                    style={{ borderColor: 'var(--space-line)' }}
                  />
                  <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-txt-3">
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={addTickets}
                      onChange={(e) => setAddTickets(e.target.value)}
                      aria-label="新增劵數"
                      disabled={selected.archivedAt != null}
                      className="w-16 rounded-lg border bg-transparent px-2 py-1.5 text-center font-mono text-[12.5px] text-txt-1 outline-none focus:border-lavender disabled:opacity-40"
                      style={{ borderColor: 'var(--space-line)' }}
                    />
                    張
                  </span>
                  <button
                    type="button"
                    onClick={addEntry}
                    disabled={busy || selected.archivedAt != null || !addName.trim()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] font-bold disabled:opacity-40"
                    style={{ background: '#F5C518', color: '#241505' }}
                  >
                    <Plus size={11} aria-hidden="true" />
                    {addEntryMut.isPending ? '新增緊…' : '新增'}
                  </button>
                  <p className="w-full text-[10.5px] leading-relaxed text-txt-3">
                    {selected.archivedAt != null
                      ? '活動已歸檔，唔可以再新增／改劵數。'
                      : '前後空格會去除、大小楷視作同一人；姓名中間空格要一致。同名會自動加劵落原有持有人，唔會開新行。'}
                  </p>
                </div>
                {entriesQuery.isLoading ? (
                  <p className="text-[12px] text-txt-3">載入緊…</p>
                ) : entriesQuery.isError ? (
                  <p className="text-[12px] text-pink-soft" role="alert">
                    載入失敗：{fmtErr(entriesQuery.error)}
                    <button type="button" onClick={() => void entriesQuery.refetch()} className="ml-2 underline underline-offset-2">重試</button>
                  </p>
                ) : entries.length === 0 ? (
                  <p className="text-[12px] text-txt-3">仲未有劵——可手動新增或用 Excel 匯入</p>
                ) : (
                  <>
                    {/* v2026.11.08：批量操作列——當頁全選＋已選統計＋批量刪除（已中獎者受保護唔准勾選） */}
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-txt-3">
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={selectableBatchIds.length > 0 && selectableBatchIds.every((id) => checkedIds.has(id))}
                          onChange={toggleSelectAll}
                          disabled={busy || selectableIds.length === 0}
                          aria-label="全選本頁可刪除嘅劵持有人"
                          className="h-4 w-4 accent-[#F5C518]"
                        />
                        {selectableIds.length > BATCH_DELETE_LIMIT
                          ? `全選首 ${BATCH_DELETE_LIMIT} 人（共 ${selectableIds.length} 人可揀，請分批）`
                          : `全選（${selectableIds.length} 人可揀）`}
                      </label>
                      <span aria-live="polite">
                        已揀 {checkedEntries.length} 人・共 {checkedTickets} 張
                      </span>
                      <button
                        type="button"
                        onClick={batchDeleteEntries}
                        disabled={busy || checkedEntries.length === 0}
                        className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-bold text-pink-soft transition-colors hover:bg-white/5 disabled:opacity-40"
                        style={{ borderColor: 'rgba(255,0,84,0.4)' }}
                      >
                        <Trash2 size={11} aria-hidden="true" />
                        {deleteEntriesMut.isPending ? '刪除緊…' : `批量刪除（${checkedEntries.length} 人）`}
                      </button>
                    </div>
                    <ul className="max-h-[220px] space-y-1 overflow-y-auto pr-1">
                      {entries.map((en) => {
                        const isProtected = en.winCount > 0;
                        const editing = editingEntryId === en.id;
                        return (
                          <li
                            key={en.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px]"
                            style={{ borderColor: 'var(--space-line)' }}
                          >
                            <input
                              type="checkbox"
                              checked={checkedIds.has(en.id)}
                              onChange={() => toggleChecked(en.id)}
                              disabled={busy || isProtected}
                              aria-label={`勾選劵持有人 ${en.holderName}`}
                              title={isProtected ? '已中獎，受保護唔刪得' : `勾選 ${en.holderName}`}
                              className="h-4 w-4 shrink-0 accent-[#F5C518] disabled:opacity-40"
                            />
                            <span className="min-w-0 flex-1 truncate text-txt-1" title={en.holderName}>
                              {en.holderName}
                              {en.winCount > 0 && (
                                <span className="ml-1.5 rounded-full border px-1.5 py-px text-[10.5px] text-gold" style={{ borderColor: 'rgba(245,197,24,0.4)' }}>
                                  已中 {en.winCount}/{selected.maxWinsPerPerson}
                                </span>
                              )}
                              {isProtected && (
                                <span
                                  className="ml-1.5 rounded-full border px-1.5 py-px text-[10.5px] text-txt-3"
                                  style={{ borderColor: 'var(--space-line)' }}
                                  title="有中獎紀錄嘅人受保護，唔可以刪除（紀錄要留底追溯）"
                                >
                                  受保護唔刪得
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {editing ? (
                                <>
                                  <input
                                    autoFocus
                                    type="number"
                                    min={1}
                                    max={10000}
                                    value={entryTicketsValue}
                                    onChange={(e) => setEntryTicketsValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') commitEntryTickets(en);
                                      if (e.key === 'Escape') {
                                        setEditingEntryId(null);
                                        setEntryTicketsValue('');
                                      }
                                    }}
                                    aria-label={`${en.holderName} 新總劵數`}
                                    className="w-16 rounded-lg border bg-transparent px-2 py-1 text-center font-mono text-[12px] text-txt-1 outline-none focus:border-lavender"
                                    style={{ borderColor: '#F5C518' }}
                                  />
                                  <span className="text-[11px] text-txt-3">張</span>
                                  <button
                                    type="button"
                                    onClick={() => commitEntryTickets(en)}
                                    disabled={setTicketCountMut.isPending}
                                    className="rounded-lg border px-2 py-1 text-[11px] font-bold text-gold disabled:opacity-40"
                                    style={{ borderColor: 'rgba(245,197,24,0.5)' }}
                                  >
                                    {setTicketCountMut.isPending ? '改緊…' : '確定'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingEntryId(null);
                                      setEntryTicketsValue('');
                                    }}
                                    className="rounded-lg border px-2 py-1 text-[11px] text-txt-3"
                                    style={{ borderColor: 'var(--space-line)' }}
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="font-mono text-[11.5px] text-txt-3">{en.ticketCount} 張</span>
                                  <button
                                    type="button"
                                    aria-label={`修改 ${en.holderName} 嘅總劵數`}
                                    title="改總劵數"
                                    disabled={busy || selected.archivedAt != null}
                                    onClick={() => {
                                      setEditingEntryId(en.id);
                                      setEntryTicketsValue(String(en.ticketCount));
                                    }}
                                    className="rounded-md border p-1.5 text-txt-3 transition-colors hover:text-gold disabled:opacity-40"
                                    style={{ borderColor: 'var(--space-line)' }}
                                  >
                                    <Pencil size={11} aria-hidden="true" />
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                aria-label={`刪除劵持有人 ${en.holderName}`}
                                title={isProtected ? '已中獎，受保護唔刪得' : `刪除 ${en.holderName}`}
                                disabled={busy || isProtected}
                                onClick={() => {
                                  if (window.confirm(`刪除「${en.holderName}」（${en.ticketCount} 張劵）？`)) {
                                    deleteEntryMut.mutate({ entryId: en.id });
                                  }
                                }}
                                className="rounded-md border p-1.5 text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-40"
                                style={{ borderColor: 'var(--space-line)' }}
                              >
                                <Trash2 size={11} aria-hidden="true" />
                              </button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
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
