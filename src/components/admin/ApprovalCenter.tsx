/**
 * 審批中心（2026-08-06 Glo 要求）：員工（staff）嘅敏感操作要主管/管理員批准先生效
 * - 主管/管理員：「待審批」（完整預覽＋批准/拒絕）＋「處理紀錄」（每 50 條一頁，新嘅排先）
 * - 員工：「我嘅審批請求」（最近 20，狀態＋拒絕原因）
 *
 * 預覽係重中之重（Glo 原話：審批每個細節都好重要，要一睇就明重點）：
 * - 促銷電郵：全封信預覽（主旨＋內文全文＋優惠碼＋圖片＋收件人數）
 * - 商品新增：全部資料卡；商品修改/會員修改/優惠碼修改：「欄位｜而家｜改為」三欄對照，
 *   淨係顯示真係改咗嘅欄（黃色 highlight 新值）
 * - 刪除類：紅色警告＋現狀全部資料
 */
import { useEffect, useState } from 'react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import Lightbox from '@/components/admin/Lightbox';
import { LoadingBlock } from '@/components/admin/WishingStar';
import { fmtDate, fmtDateTime, fmtHKD } from '@/components/admin/format';
import { productCategoryLabel } from '@contracts/types';

type ToastFn = (text: string, kind?: 'success' | 'info' | 'error') => void;

interface ApprovalRow {
  id: number;
  requesterId: number;
  action: string;
  payload: unknown;
  summary: string;
  status: string;
  reviewerId: number | null;
  reviewNote: string | null;
  createdAt: string | Date;
  reviewedAt: string | Date | null;
  requesterName?: string;
  reviewerName?: string | null;
}

const ACTION_META: Record<string, { label: string; color: string }> = {
  'member.update': { label: '修改會員', color: '#f0b429' },
  'promo.sendMarketingEmail': { label: '寄促銷電郵', color: '#ff8fb2' },
  'praise.create': { label: '新增打卡相', color: '#7ed491' },
  'praise.update': { label: '修改打卡相', color: '#f0b429' },
  'praise.remove': { label: '刪除打卡相', color: '#ff7a7a' },
  'product.create': { label: '新增商品', color: '#7ed491' },
  'product.update': { label: '修改商品', color: '#f0b429' },
  'product.remove': { label: '刪除商品', color: '#ff7a7a' },
  'promoCode.create': { label: '新增優惠碼', color: '#7ed491' },
  'promoCode.update': { label: '修改優惠碼', color: '#f0b429' },
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '等待中', color: '#f0b429' },
  approved: { label: '已批准', color: '#7ed491' },
  rejected: { label: '已拒絕', color: '#ff7a7a' },
};

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ color, borderColor: color, background: `${color}1f` }}
    >
      {text}
    </span>
  );
}

/** 值正規化比較（null ≈ undefined ≈ 空字串；array 逐項；Date/字串日期統一毫秒） */
function normVal(v: unknown): unknown {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? v : t;
  }
  return v;
}
const isChanged = (a: unknown, b: unknown) => normVal(a) !== normVal(b);

// ── 欄位定義（label 中文化＋格式化） ─────────────────────────
type V = unknown;
const yesNo = (yes: string, no: string) => (v: V) => (v ? yes : no);
const dash = (v: V) => (v === null || v === undefined || v === '' ? '—' : String(v));
const money = (v: V) => (typeof v === 'number' ? fmtHKD(v) : '—');
const dateFmt = (v: V) => (v ? fmtDate(v as string | Date) : '—');
const dateTimeFmt = (v: V) => (v ? fmtDateTime(v as string | Date) : '—');

interface FieldDef {
  key: string;
  label: string;
  fmt?: (v: V) => string;
  img?: boolean; // 單張圖（值係 /uploads/ 路徑）
  imgList?: boolean; // 多張圖 array
}

