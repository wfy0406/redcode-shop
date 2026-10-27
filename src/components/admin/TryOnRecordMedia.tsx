import { useEffect, useState, type ReactNode } from 'react';
import { Clock3, ImageOff, Images, RefreshCw } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { getToken } from '@/lib/auth';
import { Skeleton } from '@/components/ui/skeleton';
import Lightbox from './Lightbox';

/**
 * 後台試穿紀錄「三圖」區塊：客戶原相 ／ AI 生成圖 ／ 商品圖（2026-10-28）
 * ─ 按需載入：預設只見「查看圖片」掣；撳開先打 tryon.getAdminRecordMedia 攞私人圖 URL，
 *   一版 20 行唔會一次過簽幾十條 URL
 * ─ 私人圖 URL 絕對唔會出現喺 list payload；list item 只有
 *   media: { archiveAvailable: boolean; productImageUrl: string | null }
 * ─ 私人圖 URL 唔直接落 <img>：Hono /api/admin/tryon-media 會核 Authorization，所以用 fetch
 *   帶現有 auth token（getToken，同 trpc provider／其他後台上傳一致）攞 blob，
 *   URL.createObjectURL 顯示，unmount／換 URL 即 revoke
 * ─ 保留期：客戶前台 24 小時；後台原相及生成圖只保留 30 日，過期顯示「已過30日保留期」
 * ─ 生成未完成／失敗 → 生成圖格顯示「未有生成圖」（正常狀態，唔係錯誤）
 * ─ 商品圖係公開素材，直接 <img src>；載入失敗顯示 placeholder 可重試
 * ─ 點縮圖開 Lightbox 放大（1:1 睇原圖）
 */

/** 文案集中喺度，畫面同測試共用 */
export const TRYON_MEDIA_COPY = {
  viewImages: '查看圖片',
  hideImages: '收起圖片',
  inputCaption: '客戶原相',
  outputCaption: 'AI 生成圖',
  productCaption: '商品圖',
  expired: '已過30日保留期',
  pendingOutput: '未有生成圖',
  loadFailed: '載入失敗',
  retry: '重試',
  productUnavailable: '未有商品圖',
  zoom: '放大',
} as const;

/** 一格圖嘅歸納狀態（ready 以外全部係 placeholder／skeleton） */
export type TryOnMediaCellState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'expired' }
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; url: string };

/**
 * 私人圖格（原相／生成圖）狀態歸納——純邏輯，畫面同測試共用。
 * 優先次序：生成圖未完成／失敗（根本冇圖）→ 保留期已過 → 查詢中 → 查詢失敗 → URL null（已刪）→ ready。
 */
export function resolvePrivateMediaState(input: {
  kind: 'input' | 'output';
  status: string;
  archiveAvailable: boolean;
  queryLoading: boolean;
  queryError: boolean;
  url: string | null | undefined;
}): TryOnMediaCellState {
  // 生成圖：工作未完成／失敗 → 從來冇生成圖（優先於保留期，因為根本冇圖可保留）
  if (input.kind === 'output' && input.status !== 'completed') return { kind: 'pending' };
  // list 已話 archive 唔喺度 → 唔使打 endpoint，直接過期格
  if (!input.archiveAvailable) return { kind: 'expired' };
  if (input.queryLoading) return { kind: 'loading' };
  if (input.queryError) return { kind: 'error' };
  // endpoint 回 null ＝ 媒體已刪／到期（同 archiveAvailable 理論一致，防禦性兜底）
  if (!input.url) return { kind: 'expired' };
  return { kind: 'ready', url: input.url };
}

/** 商品圖格狀態：冇 URL → 未有商品圖；<img> onError → 載入失敗（可重試） */
export function resolveProductMediaState(
  productImageUrl: string | null | undefined,
  loadFailed: boolean,
): TryOnMediaCellState {
  if (!productImageUrl) return { kind: 'unavailable' };
  if (loadFailed) return { kind: 'error' };
  return { kind: 'ready', url: productImageUrl };
}

export interface TryOnRecordMediaProps {
  /** 試穿工作對外 uuid（按需攞私人圖 URL 用） */
  publicId: string;
  /** 工作狀態（未完成／失敗 → 生成圖格顯示「未有生成圖」） */
  status: string;
  /** list item media.archiveAvailable：後台私人原相／生成圖仲喺 30 日保留期內 */
  archiveAvailable: boolean;
  /** list item media.productImageUrl：公開商品圖（null → 「未有商品圖」） */
  productImageUrl: string | null;
  /** 「邊個試穿邊件」一句過描述（describeTryOnRecord 嗰句；aria-label／燈箱標題用） */
  describe: string;
}

