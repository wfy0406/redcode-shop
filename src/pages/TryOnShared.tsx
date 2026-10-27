import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  Check,
  Clock3,
  Download,
  Link2,
  LoaderCircle,
  Shirt,
  Sparkles,
} from 'lucide-react';
import {
  currentPrice,
  hasDiscount,
  hkDateLabel,
  hkDateTimeLabel,
  isRecordExpired,
  moneyHkd,
  tryOnHistoryApi,
  type TryOnSharedRecord,
} from './TryOnHistory';
import './tryOnHistory.css';

export type SharedLinkParams = {
  publicId: string;
  expires: number;
  signature: string;
  paramsValid: boolean;
};

/**
 * 分享連結格式（同 api/tryonSharing.ts signTryOnShare 一致）：
 *   /try-on/shared/:publicId?e=<expiresMs>&s=<signature>
 * publicId 係 path param（React Router useParams）；e／s 繼續係 query string。
 * e 必須係正嘅毫秒時間戳，三樣齊先會開 query。
 */
export function parseSharedParams(
  publicIdParam: string | undefined,
  query: { get(key: string): string | null },
): SharedLinkParams {
  const publicId = publicIdParam ?? '';
  const expiresParam = query.get('e') ?? '';
  const signature = query.get('s') ?? '';
  const expires = Number(expiresParam);
  const paramsValid =
    Boolean(publicId) && Boolean(signature) && expiresParam !== '' && Number.isFinite(expires) && expires > 0;
  return { publicId, expires, signature, paramsValid };
}

/**
 * 公開分享頁：朋友撳分享連結入嚟，淨係見到生成圖＋公開商品資料。
 * 唔會回原相、會員資料或任何私人內容；連結過期／簽名無效會見到友善說明。
 */