const PRODUCT_FIELDS: FieldDef[] = [
  { key: 'sku', label: '貨號' },
  { key: 'name', label: '名稱' },
  { key: 'price', label: '原價', fmt: money },
  { key: 'discountPrice', label: '折扣價', fmt: money },
  { key: 'category', label: '分類', fmt: (v) => productCategoryLabel(v as string) },
  { key: 'stock', label: '存貨', fmt: dash },
  { key: 'image', label: '主圖', img: true },
  { key: 'photos', label: '商品圖', imgList: true },
  { key: 'description', label: '描述', fmt: dash },
  { key: 'sizes', label: '尺碼', fmt: dash },
  { key: 'sizeEnabled', label: '尺碼選項', fmt: yesNo('開', '關') },
  { key: 'note', label: '備註', fmt: dash },
  { key: 'listedDate', label: '上架日期', fmt: dateFmt },
  { key: 'isActive', label: '上架狀態', fmt: yesNo('上架中', '已下架') },
  { key: 'delistEnabled', label: '定時下架', fmt: yesNo('開', '關') },
  { key: 'delistAt', label: '下架時間', fmt: dateTimeFmt },
];

const MEMBER_FIELDS: FieldDef[] = [
  { key: 'name', label: '名稱' },
  { key: 'phone', label: '電話' },
  { key: 'email', label: 'Email', fmt: dash },
  { key: 'address', label: '地址', fmt: dash },
  { key: 'age', label: '年齡', fmt: dash },
  { key: 'birthMonth', label: '生日月份', fmt: dash },
  { key: 'marketingOptIn', label: '推廣同意', fmt: yesNo('接受', '唔接受') },
];

const PRAISE_FIELDS: FieldDef[] = [
  { key: 'image', label: '相片', img: true },
  { key: 'caption', label: '說明', fmt: dash },
  { key: 'sortOrder', label: '排序', fmt: dash },
  { key: 'isActive', label: '狀態', fmt: yesNo('上架中', '已下架') },
];

const PROMO_KIND_LABEL = (v: V) => (v === 'percent' ? '百分比折扣' : v === 'fixed' ? '現金折扣' : dash(v));
const PROMO_VALUE_FMT = (kind: unknown, v: V) =>
  typeof v === 'number' ? (kind === 'percent' ? `${v}% 折扣` : `減 ${fmtHKD(v)}`) : '—';

const PROMO_FIELDS: FieldDef[] = [
  { key: 'code', label: '優惠碼' },
  { key: 'kind', label: '種類', fmt: PROMO_KIND_LABEL },
  { key: 'value', label: '面值' }, // 特別處理：要連 kind 先砌到說明（見下面 fmtVal）
  { key: 'minSpend', label: '最低消費', fmt: money },
  { key: 'usageLimit', label: '使用限額', fmt: (v) => (v ? `${v} 次` : '不限') },
  { key: 'perUserLimit', label: '每人限用', fmt: (v) => (v ? `${v} 次` : '不限') },
  { key: 'expiresAt', label: '到期日', fmt: dateFmt },
  { key: 'isActive', label: '狀態', fmt: yesNo('啟用', '停用') },
];

function fieldsForAction(action: string): FieldDef[] {
  if (action.startsWith('product.')) return PRODUCT_FIELDS;
  if (action === 'member.update') return MEMBER_FIELDS;
  if (action.startsWith('praise.')) return PRAISE_FIELDS;
  return PROMO_FIELDS;
}

function fmtVal(f: FieldDef, v: V, row?: Record<string, V>): string {
  if (f.key === 'value' && row) return PROMO_VALUE_FMT(row.kind, v);
  return f.fmt ? f.fmt(v) : dash(v);
}

/** 單張圖格（可撳大） */
function Thumb({ src, onOpen }: { src: string; onOpen: (src: string) => void }) {
  return (
    <img
      src={src}
      alt="預覽圖"
      loading="lazy"
      onClick={() => onOpen(src)}
      className="h-20 w-20 cursor-zoom-in rounded-lg border object-cover"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--space-0)' }}
    />
  );
}

