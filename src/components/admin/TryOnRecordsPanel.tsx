import { useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, RefreshCw, Search, Shirt, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDateTime } from './format';
import { LoadingBlock } from './WishingStar';
import TryOnRecordMedia from './TryOnRecordMedia';
import {
  TRYON_RECORD_STATUSES,
  describeTryOnRecord,
  fmtMemberPhone,
  jobBadge,
  lookBadge,
  paginationSummary,
  tryOnRecordStatusMeta,
  type TryOnRecordItem,
  type TryOnRecordStatus,
} from './tryOnRecordsMeta';

/**
 * 後台「AI 試穿紀錄」面板（supervisor／admin；後端 tryon.listAdminRecords 把關）
 * ─ 逐件列出真實試穿工作：邊個會員 → 試咗邊件商品（生成時品名/貨號 snapshot）→ 第幾件 → 狀態 → 時間
 * ─ 三圖核對（2026-10-28，TryOnRecordMedia）：每筆撳「查看圖片」先按需打 tryon.getAdminRecordMedia
 *   攞私人圖 URL，再用 fetch 帶 auth token 攞 blob 顯示；list payload 只有
 *   media: { archiveAvailable, productImageUrl }——私人 URL／storage key／signed URL 絕對唔落 list
 * ─ 保留期：客戶前台 24 小時；後台原相及生成圖只保留 30 日，過期顯示「已過30日保留期」
 * ─ 成本／credits／provider／model 等內部技術資料一律唔顯示；圖片只供核對，唔提供下載
 * ─ 唯讀：冇任何修改／刪除操作（刪圖流程同 retention 唔經呢度）
 * ─ 無 props：Admin.tsx 直接 <TryOnRecordsPanel /> 接入（主管＋管理員先用得）
 */

const PAGE_SIZE = 20;

const filterInputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink focus:outline-none';
const filterLabelCls = 'mb-1.5 block text-[13px] text-txt-2';
const pageBtnCls =
  'inline-flex min-h-[44px] items-center gap-1 rounded-full border px-4 py-1.5 text-[13px] text-txt-2 transition-colors hover:text-txt-1 focus:border-pink focus:outline-none disabled:opacity-35';