export default function TryOnShared() {
  const { publicId: publicIdParam } = useParams();
  const [searchParams] = useSearchParams();
  const { publicId, expires, signature, paramsValid } = parseSharedParams(publicIdParam, searchParams);

  const sharedQuery = tryOnHistoryApi.getShared.useQuery(
    { publicId, expires, signature },
    { enabled: paramsValid, retry: false, refetchOnWindowFocus: false },
  );

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // 圖片載入失敗次數：第 1 次自動 refetch 拎新 signed URL，再失敗先顯示手動重試
  const [imageErrors, setImageErrors] = useState(0);
  const imageFailed = imageErrors >= 2;

  /* 圖片載入失敗：第 1 次自動 refetch 拎新 signed URL，再失敗先顯示手動重試，避免無限循環 */
  const onImageError = () => {
    const count = imageErrors + 1;
    setImageErrors(count);
    if (count <= 1) void sharedQuery.refetch();
  };

  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  /* 下載：用而家嘅 outputUrl fetch blob → a[download]；失敗出明確提示 */
  const downloadImage = async (record: TryOnSharedRecord) => {
    if (downloading) return;
    setDownloading(true);
    setActionError(null);
    try {
      if (isRecordExpired(record)) throw new Error('呢條分享連結已過期，效果圖已唔可以再下載');
      if (!record.outputUrl) throw new Error('效果圖暫時不可用，請稍後再試');
      const response = await fetch(record.outputUrl, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('下載效果圖失敗，請重新整理後再試');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `RedCode-AI試穿-${record.productSku}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify('PNG 已開始下載');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '下載失敗，請再試');
    } finally {
      setDownloading(false);
    }
  };

  const record = sharedQuery.data ?? null;
  const expired = record ? isRecordExpired(record) : false;
  // 後端會直接報錯（retry:false）；本地時間過咗都當過期，唔好用戶白等
  const invalid = !paramsValid || sharedQuery.isError || expired;

  return (
    <main className="tryon-shared">
      <header className="tryon-history-head">
        <p className="tryon-history-kicker">REDCODE · SHARED TRY-ON PREVIEW</p>
        <h1>朋友嘅<span> AI 試穿效果</span></h1>
      </header>

      <div className="tryon-history-retention" role="note">
        <Clock3 size={17} aria-hidden="true" />
        <p>呢頁只顯示生成效果圖同公開商品資料；<strong>原相同會員資料唔會喺度出現</strong>。分享連結有時限，過期後會自動失效。</p>
      </div>

      {actionError && (
        <div className="tryon-history-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>知道了</button>
        </div>
      )}

      {invalid ? (
        <section className="tryon-history-state" role="alert">
          <Link2 size={30} aria-hidden="true" />
          <p className="tryon-history-kicker">LINK UNAVAILABLE</p>
          <h2>{expired ? '呢條分享連結已過期' : '連結無效或已過期'}</h2>
          <p>
            分享連結有時限，過期或資料不完整就打唔開。你可以請朋友重新分享一次，或者直接去商品頁睇最新款式。
          </p>
          <div className="tryon-history-state-actions">
            <Link to="/products" className="tryon-history-primary"><Shirt size={17} />去商品頁睇款式</Link>
            <Link to="/try-on" className="tryon-history-secondary"><Sparkles size={17} />自己試穿</Link>
          </div>
        </section>
      ) : sharedQuery.isLoading || !record ? (
        <section className="tryon-history-state" role="status">
          <LoaderCircle className="tryon-history-spin" size={26} aria-hidden="true" />
          <h2>正在開啟分享內容…</h2>
          <p>確認連結有效之後，會即時顯示效果圖。</p>
        </section>
      ) : (
        <>
          <figure className="tryon-shared-figure">
            <div className="tryon-shared-frame">
              {record.outputUrl && !imageFailed ? (
                <img
                  src={record.outputUrl}
                  alt={`${record.productName} AI 試穿視覺預覽，右上角有 RedCode 水印`}
                  onError={onImageError}
                />
              ) : (
                <span>
                  效果圖暫時未能顯示<br />
                  <button
                    type="button"
                    className="tryon-history-secondary"
                    style={{ marginTop: 12, color: 'inherit', borderColor: 'currentColor' }}
                    onClick={() => {
                      setImageErrors(0);
                      void sharedQuery.refetch();
                    }}
                  >重新載入圖片</button>
                </span>
              )}
            </div>
            <figcaption className="tryon-shared-caption">
              AI 試穿只係視覺預覽，唔代表實際尺碼、鬆緊或合身程度；尺寸以商品尺寸表及實物為準。
            </figcaption>
          </figure>

          <section className="tryon-shared-meta" aria-label="公開商品資料">
            <h2>{record.productName}</h2>
            <p className="tryon-record-sku">貨號 {record.productSku}</p>
            <p className="tryon-record-price">
              {moneyHkd(currentPrice(record))}
              {hasDiscount(record) && <s>{moneyHkd(record.productPrice)}</s>}
            </p>
            <p>上架日期：<strong>{hkDateLabel(record.listedDate)}</strong></p>
            <p>分享有效至：<strong>{hkDateTimeLabel(record.expiresAt)}</strong>（香港時間）</p>
          </section>

          <div className="tryon-shared-actions">
            <button
              type="button"
              className="tryon-history-primary"
              onClick={() => void downloadImage(record)}
              disabled={downloading || imageFailed || !record.outputUrl}
            >
              {downloading ? <LoaderCircle className="tryon-history-spin" size={17} /> : <Download size={17} />}
              {downloading ? '準備中…' : '下載效果圖'}
            </button>
            <Link to="/products" className="tryon-history-secondary"><Shirt size={17} />去商品頁</Link>
          </div>

          <p className="tryon-shared-note">
            想自己試？去 <Link to="/try-on">AI 試穿工作枱</Link> 影張全身相，揀返呢件商品就可以生成你專屬嘅效果圖。
          </p>
        </>
      )}

      {notice && <div className="tryon-history-toast" role="status"><Check size={17} />{notice}</div>}
    </main>
  );
}