interface ZoomTarget {
  src: string;
  label: string;
}

interface AuthedImageResult {
  objectUrl: string | null;
  loading: boolean;
  error: boolean;
}

/**
 * 私人圖 URL → blob object URL（帶 auth token fetch；unmount／換 URL revoke）。
 * 私人 URL 唔直接落 <img src>，因為 Hono media route 要核 Authorization header。
 */
function useAuthedObjectUrl(sourceUrl: string, reloadKey: number): AuthedImageResult {
  const [result, setResult] = useState<{ key: string; objectUrl: string | null; error: boolean } | null>(null);
  const key = `${reloadKey}:${sourceUrl}`;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const token = getToken();
    fetch(sourceUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ key, objectUrl, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, objectUrl: null, error: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, sourceUrl]);

  // key 啱啱轉（新 URL／重試）→ 舊 result 即時作廢，顯示返 loading，唔會閃舊圖
  if (result?.key !== key) return { objectUrl: null, loading: true, error: false };
  return { objectUrl: result.objectUrl, loading: false, error: result.error };
}

/** 三格共用外框：上圖下 caption；h-20（80px）觸控目標 ≥44px；淺框線唔係 nested card */
function CellShell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div
        className="flex h-20 items-center justify-center overflow-hidden rounded-lg border"
        style={{ borderColor: 'var(--space-line)' }}
      >
        {children}
      </div>
      <p className="mt-1 truncate text-center text-[11px] text-txt-3">{caption}</p>
    </div>
  );
}

/** 灰格 placeholder（過期／未生成／未有商品圖） */
function PlaceholderCell({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="flex flex-col items-center gap-1 px-1 text-center text-[11px] leading-tight text-txt-3">
      {icon}
      {text}
    </span>
  );
}

/** 載入失敗格：成格係重試掣（h-20 ≥44px） */
function RetryCellButton({ caption, onRetry }: { caption: string; onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="flex h-full min-h-[44px] w-full flex-col items-center justify-center gap-1 px-1 text-[11px] leading-tight text-txt-3 transition-colors hover:text-txt-1 focus:text-txt-1 focus:outline-none"
      aria-label={`${caption}${TRYON_MEDIA_COPY.loadFailed}，撳一下${TRYON_MEDIA_COPY.retry}`}
    >
      <RefreshCw size={14} aria-hidden="true" />
      {TRYON_MEDIA_COPY.loadFailed}・{TRYON_MEDIA_COPY.retry}
    </button>
  );
}

/** 縮圖掣：撳開 Lightbox 放大（h-20 ≥44px） */
function ThumbButton({
  src,
  label,
  onZoom,
  onError,
}: {
  src: string;
  label: string;
  onZoom: (target: ZoomTarget) => void;
  onError?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onZoom({ src, label })}
      className="block h-full min-h-[44px] w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-pink"
      aria-label={`${TRYON_MEDIA_COPY.zoom}${label}`}
    >
      <img src={src} alt={label} loading="lazy" onError={onError} className="h-full w-full object-cover" />
    </button>
  );
}

/** 非 ready 狀態統一出口（loading skeleton／error 重試／expired／pending／unavailable） */
function StateCell({
  caption,
  state,
  onRetry,
}: {
  caption: string;
  state: Exclude<TryOnMediaCellState, { kind: 'ready' }>;
  onRetry: () => void;
}) {
  let body: ReactNode;
  if (state.kind === 'loading') {
    body = <Skeleton className="h-full w-full rounded-none" aria-label={`${caption}載入中`} />;
  } else if (state.kind === 'error') {
    body = <RetryCellButton caption={caption} onRetry={onRetry} />;
  } else if (state.kind === 'expired') {
    body = <PlaceholderCell icon={<Clock3 size={14} aria-hidden="true" />} text={TRYON_MEDIA_COPY.expired} />;
  } else if (state.kind === 'pending') {
    body = <PlaceholderCell icon={<ImageOff size={14} aria-hidden="true" />} text={TRYON_MEDIA_COPY.pendingOutput} />;
  } else {
    body = <PlaceholderCell icon={<ImageOff size={14} aria-hidden="true" />} text={TRYON_MEDIA_COPY.productUnavailable} />;
  }
  return <CellShell caption={caption}>{body}</CellShell>;
}