/** 新增/刪除用：兩欄資料表（label: value） */
function KeyValueTable({
  data,
  fields,
  onImage,
}: {
  data: Record<string, V>;
  fields: FieldDef[];
  onImage: (src: string) => void;
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {fields.map((f) => {
        const v = data[f.key];
        if (f.img) {
          return typeof v === 'string' && v ? (
            <div key={f.key} className="flex items-start gap-3">
              <dt className="w-20 shrink-0 pt-1 text-[12px] text-txt-3">{f.label}</dt>
              <dd><Thumb src={v} onOpen={onImage} /></dd>
            </div>
          ) : null;
        }
        if (f.imgList) {
          return Array.isArray(v) && v.length > 0 ? (
            <div key={f.key} className="flex items-start gap-3 sm:col-span-2">
              <dt className="w-20 shrink-0 pt-1 text-[12px] text-txt-3">{f.label}</dt>
              <dd className="flex flex-wrap gap-2">
                {(v as string[]).map((u) => (
                  <Thumb key={u} src={u} onOpen={onImage} />
                ))}
              </dd>
            </div>
          ) : null;
        }
        return (
          <div key={f.key} className="flex items-baseline gap-3">
            <dt className="w-20 shrink-0 text-[12px] text-txt-3">{f.label}</dt>
            <dd className="whitespace-pre-wrap break-words text-[13px] text-txt-1">{fmtVal(f, v, data)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** 修改用：三欄對照（欄位｜而家｜改為），淨係顯示改咗嘅欄，新值黃色 highlight */
function DiffTable({
  before,
  after,
  fields,
  onImage,
}: {
  before: Record<string, V> | null;
  after: Record<string, V>;
  fields: FieldDef[];
  onImage: (src: string) => void;
}) {
  const rows = fields.filter((f) => {
    if (!(f.key in after)) return false;
    return isChanged(before?.[f.key], after[f.key]);
  });
  if (rows.length === 0) {
    return <p className="text-[13px] text-txt-3">（冇實質改動）</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-txt-3">
            <th className="pb-2 pr-3 font-medium">欄位</th>
            <th className="pb-2 pr-3 font-medium">而家</th>
            <th className="pb-2 font-medium">改為</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const oldV = before?.[f.key];
            const newV = after[f.key];
            return (
              <tr key={f.key} className="border-t" style={{ borderColor: 'var(--space-line)' }}>
                <td className="py-2 pr-3 align-top text-txt-3">{f.label}</td>
                <td className="py-2 pr-3 align-top text-txt-2">
                  {f.img && typeof oldV === 'string' && oldV ? (
                    <Thumb src={oldV} onOpen={onImage} />
                  ) : f.imgList && Array.isArray(oldV) && oldV.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(oldV as string[]).map((u) => (
                        <Thumb key={u} src={u} onOpen={onImage} />
                      ))}
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap break-words">{fmtVal(f, oldV, before ?? undefined)}</span>
                  )}
                </td>
                <td
                  className="rounded-lg px-2 py-2 align-top font-medium"
                  style={{ background: 'rgba(240, 180, 41, 0.14)', color: '#f0b429' }}
                >
                  {f.img && typeof newV === 'string' && newV ? (
                    <Thumb src={newV} onOpen={onImage} />
                  ) : f.imgList && Array.isArray(newV) && newV.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(newV as string[]).map((u) => (
                        <Thumb key={u} src={u} onOpen={onImage} />
                      ))}
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap break-words">{fmtVal(f, newV, after)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 促銷電郵全信預覽（Glo 要求：要預覽到全封信先批准） */
function EmailPreview({
  input,
  audienceCount,
  onImage,
}: {
  input: { subject?: string; body?: string; promoCode?: string; imageUrls?: string[] };
  audienceCount?: number;
  onImage: (src: string) => void;
}) {
  return (
    <div>
      <div
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--space-line)', background: 'var(--space-0)' }}
      >
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--space-line)' }}>
          <p className="text-[11px] text-txt-3">主旨</p>
          <p className="mt-0.5 text-[15px] font-semibold text-txt-1">{input.subject}</p>
        </div>
        <div className="px-4 py-3">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-txt-1">
            {input.body}
          </p>
          {input.promoCode && (
            <p className="mt-3">
              <Badge text={`優惠碼：${input.promoCode}`} color="#7ed491" />
            </p>
          )}
          {input.imageUrls && input.imageUrls.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {input.imageUrls.map((u) => (
                <Thumb key={u} src={u} onOpen={onImage} />
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-[12px] text-txt-3">
        批准後即刻寄出，收件人：{audienceCount ?? '—'} 位已同意接收推廣嘅會員（唔會寄畀未選/唔接受嘅會員）。
      </p>
    </div>
  );
}

/** 按 action 揀啱嘅預覽 */
function RequestPreview({ row, onImage }: { row: ApprovalRow; onImage: (src: string) => void }) {
  const p = (row.payload ?? {}) as { input?: Record<string, V>; before?: Record<string, V> | null; audienceCount?: number };
  const input = p.input ?? {};
  const before = p.before ?? null;
  const fields = fieldsForAction(row.action);

  if (row.action === 'promo.sendMarketingEmail') {
    return (
      <EmailPreview
        input={input as { subject?: string; body?: string; promoCode?: string; imageUrls?: string[] }}
        audienceCount={p.audienceCount}
        onImage={onImage}
      />
    );
  }
  if (row.action.endsWith('.create')) {
    return <KeyValueTable data={input} fields={fields} onImage={onImage} />;
  }
  if (row.action.endsWith('.remove')) {
    return (
      <div>
        <p
          className="mb-3 rounded-lg border px-3 py-2 text-[12px] font-medium"
          style={{ borderColor: '#ff7a7a', color: '#ff7a7a', background: 'rgba(255, 122, 122, 0.10)' }}
        >
          ⚠ 批准後呢筆資料會即刻被刪除，唔可以復原。
        </p>
        {before ? (
          <KeyValueTable data={before} fields={fields} onImage={onImage} />
        ) : (
          <p className="text-[13px] text-txt-3">（搵唔到現狀資料）</p>
        )}
      </div>
    );
  }
  // update 類：新舊對照
  return <DiffTable before={before} after={input} fields={fields} onImage={onImage} />;
}

/** 待審批卡：預覽＋備註＋批准/拒絕 */
function PendingCard({
  row,
  busy,
  onApprove,
  onReject,
  onImage,
}: {
  row: ApprovalRow;
  busy: boolean;
  onApprove: (id: number, note?: string) => void;
  onReject: (id: number, note: string) => void;
  onImage: (src: string) => void;
}) {
  const [note, setNote] = useState('');
  const meta = ACTION_META[row.action] ?? { label: row.action, color: '#b79cff' };
  return (
    <li
      className="rounded-2xl border p-4"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge text={meta.label} color={meta.color} />
        <p className="text-[14px] font-semibold text-txt-1">{row.summary}</p>
        <p className="text-[12px] text-txt-3">
          {row.requesterName ?? `#${row.requesterId}`} 提交 · {fmtDateTime(row.createdAt)}
        </p>
      </div>
      <div className="mt-4">
        <RequestPreview row={row} onImage={onImage} />
      </div>
      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="審批備註（批准選填；拒絕必填，會寫入日誌）"
          maxLength={200}
          className="w-full rounded-xl border px-3 py-2 text-[13px] text-txt-1 outline-none sm:flex-1"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-0)' }}
        />
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`確定批准並立即執行？\n\n${row.summary}`)) {
                onApprove(row.id, note.trim() || undefined);
              }
            }}
            className="btn btn-primary !px-4 !py-2 text-[12px] disabled:opacity-60"
          >
            ✅ 批准執行
          </button>
          <button
            type="button"
            disabled={busy || !note.trim()}
            onClick={() => {
              if (window.confirm(`確定拒絕？\n\n${row.summary}\n\n原因：${note.trim()}`)) {
                onReject(row.id, note.trim());
              }
            }}
            className="btn btn-secondary !px-4 !py-2 text-[12px] disabled:opacity-60"
            title={note.trim() ? '' : '拒絕要先填原因'}
          >
            ❌ 拒絕
          </button>
        </div>
      </div>
    </li>
  );
}

/** 已處理/我嘅請求：一條一行 */
function HistoryRow({ row, showReviewer }: { row: ApprovalRow; showReviewer?: boolean }) {
  const meta = ACTION_META[row.action] ?? { label: row.action, color: '#b79cff' };
  const st = STATUS_META[row.status] ?? { label: row.status, color: '#b79cff' };
  return (
    <li
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge text={meta.label} color={meta.color} />
        <Badge text={st.label} color={st.color} />
        <p className="text-[13px] font-medium text-txt-1">{row.summary}</p>
      </div>
      <p className="mt-1.5 text-[12px] text-txt-3">
        {row.requesterName ?? `#${row.requesterId}`} 提交 · {fmtDateTime(row.createdAt)}
        {showReviewer && row.reviewerName
          ? ` · ${row.reviewerName} 處理 · ${row.reviewedAt ? fmtDateTime(row.reviewedAt) : ''}`
          : ''}
        {row.reviewNote ? ` · 備註：${row.reviewNote}` : ''}
      </p>
    </li>
  );
}

export default function ApprovalCenter({ toast }: { toast: ToastFn }) {
  const { user } = useAuth();
  const isReviewer = user?.role === 'supervisor' || user?.role === 'admin';
  const utils = trpc.useUtils();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // 處理紀錄分頁（2026-08-06 Glo 要求：每 50 條一頁）
  const [historyPage, setHistoryPage] = useState(1);

  // 主管/管理員：待審批（15s 自動刷新，等緊新單）＋處理紀錄；員工：自己嘅請求
  const pendingQuery = trpc.approvals.pendingList.useQuery(undefined, {
    enabled: isReviewer,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
  const historyQuery = trpc.approvals.history.useQuery(
    { page: historyPage },
    {
      enabled: isReviewer,
      refetchOnWindowFocus: false,
    },
  );
  const myQuery = trpc.approvals.myRequests.useQuery(undefined, {
    enabled: !isReviewer,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });

  const invalidateAll = () => {
    void utils.approvals.pendingList.invalidate();
    void utils.approvals.history.invalidate();
    void utils.approvals.myRequests.invalidate();
    // 批准咗嘅改動會影響各管理頁嘅列表，一併刷新
    void utils.products.adminList.invalidate();
    void utils.praise.adminList.invalidate();
    void utils.promo.list.invalidate();
    void utils.members.list.invalidate();
  };

  const approveMutation = trpc.approvals.approve.useMutation({
    onSuccess: () => {
      toast('已批准並即時執行 ✓', 'success');
      invalidateAll();
    },
    onError: (err) => toast(err.message || '批准失敗，請再試', 'error'),
  });
  const rejectMutation = trpc.approvals.reject.useMutation({
    onSuccess: () => {
      toast('已拒絕', 'info');
      invalidateAll();
    },
    onError: (err) => toast(err.message || '拒絕失敗，請再試', 'error'),
  });

  const busy = approveMutation.isPending || rejectMutation.isPending;

  // 批咗/拒咗啲單之後 total 會變，頁數超咗界就夾返入範圍
  // （hook 要放喺 staff 早退 return 之前，唔可以條件式呼叫）
  const historyPageCountNow = historyQuery.data?.pageCount ?? 1;
  useEffect(() => {
    if (historyPage > historyPageCountNow) setHistoryPage(historyPageCountNow);
  }, [historyPage, historyPageCountNow]);

  // ── 員工視角：我嘅審批請求 ──
  if (!isReviewer) {
    const rows = (myQuery.data ?? []) as ApprovalRow[];
    return (
      <section>
        <h2 className="font-serif-tc text-xl font-bold text-txt-1">我嘅審批請求</h2>
        <p className="mt-1 text-[13px] text-txt-3">
          你提交嘅敏感操作會喺度排隊，主管/管理員批准後先會生效。
        </p>
        {myQuery.isLoading ? (
          <LoadingBlock text="載入緊你嘅請求…" />
        ) : rows.length === 0 ? (
          <p className="py-14 text-center text-[14px] text-txt-3">暫時冇提交過審批請求。</p>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {rows.map((r) => (
              <HistoryRow key={r.id} row={r} />
            ))}
          </ul>
        )}
      </section>
    );
  }

  // ── 主管/管理員視角：待審批＋處理紀錄 ──
  const pending = (pendingQuery.data ?? []) as ApprovalRow[];
  const historyData = historyQuery.data;
  const history = (historyData?.rows ?? []) as ApprovalRow[];
  const historyTotal = historyData?.total ?? 0;
  const historyPageCount = historyData?.pageCount ?? 1;
  return (
    <section>
      <h2 className="font-serif-tc text-xl font-bold text-txt-1">審批中心</h2>
      <p className="mt-1 text-[13px] text-txt-3">
        員工提交嘅敏感操作要批准先會執行。每張單都可以睇晒全部細節先決定。
      </p>

      <h3 className="mt-6 text-[14px] font-semibold text-txt-1">
        待審批{pending.length > 0 ? `（${pending.length}）` : ''}
      </h3>
      {pendingQuery.isLoading ? (
        <LoadingBlock text="載入緊待審批…" />
      ) : pending.length === 0 ? (
        <p className="py-10 text-center text-[14px] text-txt-3">暫時冇待審批嘅請求 ✓</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {pending.map((r) => (
            <PendingCard
              key={r.id}
              row={r}
              busy={busy}
              onImage={setLightboxSrc}
              onApprove={(id, note) => approveMutation.mutate({ id, note })}
              onReject={(id, note) => rejectMutation.mutate({ id, note })}
            />
          ))}
        </ul>
      )}

      <h3 className="mt-8 text-[14px] font-semibold text-txt-1">
        處理紀錄（每 50 條一頁{historyTotal > 0 ? `，共 ${historyTotal} 條` : ''}）
      </h3>
      {historyQuery.isLoading ? (
        <LoadingBlock text="載入緊紀錄…" />
      ) : historyTotal === 0 ? (
        <p className="py-10 text-center text-[14px] text-txt-3">暫時冇處理紀錄。</p>
      ) : (
        <>
          <ul className="mt-3 space-y-2.5">
            {history.map((r) => (
              <HistoryRow key={r.id} row={r} showReviewer />
            ))}
          </ul>
          {historyPageCount > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-[13px] text-txt-2">
              <button
                type="button"
                onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                disabled={historyPage <= 1}
                className="btn btn-secondary !px-4 !py-2 text-[13px] disabled:opacity-40"
              >
                ← 上一頁
              </button>
              <span className="font-mono">
                第 {historyPage} / {historyPageCount} 頁
              </span>
              <button
                type="button"
                onClick={() => setHistoryPage((p) => Math.min(historyPageCount, p + 1))}
                disabled={historyPage >= historyPageCount}
                className="btn btn-secondary !px-4 !py-2 text-[13px] disabled:opacity-40"
              >
                下一頁 →
              </button>
            </div>
          )}
        </>
      )}

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </section>
  );
}
