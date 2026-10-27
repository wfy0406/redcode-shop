import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  Download,
  Images,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  MessageCircle,
  RefreshCcw,
  Share2,
  ShoppingBag,
  X,
  ZoomIn,
} from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { useDialogA11y } from '@/hooks/useDialogA11y';
import './tryOnHistory.css';

/* ===== API 合約類型（同後端 tryon.listMyRecords／getShareLink 協定一致）===== */
export type TryOnHistoryRecord = {
  publicId: string;
  lookId: string;
  stepNumber: number;
  productId: number;
  productName: string;
  productSku: string;
  productPrice: number;
  productDiscountPrice: number | null;
  listedDate: Date | null;
  outputUrl: string;
  expiresAt: Date;
  createdAt: Date;
};
export type TryOnShareLink = { url: string; expiresAt: Date };
export type TryOnSharedRecord = {
  productName: string;
  productSku: string;
  productPrice: number;
  productDiscountPrice: number | null;
  listedDate: Date | null;
  outputUrl: string;
  expiresAt: Date;
};

type QueryOptions = {
  enabled?: boolean;
  retry?: boolean | number;
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
};
type QueryResultLike<TData> = {
  data: TData | undefined;
  error: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => Promise<{ data?: TData; error?: unknown }>;
};
type QueryHook<TData, TInput> = { useQuery: (input: TInput, opts?: QueryOptions) => QueryResultLike<TData> };

// 後端三個 procedure（listMyRecords／getShareLink／getShared）係既定 API 合約；
// AppRouter 類型更新前先以結構式 cast 接駁——tRPC proxy client 運行時按路徑動態生成，行為不受影響。
export const tryOnHistoryApi = trpc.tryon as unknown as {
  listMyRecords: QueryHook<TryOnHistoryRecord[], undefined>;
  getShareLink: QueryHook<TryOnShareLink, { publicId: string }>;
  getShared: QueryHook<TryOnSharedRecord, { publicId: string; expires: number; signature: string }>;
};

/* ===== 純輔助（TryOnHistory.test.tsx 會直接驗證）===== */
export function moneyHkd(value: number): string {
  return `HK$${Math.max(0, Math.round(value)).toLocaleString('en-HK')}`;
}

export function currentPrice(record: { productPrice: number; productDiscountPrice: number | null }): number {
  return record.productDiscountPrice ?? record.productPrice;
}

export function hasDiscount(record: { productPrice: number; productDiscountPrice: number | null }): boolean {
  return record.productDiscountPrice != null && record.productDiscountPrice < record.productPrice;
}

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isRecordExpired(record: { expiresAt: Date | string }, now: Date = new Date()): boolean {
  const expires = coerceDate(record.expiresAt);
  return expires ? expires.getTime() <= now.getTime() : false;
}