/** 私人圖格（原相／生成圖）：ready 之後用 blob object URL 顯示；blob 載入失敗可重試 */
function PrivateImageCell({
  url,
  caption,
  describe,
  onZoom,
}: {
  url: string;
  caption: string;
  describe: string;
  onZoom: (target: ZoomTarget) => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const img = useAuthedObjectUrl(url, reloadKey);
  const label = `${describe} — ${caption}`;
  if (img.loading) {
    return <StateCell caption={caption} state={{ kind: 'loading' }} onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  if (img.error || !img.objectUrl) {
    return <StateCell caption={caption} state={{ kind: 'error' }} onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  return (
    <CellShell caption={caption}>
      <ThumbButton src={img.objectUrl} label={label} onZoom={onZoom} />
    </CellShell>
  );
}

/** 打開之後嘅三格橫排（原相／生成圖／商品圖） */
function MediaStrip({
  publicId,
  status,
  archiveAvailable,
  productImageUrl,
  describe,
  onZoom,
}: TryOnRecordMediaProps & { onZoom: (target: ZoomTarget) => void }) {
  // 按需：預設 enabled:false，打開先 refetch；archive 唔喺度就唔使打（endpoint 都係回 null）
  const mediaQuery = trpc.tryon.getAdminRecordMedia.useQuery({ publicId }, { enabled: false, retry: false });
  const { refetch } = mediaQuery;
  const [productImgFailed, setProductImgFailed] = useState(false);

  useEffect(() => {
    if (archiveAvailable) void refetch();
  }, [archiveAvailable, refetch]);

  // 未回應／回應緊 → loading；失敗但冇舊 data → error（有舊 data 就留住舊圖，唔閃）
  const queryLoading = archiveAvailable && mediaQuery.data === undefined && !mediaQuery.isError;
  const queryError = archiveAvailable && mediaQuery.isError && mediaQuery.data === undefined;

  const inputState = resolvePrivateMediaState({
    kind: 'input',
    status,
    archiveAvailable,
    queryLoading,
    queryError,
    url: mediaQuery.data?.inputUrl,
  });
  const outputState = resolvePrivateMediaState({
    kind: 'output',
    status,
    archiveAvailable,
    queryLoading,
    queryError,
    url: mediaQuery.data?.outputUrl,
  });
  const productState = resolveProductMediaState(productImageUrl, productImgFailed);

  const retryQuery = () => void refetch();

  return (
    <div
      className="mt-2 grid grid-cols-3 gap-2"
      role="group"
      aria-label={`${describe} 嘅圖片`}
      aria-busy={queryLoading || undefined}
    >
      {inputState.kind === 'ready' ? (
        <PrivateImageCell url={inputState.url} caption={TRYON_MEDIA_COPY.inputCaption} describe={describe} onZoom={onZoom} />
      ) : (
        <StateCell caption={TRYON_MEDIA_COPY.inputCaption} state={inputState} onRetry={retryQuery} />
      )}

      {outputState.kind === 'ready' ? (
        <PrivateImageCell url={outputState.url} caption={TRYON_MEDIA_COPY.outputCaption} describe={describe} onZoom={onZoom} />
      ) : (
        <StateCell caption={TRYON_MEDIA_COPY.outputCaption} state={outputState} onRetry={retryQuery} />
      )}

      {productState.kind === 'ready' ? (
        <CellShell caption={TRYON_MEDIA_COPY.productCaption}>
          <ThumbButton
            src={productState.url}
            label={`${describe} — ${TRYON_MEDIA_COPY.productCaption}`}
            onZoom={onZoom}
            onError={() => setProductImgFailed(true)}
          />
        </CellShell>
      ) : (
        <StateCell
          caption={TRYON_MEDIA_COPY.productCaption}
          state={productState}
          onRetry={() => setProductImgFailed(false)}
        />
      )}
    </div>
  );
}

/**
 * 每筆紀錄嘅「查看圖片」入口：撳開先載入三圖，再撳收埋（收埋即 unmount，blob URL 即刻 revoke）。
 * 桌面表格欄同手機卡都用呢個，外層唔使加 card 框。
 */
export default function TryOnRecordMedia(props: TryOnRecordMediaProps) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState<ZoomTarget | null>(null);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          // 收起時唔好留低一個用緊已 revoke blob URL 嘅燈箱。
          setZoom(null);
        }}
        aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-4 text-[12.5px] text-txt-2 transition-colors hover:text-txt-1 focus:border-pink focus:outline-none"
        style={{ borderColor: 'var(--space-line)' }}
        aria-label={`${open ? TRYON_MEDIA_COPY.hideImages : TRYON_MEDIA_COPY.viewImages}：${props.describe}`}
      >
        <Images size={14} aria-hidden="true" />
        {open ? TRYON_MEDIA_COPY.hideImages : TRYON_MEDIA_COPY.viewImages}
      </button>
      {open && <MediaStrip {...props} onZoom={setZoom} />}
      {zoom && <Lightbox src={zoom.src} label={zoom.label} alt={zoom.label} onClose={() => setZoom(null)} />}
    </div>
  );
}