/** 狀態 badge（每個 badge 有 aria-label，唔齋靠色）；失敗時附自家 failureCode 類別 */
function RecordStatusBadge({ status, failureCode }: { status: string; failureCode: string | null }) {
  const meta = tryOnRecordStatusMeta(status);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span
        aria-label={`試穿狀態：${meta.label}`}
        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] leading-none ${meta.className}`}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} aria-hidden="true" />
        {meta.label}
      </span>
      {status === 'failed' && failureCode && (
        <span className="font-mono text-[11px] text-txt-3">{failureCode}</span>
      )}
    </span>
  );
}

/** 商品欄：snapshot 品名＋貨號；已刪／已改名註明（唔會提供任何圖片連結） */
function ProductCell({ product }: { product: TryOnRecordItem['product'] }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-txt-1">{product.name}</p>
      <p className="mt-0.5 font-mono text-[12px] text-txt-3">{product.sku}</p>
      {!product.exists && (
        <p className="mt-1 inline-block rounded-full border border-space-line px-2 py-0.5 text-[11px] text-txt-3">
          商品已刪除・顯示當時資料
        </p>
      )}
      {product.exists && product.changed && (
        <p
          className="mt-1 inline-block rounded-full border border-space-line px-2 py-0.5 text-[11px] text-txt-3"
          title={`而家品名/貨號：${product.currentName ?? ''}（${product.currentSku ?? ''}）`}
        >
          商品資料已更改・呢度顯示試穿當時嘅資料
        </p>
      )}
    </div>
  );
}

/** 會員欄：名＋電話（HK 格式）；已刪帳號兜底 */
function MemberCell({ member }: { member: TryOnRecordItem['member'] }) {
  if (!member) {
    return <span className="text-txt-3">已刪除會員</span>;
  }
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-txt-1">{member.name}</p>
      <p className="mt-0.5 font-mono text-[12px] text-txt-3">{fmtMemberPhone(member.phone) || '—'}</p>
    </div>
  );
}

export default function TryOnRecordsPanel() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'' | TryOnRecordStatus>('');
  // 搜尋用「送出先套用」模式：輸入中唔會每個字打一次 API
  const [memberInput, setMemberInput] = useState('');
  const [productInput, setProductInput] = useState('');
  const [applied, setApplied] = useState<{ member?: string; product?: string }>({});

  const query = trpc.tryon.listAdminRecords.useQuery(
    {
      page,
      pageSize: PAGE_SIZE,
      status: status === '' ? undefined : status,
      member: applied.member,
      product: applied.product,
    },
    // 轉頁／篩選時保留上一頁內容，畫面唔會閃
    { placeholderData: (prev) => prev, retry: false },
  );
  const data = query.data;
  const hasFilter = Boolean(applied.member || applied.product || status);

  const applySearch = () => {
    setApplied({
      member: memberInput.trim() || undefined,
      product: productInput.trim() || undefined,
    });
    setPage(1);
  };
  const clearSearch = () => {
    setMemberInput('');
    setProductInput('');
    setStatus('');
    setApplied({});
    setPage(1);
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      aria-label="AI 試穿紀錄"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
          <Shirt size={16} aria-hidden="true" className="text-gold" />
          AI 試穿紀錄
          {data && (
            <span className="font-mono text-[13px] font-normal text-txt-3" aria-live="polite">
              （{data.total} 條）
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="btn btn-secondary min-h-[44px] !px-4 text-[13px] disabled:opacity-60"
        >
          <RefreshCw size={14} aria-hidden="true" className={query.isFetching ? 'animate-spin' : undefined} />
          重新整理
        </button>
      </div>
      <p className="mt-1.5 text-[13px] text-txt-3">
        真實試穿工作逐件列出：邊個會員、試咗邊件商品（生成時品名／貨號快照）、第幾件、狀態同時間。
        撳「查看圖片」可核對客戶原相、AI 生成圖同商品圖；私人圖片要經授權核實先顯示，唔提供下載。
        保留期：客戶前台 24 小時；後台原相及生成圖只保留 30 日，逾期自動刪除。
      </p>

      {/* ── 篩選：會員（名/電話）＋商品（品名/貨號）＋狀態 ── */}
      <form
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          applySearch();
        }}
      >
        <div>
          <label htmlFor="tryon-rec-member" className={filterLabelCls}>
            會員（姓名或電話）
          </label>
          <input
            id="tryon-rec-member"
            value={memberInput}
            onChange={(e) => setMemberInput(e.target.value)}
            placeholder="例如：陳小明 / 9123"
            className={filterInputCls}
            maxLength={100}
          />
        </div>
        <div>
          <label htmlFor="tryon-rec-product" className={filterLabelCls}>
            商品（品名或貨號）
          </label>
          <input
            id="tryon-rec-product"
            value={productInput}
            onChange={(e) => setProductInput(e.target.value)}
            placeholder="例如：恤衫 / TOP-101"
            className={filterInputCls}
            maxLength={100}
          />
        </div>
        <div>
          <label htmlFor="tryon-rec-status" className={filterLabelCls}>
            狀態
          </label>
          <select
            id="tryon-rec-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | TryOnRecordStatus);
              setPage(1);
            }}
            className={filterInputCls}
          >
            <option value="">全部狀態</option>
            {TRYON_RECORD_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn btn-primary min-h-[44px] !px-5 text-[14px]">
            <Search size={14} aria-hidden="true" />
            搜尋
          </button>
          {hasFilter && (
            <button
              type="button"
              onClick={clearSearch}
              className="btn btn-secondary min-h-[44px] !px-4 text-[13px]"
              aria-label="清除全部篩選"
            >
              <X size={14} aria-hidden="true" />
              清除
            </button>
          )}
        </div>
      </form>

      {/* ── 結果 ── */}
      {query.isLoading ? (
        <LoadingBlock text="許願星搬緊試穿紀錄…" />
      ) : query.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft" role="alert">
          載入試穿紀錄失敗：{query.error.message}
        </p>
      ) : !data || data.items.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">
          {hasFilter ? '搵唔到符合篩選條件嘅試穿紀錄。' : '暫時未有試穿紀錄。'}
        </p>
      ) : (
        <>
          {/* 桌面版：表格（橫向捲動限喺容器入面，頁面唔會溢出） */}
          <div className="mt-4 hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1180px] border-collapse text-[13px]">
              <thead>
                <tr
                  className="border-b text-left text-[12px] tracking-[0.08em] text-txt-3"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <th className="w-32 py-2 pr-3 font-normal">建立時間</th>
                  <th className="py-2 pr-3 font-normal">會員</th>
                  <th className="py-2 pr-3 font-normal">試穿商品</th>
                  <th className="w-64 py-2 pr-3 font-normal">圖片</th>
                  <th className="w-16 py-2 pr-3 font-normal">第幾件</th>
                  <th className="w-28 py-2 pr-3 font-normal">狀態</th>
                  <th className="w-32 py-2 pr-3 font-normal">完成時間</th>
                  <th className="w-28 py-2 pr-3 font-normal">造型編號</th>
                  <th className="w-28 py-2 font-normal">工作編號</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr
                    key={item.publicId}
                    className="border-b last:border-0"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-3">{fmtDateTime(item.createdAt)}</td>
                    <td className="max-w-0 truncate py-2.5 pr-3">
                      <MemberCell member={item.member} />
                    </td>
                    <td className="max-w-0 truncate py-2.5 pr-3">
                      <ProductCell product={item.product} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <TryOnRecordMedia
                        publicId={item.publicId}
                        status={item.status}
                        archiveAvailable={item.media.archiveAvailable}
                        productImageUrl={item.media.productImageUrl}
                        describe={describeTryOnRecord(item)}
                      />
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-2">第 {item.stepNumber} 件</td>
                    <td className="py-2.5 pr-3">
                      <RecordStatusBadge status={item.status} failureCode={item.failureCode} />
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-3">
                      {item.completedAt ? fmtDateTime(item.completedAt) : '—'}
                    </td>
                    <td
                      className="py-2.5 pr-3 font-mono text-[12px] text-txt-3"
                      title={item.lookId}
                      aria-label={`造型編號 ${item.lookId}`}
                    >
                      {lookBadge(item.lookId)}
                    </td>
                    <td
                      className="py-2.5 font-mono text-[12px] text-txt-3"
                      title={item.publicId}
                      aria-label={`工作編號 ${item.publicId}`}
                    >
                      {jobBadge(item.publicId)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 手機版：逐件一卡（語意同表格一致） */}
          <ul className="mt-4 space-y-3 lg:hidden">
            {data.items.map((item) => (
              <li
                key={item.publicId}
                className="rounded-2xl border p-4"
                style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.02)' }}
                aria-label={describeTryOnRecord(item)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold text-txt-1">
                      {item.member?.name ?? '已刪除會員'}
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">
                      {fmtMemberPhone(item.member?.phone) || '—'}
                    </p>
                  </div>
                  <RecordStatusBadge status={item.status} failureCode={item.failureCode} />
                </div>

                <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--space-line)' }}>
                  <ProductCell product={item.product} />
                  <p className="mt-1.5 text-[12px] text-txt-2">第 {item.stepNumber} 件</p>
                </div>

                {/* 三圖：客戶原相／AI 生成圖／商品圖（按需載入，私人圖帶 auth token fetch） */}
                <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--space-line)' }}>
                  <TryOnRecordMedia
                    publicId={item.publicId}
                    status={item.status}
                    archiveAvailable={item.media.archiveAvailable}
                    productImageUrl={item.media.productImageUrl}
                    describe={describeTryOnRecord(item)}
                  />
                </div>

                <div
                  className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2.5 font-mono text-[11.5px] text-txt-3"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 size={12} aria-hidden="true" />
                    建立 {fmtDateTime(item.createdAt)}
                  </span>
                  <span>完成 {item.completedAt ? fmtDateTime(item.completedAt) : '—'}</span>
                  <span title={item.lookId} aria-label={`造型編號 ${item.lookId}`}>
                    {lookBadge(item.lookId)}
                  </span>
                  <span title={item.publicId} aria-label={`工作編號 ${item.publicId}`}>
                    {jobBadge(item.publicId)}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {/* ── 分頁 ── */}
          <div
            className="mt-4 flex items-center justify-between border-t pt-3"
            style={{ borderColor: 'var(--space-line)' }}
          >
            <button
              type="button"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className={pageBtnCls}
              style={{ borderColor: 'var(--space-line)' }}
              aria-label="上一頁"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              上一頁
            </button>
            <span className="font-mono text-[12px] text-txt-3" aria-live="polite">
              {paginationSummary(data.page, data.totalPages, data.total)}
            </span>
            <button
              type="button"
              disabled={page >= data.totalPages || query.isFetching}
              onClick={() => setPage((p) => p + 1)}
              className={pageBtnCls}
              style={{ borderColor: 'var(--space-line)' }}
              aria-label="下一頁"
            >
              下一頁
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </section>
  );
}