/** 日期＋時間（香港時區）；null／無效 → fallback（預設「—」） */
export function hkDateTimeLabel(value: Date | string | null | undefined, fallback = '—'): string {
  const date = coerceDate(value);
  if (!date) return fallback;
  return date.toLocaleString('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 淨日期（香港時區）；上架日期 null → fallback（預設「—」） */
export function hkDateLabel(value: Date | string | null | undefined, fallback = '—'): string {
  const date = coerceDate(value);
  if (!date) return fallback;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}/${month}/${day}` : fallback;
}

/** getShareLink 回嘅 url 係相對 path，要用 window.location.origin 組絕對 URL 先可以分享。 */
export function buildAbsoluteShareUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, '');
  if (!path) return base;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

export function buildRecordShareText(record: {
  productName: string;
  productSku: string;
  productPrice: number;
  productDiscountPrice: number | null;
}): string {
  const priceLine = hasDiscount(record)
    ? `優惠價 ${moneyHkd(currentPrice(record))}（原價 ${moneyHkd(record.productPrice)}）`
    : moneyHkd(currentPrice(record));
  return `RedCode AI 試穿預覽：${record.productName}（貨號 ${record.productSku}）· ${priceLine}`;
}

export function recordDownloadFilename(record: { productSku: string; stepNumber: number }): string {
  return `RedCode-AI試穿-${record.productSku}-第${record.stepNumber}件.png`;
}

function supportsNativeFileShare(): boolean {
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
  try {
    const probe = new File(['probe'], 'tryon.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/* ===== 頁面 ===== */
export default function TryOnHistory() {
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  const recordsQuery = tryOnHistoryApi.listMyRecords.useQuery(undefined, { enabled: Boolean(user) });
  const recordsRef = useRef<TryOnHistoryRecord[]>([]);
  recordsRef.current = recordsQuery.data ?? [];

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [viewer, setViewer] = useState<TryOnHistoryRecord | null>(null);
  const [shareRequest, setShareRequest] = useState<{ publicId: string; nonce: number } | null>(null);
  const [shareResult, setShareResult] = useState<{ publicId: string; url: string; text: string; expiresAt: Date | null } | null>(null);
  // 每張圖記住載入失敗次數：第 1 次自動 refetch 拎新 signed URL，之後顯示手動重試
  const [imageErrors, setImageErrors] = useState<Record<string, number>>({});

  // getShareLink 只喺用戶撳「分享」時先 refetch（enabled: false），唔會入頁自動建立連結
  const shareQuery = tryOnHistoryApi.getShareLink.useQuery(
    { publicId: shareRequest?.publicId ?? '' },
    { enabled: false, retry: false, staleTime: 0, gcTime: 0 },
  );

  // 全屏 viewer：Esc 關閉＋focus trap＋鎖背景滾動（共用 dialog 無障礙 hook）
  useDialogA11y(() => setViewer(null), viewer !== null);

  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  /* 下載：先 refetch 拎最新 URL → fetch blob → a[download]；任何一步失敗都出明確提示 */
  const downloadRecord = async (record: TryOnHistoryRecord) => {
    if (busyAction) return;
    setBusyAction(`download:${record.publicId}`);
    setActionError(null);
    try {
      const refreshed = await recordsQuery.refetch();
      const latest = refreshed.data?.find((item) => item.publicId === record.publicId);
      if (refreshed.error || !latest) throw new Error('呢張效果圖已刪除、到期或暫時不可用');
      if (isRecordExpired(latest)) throw new Error('呢張效果圖已過 24 小時保留期，唔可以再下載');
      if (!latest.outputUrl) throw new Error('效果圖暫時不可用，請稍後再試');
      const response = await fetch(latest.outputUrl, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('下載效果圖失敗，請重新整理後再試');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = recordDownloadFilename(latest);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify('PNG 已開始下載');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '下載失敗，請再試');
    } finally {
      setBusyAction(null);
    }
  };

  const nativeShareAvailable = useMemo(supportsNativeFileShare, []);

  /* 主要分享：先重讀本人最新紀錄，再直接經系統分享面板傳同一張 PNG；唔支援文件分享就真正下載。 */
  const shareRecord = async (record: TryOnHistoryRecord) => {
    if (busyAction) return;
    setBusyAction(`share:${record.publicId}`);
    setShareResult(null);
    setActionError(null);
    try {
      const refreshed = await recordsQuery.refetch();
      const latest = refreshed.data?.find((item) => item.publicId === record.publicId);
      if (refreshed.error || !latest) throw new Error('呢張效果圖已刪除、到期或暫時不可用');
      if (isRecordExpired(latest)) throw new Error('呢張效果圖已過 24 小時保留期，唔可以再分享');
      if (!latest.outputUrl) throw new Error('效果圖暫時不可用，請稍後再試');

      const response = await fetch(latest.outputUrl, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('讀取效果圖失敗，請重新整理後再試');
      const blob = await response.blob();
      const filename = recordDownloadFilename(latest);
      const file = new File([blob], filename, { type: 'image/png' });
      const text = buildRecordShareText(latest);

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        // 主要流程只傳 PNG 相檔同公開商品資料，唔將私人 signed media URL 放入分享 payload。
        await navigator.share({ title: 'RedCode AI 試穿預覽', text, files: [file] });
        notify('已分享 AI 試穿 PNG 效果圖同商品資料');
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        notify('呢個裝置唔支援直接分享相檔；PNG 已下載，請喺相簿或檔案夾分享');
      }
    } catch (error) {
      // 用戶喺系統分享面板取消唔係錯，亦唔會顯示「已分享」。
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setActionError(error instanceof Error ? error.message : '分享失敗，請再試');
    } finally {
      setBusyAction(null);
    }
  };

  const startLinkShare = (record: TryOnHistoryRecord) => {
    if (busyAction) return;
    setBusyAction(`link:${record.publicId}`);
    setShareResult(null);
    setActionError(null);
    setShareRequest({ publicId: record.publicId, nonce: Date.now() });
  };

  /* 次要選項：建立 24 小時分享頁連結，供手動複製或 WhatsApp 文字分享；唔假稱 WhatsApp 會附 PNG。 */
  useEffect(() => {
    if (!shareRequest) return;
    const { publicId } = shareRequest;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await shareQuery.refetch();
        if (cancelled) return;
        const link = res.data;
        if (res.error || !link?.url) throw new Error('未能建立 24 小時分享連結，請稍後再試');
        const absoluteUrl = buildAbsoluteShareUrl(window.location.origin, link.url);
        const record = recordsRef.current.find((item) => item.publicId === publicId);
        const text = record ? buildRecordShareText(record) : 'RedCode AI 試穿預覽';
        setShareResult({ publicId, url: absoluteUrl, text, expiresAt: link.expiresAt ?? null });
        notify('24 小時分享連結已顯示喺紀錄下方');
      } catch (error) {
        if (!cancelled) setActionError(error instanceof Error ? error.message : '建立分享連結失敗，請再試');
      } finally {
        if (!cancelled) setBusyAction(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // shareQuery／notify 由 shareRequest 改變嘅同一次 render 閉包捕獲，deps 淨跟 shareRequest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareRequest]);

  const copyShareLink = async (url: string) => {
    if (!navigator.clipboard?.writeText) {
      setActionError('呢個瀏覽器唔支援自動複製，請長按或選取連結手動複製');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      notify('已複製 24 小時分享連結');
    } catch {
      setActionError('複製失敗，請長按或選取連結手動複製');
    }
  };

  const onImageError = (publicId: string) => {
    const count = (imageErrors[publicId] ?? 0) + 1;
    setImageErrors((prev) => ({ ...prev, [publicId]: count }));
    // signed URL 可能過期：第一次失敗自動重拎最新紀錄；再失敗就顯示手動重試，避免無限循環
    if (count <= 1) void recordsQuery.refetch();
  };

  const retryImage = (publicId: string) => {
    setImageErrors((prev) => ({ ...prev, [publicId]: 0 }));
    void recordsQuery.refetch();
  };

  const records = recordsQuery.data ?? [];
  const isBusy = busyAction !== null;

  return (
    <main className="tryon-history">
      <header className="tryon-history-head">
        <Link to="/try-on" className="tryon-history-back"><ArrowLeft size={17} />返回試穿</Link>
        <p className="tryon-history-kicker" style={{ marginTop: 22 }}>REDCODE · MY TRY-ON HISTORY</p>
        <h1>我嘅<span>試穿紀錄</span></h1>
      </header>

      <div className="tryon-history-retention" role="note">
        <Clock3 size={17} aria-hidden="true" />
        <p><strong>每張效果圖喺客戶前台同分享連結保留 24 小時</strong>（香港時間），到期後前台唔可以再放大、下載或分享，分享連結亦會自動失效；想再試同一件商品，撳「重新試穿」就得。主要分享會直接傳 PNG 相檔；裝置唔支援時會先下載，等你喺相簿或檔案夾分享。已下載或經系統分享出去嘅 PNG 無法撤回。主管／admin 後台會為品質檢查同爭議處理保留副本最多 30 日，前台到期或刪除唔會即時刪走後台副本。紀錄只係 AI 視覺預覽，唔代表實際尺碼或合身程度。</p>
      </div>

      {actionError && (
        <div className="tryon-history-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>知道了</button>
        </div>
      )}

      {authLoading ? (
        <section className="tryon-history-state" role="status">
          <LoaderCircle className="tryon-history-spin" size={26} aria-hidden="true" />
          <h2>正在確認帳號…</h2>
          <p>請稍候，確認身分後會即時列出你嘅試穿紀錄。</p>
        </section>
      ) : !user ? (
        <section className="tryon-history-state">
          <LockKeyhole size={30} aria-hidden="true" />
          <p className="tryon-history-kicker">MEMBERS &amp; STAFF</p>
          <h2>先登入，先睇到自己嘅試穿紀錄</h2>
          <p>試穿紀錄係私人內容，每位用戶只可以讀取自己嘅紀錄。</p>
          <div className="tryon-history-state-actions">
            <Link to="/login" className="tryon-history-primary"><LogIn size={18} />登入／註冊</Link>
          </div>
        </section>
      ) : recordsQuery.isLoading ? (
        <section className="tryon-history-state" role="status">
          <LoaderCircle className="tryon-history-spin" size={26} aria-hidden="true" />
          <h2>正在讀取你嘅試穿紀錄…</h2>
          <p>整理緊每張效果圖同埋商品資料，唔使郁。</p>
        </section>
      ) : recordsQuery.isError ? (
        <section className="tryon-history-state" role="alert">
          <AlertTriangle size={30} aria-hidden="true" />
          <h2>紀錄暫時未能載入</h2>
          <p>可能係網絡問題，請檢查連線後重試；你嘅紀錄唔會因為載入失敗而消失。</p>
          <div className="tryon-history-state-actions">
            <button type="button" className="tryon-history-primary" onClick={() => void recordsQuery.refetch()}>
              <RefreshCcw size={17} />重試
            </button>
          </div>
        </section>
      ) : records.length === 0 ? (
        <section className="tryon-history-state">
          <Images size={30} aria-hidden="true" />
          <p className="tryon-history-kicker">NO RECORDS YET</p>
          <h2>仲未有試穿紀錄</h2>
          <p>去試穿工作枱影張全身相、揀件商品，完成後嘅效果圖會喺度保留 24 小時，方便放大、下載同分享。</p>
          <div className="tryon-history-state-actions">
            <Link to="/try-on" className="tryon-history-primary">去試穿</Link>
          </div>
        </section>
      ) : (
        <>
          <p className="tryon-history-kicker" style={{ maxWidth: 1380, margin: '26px auto 0' }}>
            <span className="tryon-history-count">{records.length} 張效果圖 · 按商品逐張列出</span>
          </p>
          <div className="tryon-history-grid" aria-label="我嘅試穿紀錄">
            {records.map((record) => {
              const expired = isRecordExpired(record);
              const imageFailed = (imageErrors[record.publicId] ?? 0) >= 2;
              const downloadBusy = busyAction === `download:${record.publicId}`;
              const shareBusy = busyAction === `share:${record.publicId}`;
              const linkBusy = busyAction === `link:${record.publicId}`;
              return (
                <article key={record.publicId} className="tryon-record" data-expired={expired}>
                  {expired ? (
                    <div className="tryon-record-image-wrap" aria-hidden="true">
                      {record.outputUrl && !imageFailed ? (
                        <img src={record.outputUrl} alt="" loading="lazy" onError={() => onImageError(record.publicId)} />
                      ) : null}
                      <span className="tryon-record-expired-cover">已過 24 小時保留期<br />前台及分享連結已失效</span>
                    </div>
                  ) : imageFailed || !record.outputUrl ? (
                    <div className="tryon-record-image-wrap">
                      <span className="tryon-record-image-fallback">
                        <Images size={28} aria-hidden="true" />
                        效果圖暫時未能顯示，可能係連結剛到期
                        <button type="button" onClick={() => retryImage(record.publicId)}>
                          <RefreshCcw size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />重新載入圖片
                        </button>
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="tryon-record-image-wrap"
                      onClick={() => setViewer(record)}
                      aria-label={`放大 ${record.productName} 試穿效果圖`}
                    >
                      <img
                        src={record.outputUrl}
                        alt={`${record.productName} AI 試穿視覺預覽，右上角有 RedCode 水印`}
                        loading="lazy"
                        onError={() => onImageError(record.publicId)}
                      />
                      <span className="tryon-record-step">第 {record.stepNumber} 件</span>
                      <span className="tryon-record-zoom-badge"><ZoomIn size={14} />放大</span>
                    </button>
                  )}

                  <div className="tryon-record-body">
                    <h2>{record.productName}</h2>
                    <p className="tryon-record-sku">貨號 {record.productSku}</p>
                    <p className="tryon-record-price">
                      {moneyHkd(currentPrice(record))}
                      {hasDiscount(record) && <s>{moneyHkd(record.productPrice)}</s>}
                    </p>
                    <div className="tryon-record-meta">
                      <span>上架日期：<strong>{hkDateLabel(record.listedDate)}</strong></span>
                      <span>
                        {expired ? '保留期：' : '保留至：'}
                        <strong data-expired={expired}>
                          {expired ? '已到期（24 小時）' : `${hkDateTimeLabel(record.expiresAt)}（香港時間）`}
                        </strong>
                      </span>
                    </div>

                    {expired ? (
                      <div className="tryon-record-actions">
                        <Link to="/try-on" className="tryon-history-primary">重新試穿呢件</Link>
                      </div>
                    ) : (
                      <div className="tryon-record-actions">
                        <button
                          type="button"
                          className="tryon-history-primary"
                          onClick={() => navigate(`/try-on?record=${record.publicId}&purchase=1`)}
                          disabled={isBusy}
                        >
                          <ShoppingBag size={17} />立即購買
                        </button>
                        <button
                          type="button"
                          className="tryon-history-secondary"
                          onClick={() => void downloadRecord(record)}
                          disabled={isBusy || imageFailed || !record.outputUrl}
                        >
                          {downloadBusy ? <LoaderCircle className="tryon-history-spin" size={17} /> : <Download size={17} />}
                          {downloadBusy ? '準備中…' : '下載'}
                        </button>
                        <button
                          type="button"
                          className="tryon-history-secondary"
                          onClick={() => void shareRecord(record)}
                          disabled={isBusy || imageFailed || !record.outputUrl}
                        >
                          {shareBusy ? <LoaderCircle className="tryon-history-spin" size={17} /> : <Share2 size={17} />}
                          {shareBusy ? '準備 PNG…' : nativeShareAvailable ? '分享 PNG' : '下載 PNG 去分享'}
                        </button>
                        <button
                          type="button"
                          className="tryon-history-secondary"
                          onClick={() => startLinkShare(record)}
                          disabled={isBusy}
                        >
                          {linkBusy ? <LoaderCircle className="tryon-history-spin" size={17} /> : <MessageCircle size={17} />}
                          {linkBusy ? '建立連結中…' : '24 小時連結／WhatsApp'}
                        </button>
                      </div>
                    )}

                    {shareResult?.publicId === record.publicId && (
                      <div className="tryon-record-share" role="status">
                        <strong>次要 24 小時分享頁連結{shareResult.expiresAt ? `（有效至 ${hkDateTimeLabel(shareResult.expiresAt)}）` : ''}：</strong>
                        <span>{shareResult.url}</span>
                        <button type="button" onClick={() => void copyShareLink(shareResult.url)}>複製連結</button>
                        <a
                          href={`https://wa.me/?text=${encodeURIComponent(`${shareResult.text}\n${shareResult.url}`)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        ><MessageCircle size={15} />WhatsApp 傳送連結＋商品資料（唔附 PNG）</a>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {viewer && (
        <div
          className="tryon-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={`${viewer.productName} 試穿效果圖放大預覽`}
          data-dialog-a11y-root
          onClick={(event) => {
            if (event.target === event.currentTarget) setViewer(null);
          }}
        >
          <div className="tryon-viewer-bar">
            <p>{viewer.productName} · 第 {viewer.stepNumber} 件 · 按 Esc 或右上掣關閉</p>
            <button type="button" className="tryon-viewer-close" onClick={() => setViewer(null)} aria-label="關閉放大預覽">
              <X size={22} />
            </button>
          </div>
          <div className="tryon-viewer-stage">
            <img src={viewer.outputUrl} alt={`${viewer.productName} AI 試穿視覺預覽（放大）`} />
          </div>
        </div>
      )}

      {notice && <div className="tryon-history-toast" role="status"><Check size={17} />{notice}</div>}
    </main>
  );
}
