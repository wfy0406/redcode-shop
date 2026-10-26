import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigationType, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  Camera,
  Check,
  Clock3,
  Download,
  ImagePlus,
  Images,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  MessageCircle,
  RefreshCcw,
  RotateCcw,
  ScanLine,
  Search,
  Share2,
  Shirt,
  Sparkles,
  SwitchCamera,
  Trash2,
  X,
} from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../api/router';
import {
  TRYON_PRODUCT_KINDS,
  buildTryOnShareText,
  buildTryOnWhatsAppUrl,
  tryOnProductKindLabel,
  type TryOnProductKind,
  type TryOnShareProduct,
} from '@contracts/tryon';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import {
  addTryOnProductSelection,
  moveTryOnProductSelection,
  parseTryOnBatchPlan,
  type TryOnBatchPlan,
  type TryOnProductSelection,
} from './tryonSelection';
import { getTryOnCoverCrop, tryOnCameraVideoConstraints } from './tryonCamera';
import { emitTryOnGuideAction } from '@/components/globalFairyGuide';
import TryOnPurchase from './TryOnPurchase';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type TryOnProduct = RouterOutputs['tryon']['listProducts'][number];
type TryOnJob = RouterOutputs['tryon']['getJob'];
type LookItem = TryOnJob['lookItems'][number];
type CameraState = 'idle' | 'opening' | 'open' | 'denied' | 'error';
type FacingMode = 'environment' | 'user';

const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const USAGE_STATUSES = new Set(['queued', 'processing', 'completed']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function galleryOf(product: TryOnProduct): string[] {
  const source = product.photos?.length ? product.photos : [product.image];
  return source.filter((src): src is string => Boolean(src));
}

function kindLabel(kind: string): string {
  return (TRYON_PRODUCT_KINDS as readonly string[]).includes(kind)
    ? tryOnProductKindLabel(kind as TryOnProductKind)
    : kind;
}

function money(value: number): string {
  return `HK$${Math.max(0, Math.round(value)).toLocaleString('en-HK')}`;
}

function statusLabel(status: string): string {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失敗';
  if (status === 'processing') return '生成中';
  return '等待生成';
}

function getFailureHelp(code: string | null | undefined, isStaff: boolean): { title: string; detail: string } | null {
  if (code !== 'PROVIDER_AUTH') return null;
  return {
    title: '唔關你張相事，係試穿服務授權未接通',
    detail: isStaff
      ? '請管理員喺 FASHN API Dashboard 核對 key，再用複製掣更新官網 Render 服務嘅 FASHN_API_KEY；確認新部署完成後先重試。唔使改 APP_SECRET，亦唔使重拍或改商品相。'
      : '請通知管理員檢查試穿服務設定；你唔使重拍或改商品相。修正設定前再按重試都只會得到同一個授權結果。',
  };
}

function operationKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '');
  const random = Math.random().toString(36).slice(2, 14);
  return `tryon_${Date.now().toString(36)}_${random}`.slice(0, 64);
}

function currentJobStorageKey(userId: number): string {
  return `rc_tryon_current_${userId}`;
}

function batchPlanStorageKey(userId: number): string {
  return `rc_tryon_batch_${userId}`;
}

// 用嚟綁定 idempotency key 嘅操作意圖摘要；唔需要加密強度，只要區分唔同原相。
function intentDigest(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return `${text.length.toString(36)}_${hash.toString(36)}`;
}

// 後端修正會喺 lookItems 加 mediaDeleted；未加入前視作未刪，保持 TypeScript 通過。
function isLookItemMediaDeleted(item: LookItem): boolean {
  return Boolean((item as { mediaDeleted?: boolean }).mediaDeleted);
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('讀取圖片失敗，請重新揀相'));
    reader.readAsDataURL(blob);
  });
}

async function privateUrlToDataUri(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('原相暫時未能讀取，請重新由相簿揀相');
  return blobToDataUri(await response.blob());
}

function validateImageDimensions(dataUri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth < 300 || image.naturalHeight < 300) {
        reject(new Error('相片太細，請揀最少 300 × 300 像素嘅全身相'));
        return;
      }
      resolve();
    };
    image.onerror = () => reject(new Error('相片格式未能讀取，請改用 JPEG、PNG 或 WebP'));
    image.src = dataUri;
  });
}

function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
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

function shareProductsForJob(job: TryOnJob): TryOnShareProduct[] {
  return job.lookItems
    .filter((item) => item.status === 'completed' && item.stepNumber <= job.stepNumber)
    .sort((a, b) => a.stepNumber - b.stepNumber || a.id - b.id)
    .map((item) => ({
      productId: item.productId,
      productName: item.productName,
      productSku: item.productSku,
      productPrice: item.productPrice,
      productDiscountPrice: item.productDiscountPrice,
    }));
}

function lineageBlockReason(product: TryOnProduct, job: TryOnJob | undefined): string | null {
  if (!job) return null;
  // 防重只睇當前步或之前嘅 usage rows：更後嘅步屬另一分支（刪除後應可以再由呢度追加）；
  // 先前步即使 mediaDeleted，商品仍可能已喺圖入面（可由更後 source 追加落嚟），所以唔排除。
  const lineage = job.lookItems.filter(
    (item) => USAGE_STATUSES.has(item.status) && item.stepNumber <= job.stepNumber,
  );
  if (lineage.some((item) => item.productId === product.id)) return '呢件已加入造型';
  if (lineage.some((item) => item.tryOnKind === product.tryOnKind)) {
    return `已有${kindLabel(product.tryOnKind)}`;
  }
  return null;
}

function expiryLabel(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '24 小時後';
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

export default function TryOn() {
  const { user, isLoading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const utils = trpc.useUtils();
  const navigationType = useNavigationType();
  const [searchParams] = useSearchParams();
  const preselectProductId = Number(searchParams.get('productId'));
  const preselectPhotoIndex = Number(searchParams.get('photoIndex') ?? 0);

  const [jobState, setJobState] = useState<{ userId: number | null; publicId: string | null }>({
    userId: null,
    publicId: null,
  });
  const currentPublicId = jobState.userId === userId ? jobState.publicId : null;
  const setCurrentPublicId = useCallback(
    (publicId: string | null) => {
      if (!userId) return;
      setJobState({ userId, publicId });
    },
    [userId],
  );

  const [modelImage, setModelImage] = useState<string | null>(null);
  const [selections, setSelections] = useState<TryOnProductSelection[]>([]);
  const [savedJobPublicId, setSavedJobPublicId] = useState<string | null>(null);
  const [batchPlan, setBatchPlanState] = useState<TryOnBatchPlan | null>(null);
  // 異步第二件返回時只可以更新而家仍屬同一次授權嘅計劃，唔可以復活已刪除／已取消嘅舊 closure。
  const batchPlanRef = useRef<TryOnBatchPlan | null>(null);
  batchPlanRef.current = batchPlan;
  const [batchActionPending, setBatchActionPending] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | TryOnProductKind>('all');
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'download' | 'share' | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const applyBatchPlan = useCallback(
    (plan: TryOnBatchPlan | null) => {
      batchPlanRef.current = plan;
      setBatchPlanState(plan);
      if (!userId) return;
      const key = batchPlanStorageKey(userId);
      if (plan) window.sessionStorage.setItem(key, JSON.stringify(plan));
      else window.sessionStorage.removeItem(key);
    },
    [userId],
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // 每次開鏡／停鏡都遞增：getUserMedia 異步 resolve 時憑 token 判斷係咪過期，過期即時熄新 stream。
  const cameraTokenRef = useRef(0);
  // 綁定操作意圖嘅 idempotency key：失敗後相同 payload 重試重用；成功或意圖改變先換新。
  const createIntentRef = useRef<{ intent: string; key: string } | null>(null);
  const createInFlightRef = useRef(false);
  // 私人 signed URL 過期後由 img onError 觸發有限次 refetch（每個 job 最多 3 次、最少隔 10 秒）。
  const urlRefreshRef = useRef({ count: 0, lastAt: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const preselectedRef = useRef(false);
  const autoBatchInFlightRef = useRef<string | null>(null);
  const previousJobStatusRef = useRef<{ publicId: string; status: string } | null>(null);

  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4200);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const accessQuery = trpc.tryon.getMyAccess.useQuery(undefined, {
    enabled: Boolean(user),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const access = accessQuery.data;
  const productsQuery = trpc.tryon.listProducts.useQuery(undefined, {
    enabled: Boolean(user && access),
    retry: 1,
    staleTime: 60_000,
  });
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);

  const jobQuery = trpc.tryon.getJob.useQuery(
    { publicId: currentPublicId ?? '00000000-0000-0000-0000-000000000000' },
    {
      enabled: Boolean(user && currentPublicId),
      retry: 1,
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: (query) =>
        query.state.data && ACTIVE_STATUSES.has(query.state.data.status) ? 2500 : false,
      refetchIntervalInBackground: false,
    },
  );
  const job = jobQuery.data;

  const createMutation = trpc.tryon.create.useMutation();
  const deleteMutation = trpc.tryon.deleteMedia.useMutation();

  const stopCamera = useCallback(() => {
    // 遞增 token：任何未完成嘅 getUserMedia resolve 時會見到 token 已變，即時 stop 新 stream。
    cameraTokenRef.current += 1;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraState('idle');
  }, []);

  useEffect(() => {
    return () => {
      cameraTokenRef.current += 1;
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      // 即使 getUserMedia 仲未 resolve 都要作廢 token；唔可以等 stream 出現先停。
      if (document.hidden) stopCamera();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stopCamera]);

  useEffect(() => {
    // 換帳號／logout 一律即時停鏡頭（包括開緊途中嘅 getUserMedia，靠 cameraTokenRef 作廢）。
    stopCamera();
    createIntentRef.current = null;
    autoBatchInFlightRef.current = null;
    setBatchPlanState(null);
    setModelImage(null);
    setSelections([]);
    setActionError(null);
    setDeleteArmed(false);
    preselectedRef.current = false;
    if (!userId) {
      setJobState({ userId: null, publicId: null });
      setSavedJobPublicId(null);
      return;
    }
    const currentKey = currentJobStorageKey(userId);
    const batchKey = batchPlanStorageKey(userId);
    const saved = window.sessionStorage.getItem(currentKey);
    setSavedJobPublicId(saved);
    if (navigationType === 'POP' && saved) {
      // 只有 reload／直接載入先自動恢復；由其他頁 PUSH 入嚟一定係新一套。
      setJobState({ userId, publicId: saved });
      const restored = parseTryOnBatchPlan(window.sessionStorage.getItem(batchKey), userId);
      const validPlan = restored?.rootPublicId === saved ? restored : null;
      setBatchPlanState(validPlan);
      if (!validPlan) window.sessionStorage.removeItem(batchKey);
    } else {
      setJobState({ userId, publicId: null });
      // fresh navigation 取消未提交嘅後續生成；已完成工作及 current id 保留作明確「繼續舊造型」。
      window.sessionStorage.removeItem(batchKey);
    }
  }, [navigationType, userId, stopCamera]);

  useEffect(() => {
    if (!userId || jobState.userId !== userId || !jobState.publicId) return;
    window.sessionStorage.setItem(currentJobStorageKey(userId), jobState.publicId);
    setSavedJobPublicId(jobState.publicId);
  }, [jobState, userId]);

  useEffect(() => {
    // sessionStorage 恢復返嚟嘅工作如果後台明確回 NOT_FOUND（已刪或唔存在），
    // 自動清走呢個 user 嘅 current job key/state，唔會每次 reload 都永久錯誤。
    // 只對明確 NOT_FOUND 先清；網絡等 transient 錯誤保留，用戶可以按「重試」。
    if (!userId || jobState.userId !== userId || !jobState.publicId || !jobQuery.isError) return;
    const code = (jobQuery.error?.data as { code?: string } | null | undefined)?.code;
    if (code !== 'NOT_FOUND') return;
    setJobState({ userId, publicId: null });
    setSavedJobPublicId(null);
    setBatchPlanState(null);
    window.sessionStorage.removeItem(currentJobStorageKey(userId));
    window.sessionStorage.removeItem(batchPlanStorageKey(userId));
    setActionError('上次嘅試穿工作紀錄已唔存在或已刪除；請由全身相重新開始一套。');
  }, [jobQuery.error, jobQuery.isError, jobState, userId]);

  useEffect(() => {
    setDeleteArmed(false);
    // 切換到現有步驟先清舊錯誤；NOT_FOUND 清 session 後返回 null，要保留解釋訊息。
    if (currentPublicId) setActionError(null);
    urlRefreshRef.current = { count: 0, lastAt: 0 };
  }, [currentPublicId]);

  useEffect(() => {
    if (!job) {
      previousJobStatusRef.current = null;
      return;
    }
    const previous = previousJobStatusRef.current;
    if (previous?.publicId === job.publicId && previous.status !== job.status) {
      if (job.status === 'completed') notify('AI 試穿完成，可以對照、下載或分享 ✓');
      if (job.status === 'failed') notify('今次生成失敗，個人每日額度已按規則處理；可以重試');
      if (job.status === 'completed' || job.status === 'failed') {
        void utils.tryon.getMyAccess.invalidate();
      }
    }
    previousJobStatusRef.current = { publicId: job.publicId, status: job.status };
  }, [job, notify, utils]);

  // 私人 signed URL 有時限（約 10 分鐘）；完成頁長開後 img 會 broken。
  // onError 時做有限制 refetch 攞新 signed URL：每個 job 最多 3 次、最少隔 10 秒，避免無限 loop。
  const refreshSignedImageUrls = useCallback(() => {
    const state = urlRefreshRef.current;
    const now = Date.now();
    if (state.count >= 3 || now - state.lastAt < 10_000) return;
    urlRefreshRef.current = { count: state.count + 1, lastAt: now };
    void jobQuery.refetch();
  }, [jobQuery]);

  const canEditRoot = !job || (job.status === 'failed' && job.stepNumber === 1);

  useEffect(() => {
    // 原相一鎖定（包括 getUserMedia 仲開緊嘅情況）就即時停晒 tracks。
    if (!canEditRoot) stopCamera();
  }, [canEditRoot, stopCamera]);

  const startCamera = useCallback(
    async (requestedFacing: FacingMode = facingMode) => {
      if (!canEditRoot) return;
      setActionError(null);
      setCameraMessage(null);
      const token = ++cameraTokenRef.current;
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState('error');
        setCameraMessage('呢個瀏覽器或 App WebView 未提供鏡頭功能，請改用相簿揀相。');
        return;
      }
      setCameraState('opening');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: tryOnCameraVideoConstraints(requestedFacing),
          audio: false,
        });
        // 等待期間可能已 logout、鎖定原相、開始新一套、轉鏡或 unmount：
        // token 一對唔上即時熄新 stream，避免鏡頭 LED 留著。
        if (token !== cameraTokenRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (token !== cameraTokenRef.current) {
          for (const track of stream.getTracks()) track.stop();
          if (streamRef.current === stream) streamRef.current = null;
          return;
        }
        setCameraState('open');
      } catch (error) {
        // 舊一次開鏡嘅失敗唔好覆蓋新一次嘅狀態，亦唔好 stop 到別人嘅 stream。
        if (token !== cameraTokenRef.current) return;
        for (const track of streamRef.current?.getTracks() ?? []) track.stop();
        streamRef.current = null;
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setCameraState('denied');
          setCameraMessage('鏡頭權限未允許。你可以重新檢查權限，或不改設定直接用相簿揀相。');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setCameraState('error');
          setCameraMessage('搵唔到可用鏡頭，請試吓切換前後鏡，或改用相簿揀相。');
        } else {
          setCameraState('error');
          setCameraMessage('鏡頭暫時未能開啟，可能正被其他 App 使用；請稍後重試或用相簿揀相。');
        }
      }
    },
    [canEditRoot, facingMode],
  );

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setActionError('鏡頭畫面未準備好，請等一秒再影');
      return;
    }
    try {
      // 舊機可能仍然回傳橫向 sensor 串流；拍攝必須沿用即時預覽嘅 cover 裁切，
      // 唔可以預覽直向、輸出卻用返整條橫向片。尺寸每次按目前畫框計，旋轉後亦啱用。
      const frameWidth = video.clientWidth || video.videoWidth;
      const frameHeight = video.clientHeight || video.videoHeight;
      const crop = getTryOnCoverCrop(video.videoWidth, video.videoHeight, frameWidth, frameHeight);
      const scale = Math.min(1, 1600 / Math.max(crop.sourceWidth, crop.sourceHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(crop.sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(crop.sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('未能處理相片');
      context.drawImage(
        video,
        crop.sourceX,
        crop.sourceY,
        crop.sourceWidth,
        crop.sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (!blob) throw new Error('未能儲存拍攝相片');
      const dataUri = await blobToDataUri(blob);
      await validateImageDimensions(dataUri);
      setModelImage(dataUri);
      stopCamera();
      notify('全身相已準備好；請確認頭到腳都入鏡');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '拍攝失敗，請再試');
    }
  }, [notify, stopCamera]);

  const chooseUpload = () => {
    if (!canEditRoot || !access?.allowed) return;
    fileInputRef.current?.click();
  };

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setActionError(null);
    if (isHeic(file)) {
      setActionError('暫時唔支援 HEIC／HEIF；請喺相簿複製或輸出做 JPEG，再上傳。');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setActionError('請揀 JPEG、PNG 或 WebP 相片；其他格式暫不支援。');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setActionError('相片大過 10MB，請先縮細再試。');
      return;
    }
    setReadingPhoto(true);
    try {
      const dataUri = await blobToDataUri(file);
      await validateImageDimensions(dataUri);
      setModelImage(dataUri);
      stopCamera();
      notify('相片已準備好；請確認係清晰全身相');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '讀取相片失敗，請再試');
    } finally {
      setReadingPhoto(false);
    }
  };

  useEffect(() => {
    if (preselectedRef.current || !products.length) return;
    if (currentPublicId || !Number.isInteger(preselectProductId) || preselectProductId <= 0) {
      preselectedRef.current = true;
      return;
    }
    const product = products.find((item) => item.id === preselectProductId);
    preselectedRef.current = true;
    if (!product) {
      setActionError('呢件商品已下架或唔屬支援試穿嘅穿著部位，請揀另一件。');
      return;
    }
    const gallery = galleryOf(product);
    const photoIndex = Number.isInteger(preselectPhotoIndex) && preselectPhotoIndex >= 0
      ? Math.min(preselectPhotoIndex, gallery.length - 1)
      : 0;
    setSelections([{ productId: product.id, photoIndex }]);
  }, [currentPublicId, preselectPhotoIndex, preselectProductId, products]);

  const selectionLimit = canEditRoot ? 2 : 1;
  const selectedItems = selections.map((selection) => ({
    selection,
    product: products.find((product) => product.id === selection.productId) ?? null,
  }));
  const missingSelectedProduct = selectedItems.some((item) => !item.product);
  const selectedBlockReason = !canEditRoot && selectedItems[0]?.product
    ? lineageBlockReason(selectedItems[0].product, job)
    : null;
  // 只係未刪除嘅後續有效生成先阻止分叉；已 mediaDeleted 嘅後續 step 唔再阻追加。
  const hasLaterLineage = Boolean(
    job?.lookItems.some(
      (item) =>
        item.stepNumber > job.stepNumber && USAGE_STATUSES.has(item.status) && !isLookItemMediaDeleted(item),
    ),
  );
  const jobActive = Boolean(job && ACTIVE_STATUSES.has(job.status));

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('zh-HK');
    return products.filter((product) => {
      if (kindFilter !== 'all' && product.tryOnKind !== kindFilter) return false;
      if (!needle) return true;
      return `${product.name} ${product.sku}`.toLocaleLowerCase('zh-HK').includes(needle);
    });
  }, [kindFilter, products, search]);

  const generateFor = useCallback(
    async (product: TryOnProduct, productPhotoIndex: number, fixedIdempotencyKey?: string): Promise<TryOnJob | null> => {
      setActionError(null);
      if (!access?.allowed) {
        setActionError(access?.reason ?? '你而家未能使用 AI 試穿');
        return null;
      }
      if (!userId || createMutation.isPending || createInFlightRef.current) return null;
      const submittingUserId = userId;
      let payload:
        | { productId: number; photoIndex: number; idempotencyKey: string; modelImage: string }
        | { productId: number; photoIndex: number; idempotencyKey: string; sourcePublicId: string };
      // 操作意圖：root/source + product + photo + 原相意圖；用嚟綁定 idempotency key。
      let intent: string | null = null;
      let idempotencyKey: string | null = null;

      // 由第一個 await 之前已鎖住：失敗工作重試要讀原相，雙擊唔可以開兩條收費請求。
      createInFlightRef.current = true;
      try {
        if (job && ACTIVE_STATUSES.has(job.status)) {
          setActionError('呢件仲生成緊，請等完成或失敗後再提交，唔會自動連續收費。');
          return null;
        }
        const laterLineage =
          job?.lookItems.filter(
            (item) =>
              item.stepNumber > job.stepNumber && USAGE_STATUSES.has(item.status) && !isLookItemMediaDeleted(item),
          ) ?? [];
        if (job && laterLineage.length > 0) {
          setActionError('呢一步之後已經有生成，請喺造型紀錄揀返最新一步再追加。');
          return null;
        }
        const blockReason = lineageBlockReason(product, job);
        if (blockReason) {
          setActionError(`${blockReason}；兩件商品必須係不同穿著部位。`);
          return null;
        }

        if (!job || (job.status === 'failed' && job.stepNumber === 1)) {
          let sourceImage = modelImage;
          if (!sourceImage && job?.status === 'failed' && job.stepNumber === 1) {
            // 頁面可能已開超過 signed URL 時效；重試前先取新網址，唔用舊連結碰运气。
            const refreshed = await jobQuery.refetch();
            const refreshedJob = refreshed.data;
            const inputUrl = refreshedJob?.publicId === job.publicId && refreshedJob.status === 'failed'
              ? refreshedJob.inputUrl
              : job.inputUrl;
            if (inputUrl) sourceImage = await privateUrlToDataUri(inputUrl);
          }
          if (!sourceImage) {
            setActionError('請先影一張全身相，或由相簿上傳；相片要頭到腳清晰入鏡。');
            return null;
          }
          intent = `root|${product.id}|${productPhotoIndex}|${intentDigest(sourceImage)}`;
          payload = {
            productId: product.id,
            photoIndex: productPhotoIndex,
            idempotencyKey: '',
            modelImage: sourceImage,
          };
        } else if (job.status === 'completed' || job.status === 'failed') {
          if (job.status === 'completed' && job.stepNumber >= access.maxMixSteps) {
            setActionError(`每套造型最多 ${access.maxMixSteps} 件，請開始新一套。`);
            return null;
          }
          const sourcePublicId = job.status === 'completed' ? job.publicId : job.sourcePublicId;
          if (!sourcePublicId) {
            setActionError('搵唔到上一步成功結果，請由第一件衣服重新開始。');
            return null;
          }
          intent = `source|${sourcePublicId}|${product.id}|${productPhotoIndex}`;
          payload = {
            productId: product.id,
            photoIndex: productPhotoIndex,
            idempotencyKey: '',
            sourcePublicId,
          };
        } else {
          setActionError('目前狀態未能提交，請重新載入工作紀錄。');
          return null;
        }

        // 已授權第二件會帶固定 key；reload／回應遺失後仍由後台按 requestHash dedupe。
        idempotencyKey = fixedIdempotencyKey ?? (
          createIntentRef.current?.intent === intent ? createIntentRef.current.key : operationKey()
        );
        payload.idempotencyKey = idempotencyKey;

        // 預先記住 key：相同操作意圖嘅網絡重試會由後台 dedupe。
        createIntentRef.current = { intent, key: idempotencyKey };
        const created = await createMutation.mutateAsync(payload);
        createIntentRef.current = null;
        // 即時按提交帳號寫工作編號：就算回應前已 PUSH 離頁、logout 或換帳號，舊帳號下次仍可恢復。
        // publicId 會按 userId 分隔；getJob／私人 media 另有 owner 檢查，唔會向新帳號披露舊工作。
        window.sessionStorage.setItem(currentJobStorageKey(submittingUserId), created.publicId);
        // 已 logout／換帳號就唔將舊私人 job 寫入而家頁面 cache，只保留上述舊帳號恢復線索。
        if (userIdRef.current !== submittingUserId) return null;
        utils.tryon.getJob.setData({ publicId: created.publicId }, created);
        setCurrentPublicId(created.publicId);
        stopCamera();
        await utils.tryon.getMyAccess.invalidate();
        notify(`已提交第 ${created.stepNumber} 件商品；生成期間會預留 1 次額度`);
        return created;
      } catch (error) {
        if (userIdRef.current !== submittingUserId) return null;
        // 只有真正提交過嘅失敗先記住 key，等相同 payload 重試可以重用。
        if (!fixedIdempotencyKey && intent && idempotencyKey) createIntentRef.current = { intent, key: idempotencyKey };
        setActionError(error instanceof Error ? error.message : '提交失敗，請稍後再試');
        await utils.tryon.getMyAccess.invalidate();
        return null;
      } finally {
        createInFlightRef.current = false;
      }
    },
    [access, createMutation, job, jobQuery, modelImage, notify, setCurrentPublicId, stopCamera, userId, utils],
  );

  const retryFailed = async () => {
    if (!job || job.status !== 'failed') return;
    const product = products.find((item) => item.id === job.productId);
    if (!product) {
      if (batchPlan) applyBatchPlan(null);
      setActionError('商品已下架或而家唔合資格；未提交嘅後續計劃已停止，請揀另一件商品重新生成。');
      return;
    }
    const gallery = galleryOf(product);
    const index = gallery.indexOf(job.productImagePath);
    if (index < 0) {
      if (batchPlan) applyBatchPlan(null);
      setActionError('商品原圖已更新；未提交嘅第 2 件已取消，請重新選相並確認生成。');
      setSelections([{ productId: product.id, photoIndex: 0 }]);
      return;
    }
    const created = await generateFor(product, index);
    if (created && batchPlan && job.stepNumber === 1) {
      applyBatchPlan({ ...batchPlan, rootPublicId: created.publicId, paused: false });
    }
  };

  const resetLook = () => {
    if (createMutation.isPending || createInFlightRef.current || batchActionPending) return;
    stopCamera();
    // 明示開始新一套即係新操作意圖；即使揀返同一張相＋同一件，都唔應 dedupe 返舊造型。
    createIntentRef.current = null;
    autoBatchInFlightRef.current = null;
    if (userId) {
      window.sessionStorage.removeItem(currentJobStorageKey(userId));
      window.sessionStorage.removeItem(batchPlanStorageKey(userId));
    }
    setBatchPlanState(null);
    setSavedJobPublicId(null);
    setCurrentPublicId(null);
    setModelImage(null);
    setSelections([]);
    setActionError(null);
    setDeleteArmed(false);
  };

  const continueSavedLook = () => {
    if (!savedJobPublicId || createMutation.isPending) return;
    stopCamera();
    setSelections([]);
    setModelImage(null);
    setActionError(null);
    setCurrentPublicId(savedJobPublicId);
  };

  const deleteCurrentMedia = async () => {
    // 建立工作或更新已授權計劃途中唔准刪來源：否則第二件可能照扣額，或失敗後復活指向已刪 root 嘅計劃。
    if (
      !job?.canDelete ||
      deleteMutation.isPending ||
      createMutation.isPending ||
      createInFlightRef.current ||
      autoBatchInFlightRef.current ||
      batchActionPending
    ) return;
    setActionError(null);
    try {
      await deleteMutation.mutateAsync({ publicId: job.publicId });
      const parentId = job.sourcePublicId;
      applyBatchPlan(null);
      await utils.tryon.getJob.reset({ publicId: job.publicId });
      setCurrentPublicId(parentId);
      if (parentId) {
        await utils.tryon.getJob.invalidate({ publicId: parentId });
      } else {
        setModelImage(null);
        setSavedJobPublicId(null);
        if (userId) window.sessionStorage.removeItem(currentJobStorageKey(userId));
      }
      setDeleteArmed(false);
      notify(parentId ? '呢一步私人圖片已刪除，並返回上一步' : '呢次原相同結果已即時刪除');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '刪除失敗，請再試');
    }
  };

  const freshCompletedJob = async (): Promise<TryOnJob> => {
    if (!job) throw new Error('搵唔到試穿工作');
    const refreshed = await jobQuery.refetch();
    const latest = refreshed.data ?? job;
    if (latest.status !== 'completed' || !latest.outputUrl || latest.mediaDeleted) {
      throw new Error('結果圖已刪除、到期或暫時不可用');
    }
    return latest;
  };

  const outputBlob = async (target: TryOnJob): Promise<Blob> => {
    const response = await fetch(target.outputUrl!, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('下載結果圖失敗，請重新整理後再試');
    return response.blob();
  };

  const downloadResult = async () => {
    if (!job || busyAction) return;
    setBusyAction('download');
    setActionError(null);
    try {
      const latest = await freshCompletedJob();
      const blob = await outputBlob(latest);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `RedCode-AI試穿-${latest.productSku}-第${latest.stepNumber}件.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify('PNG 已開始下載');
      // 小精靈導覽：下載真係開始咗先記「已分享」（失敗會行 catch，唔會假進度）
      emitTryOnGuideAction('share');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '下載失敗，請再試');
    } finally {
      setBusyAction(null);
    }
  };

  const nativeShare = async () => {
    if (!job || busyAction) return;
    setBusyAction('share');
    setActionError(null);
    try {
      const latest = await freshCompletedJob();
      const productsToShare = shareProductsForJob(latest);
      if (!productsToShare.length) throw new Error('未有成功商品可以分享');
      const text = buildTryOnShareText(productsToShare, window.location.origin);
      const blob = await outputBlob(latest);
      const file = new File([blob], `RedCode-AI試穿-${latest.productSku}.png`, { type: 'image/png' });
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
        throw new Error('呢個裝置未能直接分享效果圖；請下載 PNG，再用 WhatsApp 文字分享後附加圖片');
      }
      await navigator.share({ title: 'RedCode AI 試穿預覽', text, files: [file] });
      notify('已分享 AI 試穿效果圖同商品資料');
      // 小精靈導覽：await share 成功先記；用戶取消（AbortError）／失敗會行 catch，唔記
      emitTryOnGuideAction('share');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setActionError(error instanceof Error ? error.message : '分享失敗，請再試');
    } finally {
      setBusyAction(null);
    }
  };

  const nativeShareAvailable = useMemo(supportsNativeFileShare, []);
  const whatsAppUrl = useMemo(() => {
    if (!job || job.status !== 'completed' || !job.outputUrl || job.mediaDeleted) return null;
    const productsToShare = shareProductsForJob(job);
    return productsToShare.length ? buildTryOnWhatsAppUrl(productsToShare, window.location.origin) : null;
  }, [job]);

  const creditsPerGeneration = access?.creditsPerGeneration ?? 3;
  const selectionCount = selections.length;
  const totalCredits = selectionCount * creditsPerGeneration;
  const selectionLocked = Boolean(batchPlan) || jobActive || createMutation.isPending;
  const quotaBlockReason = access && selectionCount > 0 && access.remainingToday < selectionCount
    ? `今日個人剩額只有 ${access.remainingToday} 次，唔足以確認 ${selectionCount} 次生成`
    : access && selectionCount > 0 && access.siteRemainingToday < selectionCount
      ? `全站今日剩額只有 ${access.siteRemainingToday} 次，唔足以確認 ${selectionCount} 次生成`
      : null;
  const submitBlockedReason = !access?.allowed
    ? access?.reason ?? '權限資料載入中'
    : batchPlan
      ? batchPlan.paused
        ? '已確認嘅第 2 件暫停提交；請先處理錯誤或明確繼續'
        : '已確認嘅兩件計劃正在順序處理'
      : jobActive
        ? '生成進行中'
        : hasLaterLineage
          ? '請揀最新一步'
          : !selectionCount
            ? '請先揀商品'
            : missingSelectedProduct
              ? '有商品已下架，請移除後重新選擇'
              : selectedBlockReason
                ? selectedBlockReason
                : !job && !modelImage
                  ? '請先準備全身相'
                  : job?.status === 'completed' && job.stepNumber >= access.maxMixSteps
                    ? `每套最多 ${access.maxMixSteps} 件`
                    : quotaBlockReason;
  const canSubmit = Boolean(
    access?.allowed && selectionCount && !createMutation.isPending && !submitBlockedReason,
  );

  const confirmGeneration = async () => {
    if (!canSubmit || !userId) return;
    const confirmed = selections.map((item) => ({ ...item }));
    const first = selectedItems[0];
    if (!first?.product) return;
    const created = await generateFor(first.product, first.selection.photoIndex);
    if (!created) return;
    const second = confirmed[1];
    if (confirmed.length === 2 && canEditRoot && created.stepNumber === 1 && second) {
      applyBatchPlan({
        version: 1,
        userId,
        rootPublicId: created.publicId,
        second,
        idempotencyKey: operationKey(),
        paused: false,
      });
      notify(`已確認兩件：第 1 件已提交；成功後先提交第 2 件，兩次合共 ${2 * creditsPerGeneration} credits`);
    } else {
      setSelections([]);
    }
  };

  useEffect(() => {
    const plan = batchPlan;
    if (
      !plan ||
      plan.paused ||
      !userId ||
      createMutation.isPending ||
      !job ||
      job.publicId !== plan.rootPublicId ||
      job.status !== 'completed' ||
      job.stepNumber !== 1 ||
      autoBatchInFlightRef.current === plan.idempotencyKey
    ) {
      return;
    }
    const product = products.find((item) => item.id === plan.second.productId);
    if (!product) {
      applyBatchPlan({ ...plan, paused: true });
      setActionError('第 2 件商品已下架或唔合資格，後續提交已暂停；已完成嘅第 1 件不受影響。');
      return;
    }
    if (!access?.allowed || access.remainingToday < 1 || access.siteRemainingToday < 1) {
      applyBatchPlan({ ...plan, paused: true });
      setActionError('第 2 件提交前額度已有變化，所以已暂停；請重新讀取額度後明確繼續。');
      return;
    }
    const submittingUserId = userId;
    autoBatchInFlightRef.current = plan.idempotencyKey;
    void generateFor(product, plan.second.photoIndex, plan.idempotencyKey)
      .then((created) => {
        if (userIdRef.current !== submittingUserId) return;
        const currentPlan = batchPlanRef.current;
        // 回應途中如計劃已被刪除、取消或換咗，唔可以用舊 closure 清新計劃或復活舊計劃。
        if (currentPlan?.idempotencyKey !== plan.idempotencyKey) return;
        if (created) {
          applyBatchPlan(null);
          setSelections([]);
          notify(`兩件已全部提交，各自獨立生成；合共 ${2 * creditsPerGeneration} credits`);
        } else {
          applyBatchPlan({ ...currentPlan, paused: true });
        }
      })
      .finally(() => {
        if (autoBatchInFlightRef.current === plan.idempotencyKey) autoBatchInFlightRef.current = null;
      });
  }, [access, applyBatchPlan, batchPlan, createMutation.isPending, creditsPerGeneration, generateFor, job, notify, products, userId]);

  const resumeBatch = async () => {
    const plan = batchPlan;
    if (!plan || batchActionPending || createMutation.isPending || autoBatchInFlightRef.current) return;
    setBatchActionPending(true);
    setActionError(null);
    try {
      // 暂停可能跨過額度重置或商品上下架；明確繼續時先刷新兩項，唔用舊 cache 即再暂停。
      await Promise.all([
        utils.tryon.getMyAccess.invalidate(),
        utils.tryon.listProducts.invalidate(),
      ]);
      if (userIdRef.current !== plan.userId) return;
      applyBatchPlan({ ...plan, paused: false });
    } catch {
      setActionError('未能更新額度或商品資料；第 2 件仍然暂停，請稍後再試。');
    } finally {
      setBatchActionPending(false);
    }
  };

  const cancelPendingSecond = () => {
    // create 已發出就唔可以假裝取消；等後台返回後會清楚顯示實際已提交状态。
    if (createMutation.isPending || autoBatchInFlightRef.current || batchActionPending) return;
    applyBatchPlan(null);
    setSelections([]);
    setActionError(null);
    notify('已取消未提交嘅第 2 件；已提交或已完成嘅工作不受影響');
  };

  const submitAction = job?.status === 'completed'
    ? '確認追加'
    : job?.status === 'failed'
      ? '確認重新提交'
      : selectionCount === 2
        ? '一次確認生成'
        : '確認生成';
  const submitLabel = selectionCount === 0
    ? '請先揀商品'
    : `${submitAction} ${selectionCount} 件（${selectionCount} 次生成 · 共 ${totalCredits} credits）`;

  const originalPreview = canEditRoot && modelImage
    ? modelImage
    : job?.lookOriginalUrl ?? (job?.stepNumber === 1 ? job.inputUrl : null) ?? modelImage;
  const isStaff = Boolean(user && user.role !== 'member');
  const flowStep = job ? 3 : originalPreview ? 2 : 1;
  const failureHelp = job?.status === 'failed' ? getFailureHelp(job.failureCode, isStaff) : null;

  return (
    <main className="tryon-page">
      <style>{TRYON_CSS}</style>
      <header className="tryon-hero">
        <div>
          <p className="tryon-kicker">REDCODE · AI FITTING STUDIO</p>
          <h1>你嘅全身相，<br /><span>襯返真商品。</span></h1>
          <p className="tryon-hero-copy">
            前鏡自拍、後鏡拍攝或相簿揀相都得。拍一張頭到腳清晰入鏡嘅全身相，揀商品後提交；
            系統會異步生成 AI 視覺預覽，唔係實時布料 AR，亦唔會為遷就衣服而改你嘅樣貌或身形。
          </p>
        </div>
        <div className="tryon-hero-side">
          <span className="tryon-status-pill">
            <span aria-hidden="true" />
            {!user
              ? '登入後查看開放資格'
              : isStaff
                ? '同事內測'
                : access?.memberEnabled
                  ? '會員已開放'
                  : access
                    ? '會員暫未開放'
                    : '確認開放資格中…'}
          </span>
          <ol className="tryon-step-list" aria-label="試穿流程">
            {[1, 2, 3].map((step) => (
              <li
                key={step}
                data-current={flowStep === step}
                data-complete={flowStep > step}
                aria-current={flowStep === step ? 'step' : undefined}
              >
                <b>{String(step).padStart(2, '0')}</b>
                <span>
                  {step === 1 ? '全身相' : step === 2 ? '真商品' : '對照分享'}
                  <small>{step === 1 ? '前／後鏡頭／相簿' : step === 2 ? '可即場揀齊兩件' : '24 小時私人保留'}</small>
                </span>
                <i aria-hidden="true">{flowStep > step ? <Check size={14} /> : null}</i>
              </li>
            ))}
          </ol>
        </div>
      </header>

      <div className="tryon-disclaimer" role="note">
        <AlertTriangle size={18} aria-hidden="true" />
        <p><strong>AI 試穿只係視覺預覽</strong>，唔代表實際尺碼、鬆緊、合身程度或舒適度；尺寸以商品尺寸表及實物為準。</p>
      </div>

      {authLoading ? (
        <section className="tryon-access-card" role="status">
          <LoaderCircle className="tryon-spin" size={24} aria-hidden="true" />
          <p>正在確認帳號…</p>
        </section>
      ) : !user ? (
        <section className="tryon-access-card">
          <LockKeyhole size={30} aria-hidden="true" />
          <p className="tryon-kicker">MEMBERS &amp; STAFF</p>
          <h2>先登入，先可以使用私人試穿工作枱</h2>
          <p>原相同結果不會放入公開商品圖庫；每位用戶只可以讀取自己嘅工作。</p>
          <Link to="/login" className="tryon-primary-link"><LogIn size={18} />登入／註冊</Link>
        </section>
      ) : (
        <>
          <section className="tryon-account-strip" aria-label="試穿額度及帳號狀態">
            <div>
              <p className="tryon-kicker">{isStaff ? 'STAFF PREVIEW' : 'MEMBER ACCESS'}</p>
              <h2>{user.name}，{access?.allowed ? '可以開始' : '暫時未能生成'}</h2>
            </div>
            {accessQuery.isLoading ? (
              <p className="tryon-quota"><LoaderCircle className="tryon-spin" size={18} />讀取額度中…</p>
            ) : accessQuery.isError ? (
              <button type="button" className="tryon-text-button" onClick={() => void accessQuery.refetch()}>
                <RefreshCcw size={16} />重新讀取權限
              </button>
            ) : access ? (
              <div className="tryon-quota-group">
                <p className="tryon-quota"><strong>{access.remainingToday}</strong><span>／ {access.dailyLimit} 次今日剩額</span></p>
                <p>已用 {access.usedToday} · 全站今日剩 {access.siteRemainingToday} · 每套最多 {access.maxMixSteps} 件</p>
              </div>
            ) : null}
          </section>

          {access?.reason && (
            <div className="tryon-inline-alert" role="alert">
              <AlertTriangle size={18} />
              <span>{access.reason}。你仍可以查看未刪除嘅現有結果；失敗生成唔扣個人每日額度。</span>
              <Link to="/faq">查看常見問題</Link>
            </div>
          )}
          {(actionError || jobQuery.isError || productsQuery.isError) && (
            <div className="tryon-inline-alert" role="alert">
              <AlertTriangle size={18} />
              <span>
                {actionError ??
                  (jobQuery.isError
                    ? '試穿工作暫時未能載入，請檢查網絡後重試。'
                    : '商品清單暫時未能載入，請稍後重試。')}
              </span>
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  if (jobQuery.isError) void jobQuery.refetch();
                  if (productsQuery.isError) void productsQuery.refetch();
                }}
              >重試</button>
            </div>
          )}

          {savedJobPublicId && !currentPublicId && (
            <section className="tryon-continue-look" aria-label="繼續舊造型">
              <div>
                <p className="tryon-kicker">NEW LOOK BY DEFAULT</p>
                <h2>而家係新一套，唔會自動追加舊造型</h2>
                <p>你可以重新影相及揀商品；如想查看或明確追加舊工作，先撳「繼續舊造型」。</p>
              </div>
              <button type="button" className="tryon-secondary-button" onClick={continueSavedLook}>
                <RotateCcw size={17} />繼續舊造型
              </button>
            </section>
          )}

          <div className="tryon-workbench">
            <section className="tryon-photo-panel" aria-labelledby="tryon-photo-title">
              <div className="tryon-panel-heading">
                <div><p className="tryon-kicker">01 · YOUR PHOTO</p><h2 id="tryon-photo-title">全身相</h2></div>
                {job && (
                  <button type="button" className="tryon-text-button" onClick={resetLook} disabled={createMutation.isPending}>
                    <RotateCcw size={16} />開始新一套
                  </button>
                )}
              </div>

              <div className="tryon-photo-stage">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  aria-label="鏡頭即時畫面"
                  className={cameraState === 'open' ? 'tryon-live-video' : 'tryon-hidden-video'}
                />
                {cameraState !== 'open' && originalPreview ? (
                  <img
                    src={originalPreview}
                    alt="你準備用嚟試穿嘅全身相"
                    className="tryon-photo-preview"
                    onError={(event) => {
                      // 本地 data URI 唔會過期；只有私人 signed URL 先需要 refetch。
                      if (!event.currentTarget.src.startsWith('data:')) refreshSignedImageUrls();
                    }}
                  />
                ) : cameraState !== 'open' ? (
                  <div className="tryon-photo-placeholder">
                    <ScanLine size={46} strokeWidth={1.2} aria-hidden="true" />
                    <h3>頭到腳，企直少少</h3>
                    <div className="tryon-photo-tips" aria-label="拍攝貼士">
                      <span><Check size={14} />全身入鏡</span>
                      <span><Check size={14} />光線平均</span>
                      <span><Check size={14} />冇遮擋</span>
                    </div>
                    <p>前鏡、後鏡或相簿相片都得，唔使專業打燈。生成前會做簡單人像及極暗檢查；需要換相時，未送 AI 生成，亦未預留或扣除 credits。</p>
                  </div>
                ) : null}
                {cameraState === 'opening' && <span className="tryon-stage-badge"><LoaderCircle className="tryon-spin" size={15} />開緊鏡頭…</span>}
                {readingPhoto && <span className="tryon-stage-badge"><LoaderCircle className="tryon-spin" size={15} />讀取相片…</span>}
              </div>

              {canEditRoot ? (
                <div className="tryon-camera-controls" data-fairy-target="photo">
                  {cameraState === 'open' ? (
                    <>
                      <button type="button" className="tryon-primary-button" onClick={() => void capturePhoto()}>
                        <Camera size={18} />拍攝全身相
                      </button>
                      <button
                        type="button"
                        className="tryon-secondary-button"
                        onClick={() => {
                          const next = facingMode === 'environment' ? 'user' : 'environment';
                          setFacingMode(next);
                          void startCamera(next);
                        }}
                      ><SwitchCamera size={18} />切換{facingMode === 'environment' ? '前鏡' : '後鏡'}</button>
                      <button type="button" className="tryon-text-button" onClick={stopCamera}><X size={16} />關閉鏡頭</button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="tryon-primary-button"
                        onClick={() => {
                          setFacingMode('user');
                          void startCamera('user');
                        }}
                        disabled={!access?.allowed || cameraState === 'opening' || readingPhoto}
                      >
                        <Camera size={18} />{cameraState === 'denied' || cameraState === 'error' ? '重新檢查鏡頭權限' : '前鏡自拍全身相'}
                      </button>
                      <button
                        type="button"
                        className="tryon-secondary-button"
                        onClick={() => {
                          setFacingMode('environment');
                          void startCamera('environment');
                        }}
                        disabled={!access?.allowed || cameraState === 'opening' || readingPhoto}
                      >
                        <Camera size={18} />後鏡拍攝
                      </button>
                      <button type="button" className="tryon-secondary-button" onClick={chooseUpload} disabled={!access?.allowed || readingPhoto}>
                        <ImagePlus size={18} />用相簿揀相
                      </button>
                      {modelImage && (
                        <button type="button" className="tryon-text-button" onClick={() => setModelImage(null)}><Trash2 size={16} />移除相片</button>
                      )}
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.heic,.heif"
                    className="tryon-file-input"
                    onChange={(event) => void onUpload(event)}
                    aria-label="由相簿選擇全身相"
                  />
                </div>
              ) : (
                <p className="tryon-panel-note"><LockKeyhole size={15} />呢套造型嘅原始相片已鎖定；追加商品只會用上一步成功結果。</p>
              )}

              {canEditRoot && cameraState !== 'open' && (
                <p className="tryon-camera-hint"><Sparkles size={15} />唔使急，影完會先見到預覽；唔啱可以移除再影，未按「確認生成」唔會用額度。</p>
              )}
              {cameraMessage && <p className="tryon-camera-message" role="alert">{cameraMessage} 網頁不能直接開系統設定；如需改權限，請自行到瀏覽器網站設定或系統設定允許。</p>}
              <p className="tryon-panel-note"><LockKeyhole size={15} />私人原相及結果預設保留 24 小時；唔會公開喺商品圖庫，亦可以喺結果區即時刪除。</p>
            </section>

            <section className="tryon-product-panel" aria-labelledby="tryon-product-title">
              <div className="tryon-panel-heading">
                <div><p className="tryon-kicker">02 · REAL PRODUCTS</p><h2 id="tryon-product-title">揀一件或兩件，一次確認</h2></div>
                <span className="tryon-count">{products.length} 件合資格</span>
              </div>
              <p className="tryon-product-intro">第一次生成前可即場揀齊兩件不同穿著部位，各自揀商品相片及調換次序。兩件仍係兩次生成、各用 1 次額度及 {creditsPerGeneration} credits；只揀一件就只做一次。每套最多 {access?.maxMixSteps ?? 3} 件，未確認唔會自動追加。</p>

              <label className="tryon-search">
                <Search size={18} aria-hidden="true" />
                <span className="tryon-sr-only">搜尋商品名或貨號</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋品名／貨號" />
                {search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜尋"><X size={16} /></button>}
              </label>
              <div className="tryon-kind-filters" aria-label="穿著部位篩選">
                <button type="button" data-active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>全部</button>
                {TRYON_PRODUCT_KINDS.map((kind) => (
                  <button key={kind} type="button" data-active={kindFilter === kind} onClick={() => setKindFilter(kind)}>
                    {tryOnProductKindLabel(kind)}
                  </button>
                ))}
              </div>

              {productsQuery.isLoading ? (
                <div className="tryon-empty-products"><LoaderCircle className="tryon-spin" size={24} /><p>整理商品原圖中…</p></div>
              ) : filteredProducts.length ? (
                <div className="tryon-contact-sheet" data-fairy-target="product">
                  {filteredProducts.map((product) => {
                    const blockReason = lineageBlockReason(product, job);
                    const selectedIndex = selections.findIndex((item) => item.productId === product.id);
                    const selected = selectedIndex >= 0;
                    const gallery = galleryOf(product);
                    return (
                      <button
                        type="button"
                        key={product.id}
                        className="tryon-product-card"
                        data-selected={selected}
                        disabled={Boolean(blockReason) || selectionLocked || hasLaterLineage}
                        onClick={() => {
                          const result = addTryOnProductSelection({
                            selections,
                            products,
                            product,
                            kindLabel: kindLabel(product.tryOnKind),
                            maxSelections: selectionLimit,
                          });
                          setSelections(result.selections);
                          setActionError(result.ok ? null : result.reason);
                        }}
                        aria-pressed={selected}
                      >
                        <span className="tryon-product-image-wrap">
                          <img src={gallery[0]} alt={product.name} loading="lazy" />
                          <span>{kindLabel(product.tryOnKind)}</span>
                          {selected && <i aria-label={`第 ${selectedIndex + 1} 次生成`}>{selectedIndex + 1}</i>}
                        </span>
                        <strong>{product.name}</strong>
                        <small>{product.sku}</small>
                        <span className="tryon-product-price">{money(product.discountPrice ?? product.price)}</span>
                        {blockReason && <em>{blockReason}</em>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="tryon-empty-products"><Shirt size={32} /><p>{products.length ? '搵唔到符合篩選嘅商品' : '暫時冇合資格商品；生活用品、護膚品及不明飾品唔會出現喺度。'}</p></div>
              )}

              {selectedItems.length > 0 && (
                <div className="tryon-selection-list" aria-label="已確認前嘅商品及生成次序">
                  {selectedItems.map(({ selection, product }, index) => {
                    if (!product) return null;
                    const gallery = galleryOf(product);
                    return (
                      <div className="tryon-selected-product" key={product.id}>
                        <div className="tryon-selected-heading">
                          <div>
                            <p className="tryon-kicker">第 {index + 1} 次生成 · {kindLabel(product.tryOnKind)}</p>
                            <h3>{product.name}</h3>
                            <p>{product.sku} · {money(product.discountPrice ?? product.price)} · {creditsPerGeneration} credits</p>
                          </div>
                          <button
                            type="button"
                            disabled={selectionLocked}
                            onClick={() => setSelections(selections.filter((item) => item.productId !== product.id))}
                            aria-label={`移除第 ${index + 1} 件 ${product.name}`}
                          ><X size={18} /></button>
                        </div>
                        {gallery.length > 1 && (
                          <div className="tryon-photo-picker" aria-label={`選擇 ${product.name} 商品原圖`}>
                            {gallery.map((src, photoIndex) => (
                              <button
                                type="button"
                                key={`${src}-${photoIndex}`}
                                data-active={selection.photoIndex === photoIndex}
                                disabled={selectionLocked}
                                onClick={() => setSelections(selections.map((item) => item.productId === product.id ? { ...item, photoIndex } : item))}
                                aria-label={`${product.name} 用第 ${photoIndex + 1} 張商品原圖`}
                                aria-pressed={selection.photoIndex === photoIndex}
                              ><img src={src} alt="" /></button>
                            ))}
                          </div>
                        )}
                        {selectedItems.length === 2 && (
                          <div className="tryon-order-controls">
                            <button type="button" disabled={selectionLocked || index === 0} onClick={() => setSelections(moveTryOnProductSelection(selections, index, -1))}>前移</button>
                            <span>第 {index + 1} 次生成</span>
                            <button type="button" disabled={selectionLocked || index === selectedItems.length - 1} onClick={() => setSelections(moveTryOnProductSelection(selections, index, 1))}>後移</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <p className="tryon-selection-total">共 {selectionCount} 次生成 · 每次 {creditsPerGeneration} credits · 合共 {totalCredits} credits</p>
                </div>
              )}

              {batchPlan && (
                <div className="tryon-batch-plan" role="status">
                  <div>
                    <p className="tryon-kicker">AUTHORIZED TWO-STEP PLAN</p>
                    <strong>第 2 件已喺第一次確認時授權，但只會喺第 1 件成功後提交</strong>
                    <p>{batchPlan.paused ? '目前暂停，唔會自動提交。' : '計劃生效中；每次仍係獨立生成及獨立額度。'}</p>
                  </div>
                  <div className="tryon-batch-actions">
                    {batchPlan.paused && job?.publicId === batchPlan.rootPublicId && job.status === 'completed' && (
                      <button type="button" className="tryon-primary-button" onClick={() => void resumeBatch()} disabled={batchActionPending || createMutation.isPending}>
                        {batchActionPending ? '更新額度及商品中…' : '繼續已確認第 2 件'}
                      </button>
                    )}
                    <button type="button" className="tryon-text-button" onClick={cancelPendingSecond} disabled={batchActionPending || createMutation.isPending}>取消未提交第 2 件</button>
                  </div>
                </div>
              )}

              <div className="tryon-submit-zone">
                <button
                  type="button"
                  className="tryon-generate-button"
                  data-fairy-target="generate"
                  disabled={!canSubmit}
                  onClick={() => void confirmGeneration()}
                >
                  {createMutation.isPending ? <LoaderCircle className="tryon-spin" size={19} /> : <Sparkles size={19} />}
                  {createMutation.isPending ? '正在建立工作…' : submitLabel}
                </button>
                <p>每件各用 1 次額度；兩件會順序生成，唔係兩件合併成一次供應商生成。</p>
                {submitBlockedReason && <p role="status">{submitBlockedReason}</p>}
              </div>
            </section>
          </div>

          {job && (
            <section className="tryon-result-section" aria-labelledby="tryon-result-title">
              <div className="tryon-result-heading">
                <div><p className="tryon-kicker">03 · REVIEW &amp; SHARE</p><h2 id="tryon-result-title">造型對照</h2></div>
                <span className="tryon-job-status" data-status={job.status}><span />{statusLabel(job.status)} · 第 {job.stepNumber} 件</span>
              </div>

              <div className="tryon-look-line" aria-label="呢套造型嘅每一步">
                {job.lookItems.map((item: LookItem) => (
                  <button
                    type="button"
                    key={item.publicId}
                    data-active={item.publicId === job.publicId}
                    data-status={item.status}
                    onClick={() => {
                      if (batchPlan && item.publicId !== batchPlan.rootPublicId) {
                        applyBatchPlan({ ...batchPlan, paused: true });
                      }
                      setCurrentPublicId(item.publicId);
                    }}
                  >
                    <span>{String(item.stepNumber).padStart(2, '0')}</span>
                    <strong>{item.productName}</strong>
                    <small>{kindLabel(item.tryOnKind)} · {statusLabel(item.status)}</small>
                  </button>
                ))}
              </div>

              {jobActive && (
                <div className="tryon-progress" role="status" aria-live="polite">
                  <div className="tryon-progress-mark" aria-hidden="true">
                    <div className="tryon-generation-bars">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
                  </div>
                  <div>
                    <p className="tryon-kicker">ASYNC GENERATION</p>
                    <h3>{job.status === 'queued' ? '已收到工作，正在排隊' : 'AI 正在生成穿著效果'}</h3>
                    <p>畫面會自動更新，唔使一直開住鏡頭。冇可靠百分比，所以動畫只代表仍在處理，唔會假裝顯示完成進度；同一分頁重新整理亦會用工作編號恢復。</p>
                    <small>本次預留 {job.credits} credits · {batchPlan ? '第 2 件已獲確認，只會喺呢件成功後提交' : '唔會自動生成下一件'}</small>
                  </div>
                </div>
              )}

              {job.status === 'failed' && (
                <div className="tryon-failed" role="alert" data-code={job.failureCode ?? undefined}>
                  <AlertTriangle size={28} />
                  <div className="tryon-failed-copy">
                    <h3>今次未完成</h3>
                    {failureHelp && <strong className="tryon-failure-lead">{failureHelp.title}</strong>}
                    <p>{failureHelp?.detail ?? job.failureMessage ?? '供應商暫時未能生成，請稍後重試。'}</p>
                    {job.failureCode && (
                      <details className="tryon-tech-details">
                        <summary>技術紀錄</summary>
                        <code>{job.failureCode}</code>
                      </details>
                    )}
                    <p className="tryon-failed-note">失敗生成唔扣個人每日額度；如供應商結果不確定，估算成本會保留待核實，唔會當成免費。</p>
                  </div>
                  <button type="button" className="tryon-primary-button" onClick={() => void retryFailed()} disabled={createMutation.isPending}>
                    <RefreshCcw size={17} />{job.failureCode === 'PROVIDER_AUTH' ? '設定修正後重試' : '重試呢件'}
                  </button>
                </div>
              )}

              {job.status === 'completed' && (
                <>
                  <div className="tryon-comparison tryon-source-comparison" aria-label="最初原相及商品原圖對照">
                    <figure>
                      <div>{job.lookOriginalUrl ? <img src={job.lookOriginalUrl} alt="最初全身原相" onError={refreshSignedImageUrls} /> : <span>原相已刪除或到期</span>}</div>
                      <figcaption><b>01</b>最初原相<small>只作私人對照</small></figcaption>
                    </figure>
                    <figure>
                      <div><img src={job.productImagePath} alt={`${job.productName} 商品原圖`} /></div>
                      <figcaption><b>02</b>商品原圖<small>{job.productName} · {job.productSku}</small></figcaption>
                    </figure>
                  </div>

                  <figure className="tryon-result-figure" aria-label="獨立 AI 試穿成果">
                    <div className="tryon-result-frame">
                      {job.outputUrl && !job.mediaDeleted ? (
                        <>
                          <img src={job.outputUrl} alt={`${job.productName} AI 試穿視覺預覽，右上角有 RedCode 水印`} onError={refreshSignedImageUrls} />
                          <i className="tryon-result-spark tryon-result-spark-one" aria-hidden="true" />
                          <i className="tryon-result-spark tryon-result-spark-two" aria-hidden="true" />
                        </>
                      ) : <span>結果已刪除或到期</span>}
                    </div>
                    <figcaption>
                      <b>03</b>
                      <span>AI 試穿預覽<small>第 {job.stepNumber} 件 · 生成時商品快照 · 右上角 RedCode 透明水印</small></span>
                      <strong>YOUR REDCODE LOOK</strong>
                    </figcaption>
                  </figure>

                  <div className="tryon-result-meta">
                    <div><Clock3 size={17} /><p>私人圖片保留至 <strong>{expiryLabel(job.expiresAt)}</strong>（香港時間），逾期或即時刪除後唔可以再下載。</p></div>
                    <div><Shirt size={17} /><p>今次商品：<strong>{job.productName}</strong> · {job.productSku} · {money(job.productDiscountPrice ?? job.productPrice)}（生成時快照）</p></div>
                  </div>

                  <TryOnPurchase key={`${job.lookId}:${job.stepNumber}`} job={job} />

                  <div className="tryon-share-box">
                    <div><p className="tryon-kicker">DOWNLOAD &amp; SHARE</p><h3>帶走效果，講清楚係 AI 試穿</h3><p>頁面、下載 PNG 及支援嘅 Web Share 圖片都帶右上角 RedCode 透明水印。分享文案會列晒成功加入嘅商品：品名、貨號、生成時價錢及公開商品網址；兩件就兩組，三件就三組。</p></div>
                    <div className="tryon-share-actions" data-fairy-target="share">
                      <button type="button" className="tryon-secondary-button" onClick={() => void downloadResult()} disabled={!job.outputUrl || job.mediaDeleted || busyAction !== null}>
                        {busyAction === 'download' ? <LoaderCircle className="tryon-spin" size={18} /> : <Download size={18} />}下載 PNG
                      </button>
                      {nativeShareAvailable ? (
                        <button type="button" className="tryon-primary-button" onClick={() => void nativeShare()} disabled={!job.outputUrl || job.mediaDeleted || busyAction !== null}>
                          {busyAction === 'share' ? <LoaderCircle className="tryon-spin" size={18} /> : <Share2 size={18} />}分享效果圖＋商品資料
                        </button>
                      ) : whatsAppUrl ? (
                        <a
                          className="tryon-primary-button"
                          href={whatsAppUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => emitTryOnGuideAction('share')}
                        ><MessageCircle size={18} />WhatsApp 分享商品資料</a>
                      ) : null}
                      {nativeShareAvailable && whatsAppUrl && (
                        <a
                          className="tryon-text-button"
                          href={whatsAppUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => emitTryOnGuideAction('share')}
                        ><MessageCircle size={16} />只用 WhatsApp 文字</a>
                      )}
                    </div>
                    <p className="tryon-share-note">Web Share 支援時會分享 PNG＋文字；WhatsApp／wa.me 只帶公開商品資料及網址，<strong>唔會自動附加私人結果圖</strong>。你可以先下載 PNG，再喺 WhatsApp 自行附加。私人 signed URL 不會寫入分享文案。</p>
                  </div>
                </>
              )}

              {job.status === 'failed' && (
                <TryOnPurchase key={`${job.lookId}:${job.stepNumber}:failed`} job={job} />
              )}

              <div className="tryon-delete-zone">
                <p><Images size={16} />要刪除較早步驟，可先喺上面造型紀錄揀返嗰一步。呢度只刪目前步驟，唔會假稱成套已刪。</p>
                {job.canDelete && !deleteArmed && <button type="button" className="tryon-text-button" onClick={() => setDeleteArmed(true)} disabled={deleteMutation.isPending || createMutation.isPending || batchActionPending}><Trash2 size={16} />即時刪除呢步私人圖片</button>}
                {deleteArmed && (
                  <div className="tryon-delete-confirm" role="alert">
                    <span>確定刪除第 {job.stepNumber} 步嘅輸入及結果？呢個動作不能復原。</span>
                    <button type="button" onClick={() => void deleteCurrentMedia()} disabled={deleteMutation.isPending || createMutation.isPending || batchActionPending}>{deleteMutation.isPending ? '刪除中…' : createMutation.isPending || batchActionPending ? '工作建立中…' : '確認刪除'}</button>
                    <button type="button" onClick={() => setDeleteArmed(false)}>取消</button>
                  </div>
                )}
              </div>
            </section>
          )}

          <footer className="tryon-footer-note">
            <p><strong>商品同人樣都唔係可以妥協嘅位。</strong>固定高質模式，商品原圖係唯一衣服依據；生成式 AI 仍有可能出錯，未通過真人＋真商品驗收前，會員開關及品質批准必須保持關閉。</p>
            <Link to="/faq">試穿、PWA 安裝及鏡頭權限教學 →</Link>
          </footer>
        </>
      )}

      {notice && <div className="tryon-toast" role="status"><Check size={17} />{notice}</div>}
    </main>
  );
}

const TRYON_CSS = /* css */ `
  .tryon-page {
    --studio-paper: #FFF7E8;
    --studio-ink: #0A0614;
    --studio-muted: #5A5180;
    --studio-line: rgba(10, 6, 20, .16);
    --studio-pink: #D60047;
    --studio-gold: #f5c036;
    min-height: 100vh;
    min-height: 100dvh;
    padding: 72px clamp(18px, 4vw, 56px) 96px;
    background: var(--studio-paper);
    color: var(--studio-ink);
    color-scheme: light;
    font-family: 'Noto Sans TC', -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
  }
  .tryon-page *, .tryon-page *::before, .tryon-page *::after { box-sizing: border-box; }
  .tryon-page button, .tryon-page input { font: inherit; }
  .tryon-page button, .tryon-page a { -webkit-tap-highlight-color: transparent; }
  .tryon-page button:focus-visible, .tryon-page a:focus-visible, .tryon-page input:focus-visible { outline: 2px solid var(--studio-pink); outline-offset: 3px; }
  .tryon-page button:disabled { cursor: not-allowed; opacity: .46; }
  .tryon-kicker { margin: 0; font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 11px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; color: var(--studio-muted); }
  .tryon-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .tryon-hero { max-width: 1380px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .55fr); gap: clamp(40px, 7vw, 112px); align-items: end; }
  .tryon-hero h1 { margin: 22px 0 0; max-width: 850px; font-family: 'Noto Serif TC', serif; font-size: clamp(44px, 6.4vw, 90px); font-weight: 700; line-height: 1.12; letter-spacing: -.045em; }
  .tryon-hero h1 span { color: var(--studio-pink); }
  .tryon-hero-copy { max-width: 690px; margin: 28px 0 0; color: var(--studio-muted); font-size: 15px; line-height: 1.9; }
  .tryon-hero-side { border-top: 1px solid var(--studio-ink); padding-top: 18px; }
  .tryon-status-pill { display: inline-flex; align-items: center; gap: 9px; min-height: 34px; font-size: 12px; font-weight: 700; letter-spacing: .06em; }
  .tryon-status-pill > span { width: 8px; height: 8px; border-radius: 50%; background: var(--studio-pink); }
  .tryon-step-list { list-style: none; padding: 0; margin: 24px 0 0; }
  .tryon-step-list li { display: flex; gap: 18px; align-items: baseline; padding: 15px 0; border-top: 1px solid var(--studio-line); }
  .tryon-step-list b { font-family: 'DM Mono', monospace; font-size: 12px; color: var(--studio-pink); }
  .tryon-step-list span { font-family: 'Noto Serif TC', serif; font-size: 18px; font-weight: 700; }
  .tryon-step-list small { display: block; margin-top: 2px; font-family: 'Noto Sans TC', sans-serif; font-size: 12px; font-weight: 400; color: var(--studio-muted); }
  .tryon-disclaimer { max-width: 1380px; margin: 42px auto 0; display: flex; gap: 12px; align-items: flex-start; padding: 16px 0; border-top: 1px solid var(--studio-line); border-bottom: 1px solid var(--studio-line); color: var(--studio-muted); }
  .tryon-disclaimer svg { flex: 0 0 auto; color: var(--studio-pink); margin-top: 3px; }
  .tryon-disclaimer p { margin: 0; font-size: 14px; line-height: 1.8; }
  .tryon-disclaimer strong { color: var(--studio-ink); }
  .tryon-access-card { max-width: 760px; margin: 64px auto 0; padding: clamp(28px, 5vw, 56px); border: 1px solid var(--studio-line); text-align: center; }
  .tryon-access-card > svg { color: var(--studio-pink); margin-bottom: 16px; }
  .tryon-access-card h2 { margin: 12px 0; font-family: 'Noto Serif TC', serif; font-size: clamp(24px, 4vw, 36px); line-height: 1.35; }
  .tryon-access-card > p:not(.tryon-kicker) { color: var(--studio-muted); line-height: 1.8; }
  .tryon-primary-link { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; margin-top: 18px; padding: 0 24px; background: var(--studio-ink); color: var(--studio-paper); text-decoration: none; font-weight: 700; }
  .tryon-account-strip { max-width: 1380px; margin: 38px auto 0; display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
  .tryon-account-strip h2 { margin: 6px 0 0; font-family: 'Noto Serif TC', serif; font-size: 26px; }
  .tryon-continue-look { max-width: 1380px; margin: 24px auto 0; padding: 22px 0; display: flex; align-items: center; justify-content: space-between; gap: 24px; border-top: 1px solid var(--studio-ink); border-bottom: 1px solid var(--studio-line); }
  .tryon-continue-look h2 { margin: 6px 0; font-family: 'Noto Serif TC', serif; font-size: 22px; }
  .tryon-continue-look p:not(.tryon-kicker) { margin: 0; color: var(--studio-muted); font-size: 13px; line-height: 1.75; }
  .tryon-continue-look > button { flex: 0 0 auto; }
  .tryon-quota-group { text-align: right; }
  .tryon-quota-group > p:last-child { margin: 2px 0 0; color: var(--studio-muted); font-size: 12px; }
  .tryon-quota { margin: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .tryon-quota strong { font-family: 'DM Mono', monospace; font-size: 32px; line-height: 1; color: var(--studio-pink); }
  .tryon-quota span { font-size: 12px; color: var(--studio-muted); }
  .tryon-inline-alert { max-width: 1380px; margin: 20px auto 0; display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px; border: 1px solid rgba(255,0,84,.32); color: var(--studio-ink); font-size: 13px; line-height: 1.7; }
  .tryon-inline-alert > svg { flex: 0 0 auto; margin-top: 2px; color: var(--studio-pink); }
  .tryon-inline-alert span { flex: 1; }
  .tryon-inline-alert a, .tryon-inline-alert button { flex: 0 0 auto; min-height: 32px; border: 0; background: none; color: var(--studio-pink); font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .tryon-workbench { max-width: 1380px; margin: 30px auto 0; display: grid; grid-template-columns: minmax(0, .88fr) minmax(430px, 1.12fr); border-top: 1px solid var(--studio-ink); border-bottom: 1px solid var(--studio-ink); }
  .tryon-photo-panel { padding: 28px clamp(0px, 2.4vw, 36px) 32px 0; border-right: 1px solid var(--studio-line); }
  .tryon-product-panel { min-width: 0; padding: 28px 0 32px clamp(0px, 2.4vw, 36px); }
  .tryon-panel-heading { min-height: 54px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .tryon-panel-heading h2, .tryon-result-heading h2 { margin: 5px 0 0; font-family: 'Noto Serif TC', serif; font-size: 26px; line-height: 1.3; }
  .tryon-text-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 0; border: 0; background: none; color: var(--studio-ink); font-size: 13px; font-weight: 700; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
  .tryon-photo-stage { position: relative; margin-top: 20px; aspect-ratio: 4 / 5; overflow: hidden; background: #0A0614; }
  .tryon-photo-preview, .tryon-live-video { display: block; width: 100%; height: 100%; }
  .tryon-photo-preview { object-fit: contain; }
  .tryon-live-video { object-fit: cover; object-position: center; }
  .tryon-hidden-video { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .tryon-photo-placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 30px; background: var(--studio-paper); border: 1px solid var(--studio-line); text-align: center; }
  .tryon-photo-placeholder svg { color: var(--studio-pink); }
  .tryon-photo-placeholder h3 { margin: 18px 0 8px; font-family: 'Noto Serif TC', serif; font-size: 25px; }
  .tryon-photo-placeholder p { max-width: 390px; margin: 0; color: var(--studio-muted); font-size: 14px; line-height: 1.8; }
  .tryon-stage-badge { position: absolute; left: 14px; bottom: 14px; display: inline-flex; align-items: center; gap: 7px; padding: 8px 11px; background: var(--studio-paper); color: var(--studio-ink); font-size: 12px; }
  .tryon-camera-controls { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
  .tryon-primary-button, .tryon-secondary-button, .tryon-generate-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px; padding: 0 18px; border: 1px solid var(--studio-ink); border-radius: 0; font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer; }
  .tryon-primary-button { background: var(--studio-ink); color: var(--studio-paper); }
  .tryon-secondary-button { background: transparent; color: var(--studio-ink); }
  .tryon-file-input { display: none; }
  .tryon-panel-note { display: flex; gap: 7px; align-items: flex-start; margin: 16px 0 0; color: var(--studio-muted); font-size: 12px; line-height: 1.7; }
  .tryon-panel-note svg { flex: 0 0 auto; margin-top: 2px; }
  .tryon-camera-message { margin: 14px 0 0; padding-left: 12px; border-left: 2px solid var(--studio-pink); color: var(--studio-muted); font-size: 12px; line-height: 1.75; }
  .tryon-count { flex: 0 0 auto; font-family: 'DM Mono', 'Noto Sans TC', monospace; color: var(--studio-muted); font-size: 11px; }
  .tryon-product-intro { margin: 12px 0 18px; max-width: 690px; color: var(--studio-muted); font-size: 14px; line-height: 1.75; }
  .tryon-search { display: flex; align-items: center; gap: 9px; min-height: 46px; border-bottom: 1px solid var(--studio-ink); }
  .tryon-search input { min-width: 0; flex: 1; height: 44px; border: 0; background: transparent; color: var(--studio-ink); outline: 0; }
  .tryon-search input::placeholder { color: var(--studio-muted); }
  .tryon-search button { width: 44px; height: 44px; display: grid; place-items: center; border: 0; background: none; color: var(--studio-ink); cursor: pointer; }
  .tryon-kind-filters { display: flex; gap: 6px; overflow-x: auto; padding: 12px 0 10px; scrollbar-width: thin; }
  .tryon-kind-filters button { flex: 0 0 auto; min-height: 36px; padding: 0 11px; border: 1px solid var(--studio-line); background: transparent; color: var(--studio-muted); font-size: 11px; cursor: pointer; }
  .tryon-kind-filters button[data-active='true'] { border-color: var(--studio-ink); background: var(--studio-ink); color: var(--studio-paper); }
  .tryon-contact-sheet { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 12px; max-height: 660px; overflow-y: auto; padding: 4px 4px 4px 0; }
  .tryon-product-card { min-width: 0; padding: 0 0 10px; border: 0; border-bottom: 1px solid var(--studio-line); background: transparent; color: var(--studio-ink); text-align: left; cursor: pointer; }
  .tryon-product-card[data-selected='true'] { border-bottom-color: var(--studio-pink); }
  .tryon-product-image-wrap { position: relative; display: block; aspect-ratio: 4 / 5; overflow: hidden; background: rgba(10,6,20,.06); }
  .tryon-product-image-wrap > img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tryon-product-image-wrap > span { position: absolute; left: 7px; top: 7px; padding: 3px 6px; background: var(--studio-paper); color: var(--studio-ink); font-size: 10px; }
  .tryon-product-image-wrap > i { position: absolute; right: 7px; top: 7px; width: 25px; height: 25px; display: grid; place-items: center; background: var(--studio-pink); color: var(--studio-paper); border-radius: 50%; font-family: 'DM Mono', monospace; font-size: 12px; font-style: normal; font-weight: 700; }
  .tryon-product-card > strong { display: -webkit-box; margin-top: 9px; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 14px; line-height: 1.5; }
  .tryon-product-card > small { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--studio-muted); font-family: 'DM Mono', monospace; font-size: 10px; }
  .tryon-product-price { display: block; margin-top: 4px; color: var(--studio-pink); font-family: 'DM Mono', monospace; font-size: 13px; }
  .tryon-product-card > em { display: block; margin-top: 4px; color: var(--studio-muted); font-size: 10px; font-style: normal; }
  .tryon-empty-products { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--studio-muted); text-align: center; }
  .tryon-empty-products p { max-width: 420px; margin: 0; font-size: 13px; line-height: 1.8; }
  .tryon-selection-list { margin-top: 20px; border-top: 1px solid var(--studio-ink); }
  .tryon-selected-product { margin: 0; padding: 16px 0; border-bottom: 1px solid var(--studio-line); }
  .tryon-selection-total { margin: 0; padding: 13px 0; color: var(--studio-ink); font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 12px; line-height: 1.7; }
  .tryon-selected-heading { display: flex; justify-content: space-between; gap: 16px; }
  .tryon-selected-heading h3 { margin: 5px 0 0; font-family: 'Noto Serif TC', serif; font-size: 19px; }
  .tryon-selected-heading p:not(.tryon-kicker) { margin: 4px 0 0; color: var(--studio-muted); font-size: 12px; }
  .tryon-selected-heading > button { flex: 0 0 auto; width: 44px; height: 44px; display: grid; place-items: center; border: 0; background: none; color: var(--studio-ink); cursor: pointer; }
  .tryon-photo-picker { display: flex; gap: 8px; margin-top: 12px; overflow-x: auto; }
  .tryon-photo-picker button { flex: 0 0 auto; width: 54px; height: 64px; padding: 0; border: 1px solid var(--studio-line); background: none; cursor: pointer; }
  .tryon-photo-picker button[data-active='true'] { border: 2px solid var(--studio-pink); }
  .tryon-photo-picker img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tryon-order-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
  .tryon-order-controls button { min-width: 64px; min-height: 44px; border: 1px solid var(--studio-line); background: transparent; color: var(--studio-ink); cursor: pointer; }
  .tryon-order-controls span { color: var(--studio-muted); font-size: 11px; }
  .tryon-batch-plan { margin-top: 20px; padding: 18px 0; display: flex; align-items: center; justify-content: space-between; gap: 20px; border-top: 1px solid var(--studio-gold); border-bottom: 1px solid var(--studio-gold); background: rgba(245, 192, 54, .07); }
  .tryon-batch-plan strong { display: block; margin-top: 6px; font-size: 13px; line-height: 1.65; }
  .tryon-batch-plan p:not(.tryon-kicker) { margin: 4px 0 0; color: var(--studio-muted); font-size: 12px; }
  .tryon-batch-actions { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .tryon-submit-zone { margin-top: 18px; }
  .tryon-generate-button { width: 100%; min-height: 52px; border-color: var(--studio-pink); background: var(--studio-pink); color: var(--studio-paper); font-size: 14px; }
  .tryon-submit-zone > p { margin: 8px 0 0; color: var(--studio-muted); font-size: 11px; text-align: center; }
  .tryon-result-section { max-width: 1380px; margin: 72px auto 0; padding-top: 28px; border-top: 1px solid var(--studio-ink); }
  .tryon-result-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
  .tryon-job-status { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; font-size: 12px; font-weight: 700; }
  .tryon-job-status > span { width: 8px; height: 8px; border-radius: 50%; background: var(--studio-muted); }
  .tryon-job-status[data-status='completed'] > span { background: var(--studio-pink); }
  .tryon-look-line { display: flex; gap: 0; margin-top: 24px; overflow-x: auto; border-top: 1px solid var(--studio-line); border-bottom: 1px solid var(--studio-line); }
  .tryon-look-line button { min-width: 210px; flex: 1; min-height: 88px; display: grid; grid-template-columns: 30px 1fr; grid-template-rows: auto auto; column-gap: 10px; padding: 16px; border: 0; border-right: 1px solid var(--studio-line); background: transparent; color: var(--studio-ink); text-align: left; cursor: pointer; }
  .tryon-look-line button[data-active='true'] { background: rgba(255,0,84,.06); }
  .tryon-look-line button > span { grid-row: 1 / 3; font-family: 'DM Mono', monospace; font-size: 12px; color: var(--studio-pink); }
  .tryon-look-line button > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .tryon-look-line button > small { color: var(--studio-muted); font-size: 10px; }
  .tryon-progress, .tryon-failed { margin-top: 28px; display: flex; align-items: center; gap: 24px; padding: clamp(24px, 4vw, 44px); border: 1px solid var(--studio-line); }
  .tryon-progress-mark { width: 68px; height: 68px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid var(--studio-pink); border-radius: 50%; color: var(--studio-pink); }
  .tryon-progress h3, .tryon-failed h3 { margin: 7px 0; font-family: 'Noto Serif TC', serif; font-size: 25px; }
  .tryon-progress p:not(.tryon-kicker), .tryon-failed p { margin: 6px 0; color: var(--studio-muted); font-size: 13px; line-height: 1.8; }
  .tryon-progress small, .tryon-failed small { color: var(--studio-muted); font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 11px; }
  .tryon-failed { align-items: flex-start; border-color: rgba(255,0,84,.35); }
  .tryon-failed > svg { flex: 0 0 auto; color: var(--studio-pink); }
  .tryon-failed > div { flex: 1; }
  .tryon-failed > button { flex: 0 0 auto; }
  .tryon-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; max-width: 920px; margin-top: 30px; }
  .tryon-comparison figure { min-width: 0; margin: 0; }
  .tryon-comparison figure > div { aspect-ratio: 3 / 4; display: grid; place-items: center; overflow: hidden; background: rgba(10,6,20,.06); }
  .tryon-comparison figure > div > span { padding: 20px; color: var(--studio-muted); font-size: 13px; text-align: center; }
  .tryon-comparison img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .tryon-comparison figcaption { display: grid; grid-template-columns: 30px 1fr; padding: 13px 0; border-bottom: 1px solid var(--studio-line); font-size: 13px; font-weight: 700; }
  .tryon-comparison figcaption b { grid-row: 1 / 3; font-family: 'DM Mono', monospace; color: var(--studio-pink); font-size: 11px; }
  .tryon-comparison figcaption small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--studio-muted); font-size: 10px; font-weight: 400; }
  .tryon-result-figure { min-width: 0; margin: 44px 0 0; }
  .tryon-result-frame { position: relative; isolation: isolate; height: min(82vh, 900px); min-height: 540px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--studio-gold); background: var(--studio-ink); box-shadow: 0 0 0 1px rgba(245,192,54,.16), 0 0 34px rgba(245,192,54,.22), 0 22px 60px rgba(10,6,20,.13); }
  .tryon-result-frame::before { content: ''; position: absolute; inset: 0; z-index: 2; pointer-events: none; background: linear-gradient(108deg, transparent 34%, rgba(245,192,54,.03) 43%, rgba(255,247,232,.2) 50%, rgba(245,192,54,.03) 57%, transparent 66%); background-size: 260% 100%; animation: tryon-gold-sheen 8s linear infinite; }
  .tryon-result-frame > img { position: relative; z-index: 1; display: block; width: 100%; height: 100%; object-fit: contain; }
  .tryon-result-frame > span { padding: 24px; color: var(--studio-paper); font-size: 13px; }
  .tryon-result-spark { position: absolute; z-index: 3; width: 13px; height: 13px; background: var(--studio-gold); clip-path: polygon(50% 0, 60% 40%, 100% 50%, 60% 60%, 50% 100%, 40% 60%, 0 50%, 40% 40%); opacity: 0; animation: tryon-gold-spark 5.4s ease-in-out infinite; pointer-events: none; }
  .tryon-result-spark-one { left: 7%; top: 9%; }
  .tryon-result-spark-two { right: 8%; bottom: 12%; width: 9px; height: 9px; animation-delay: -2.7s; }
  .tryon-result-figure figcaption { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 17px 0; border-bottom: 1px solid rgba(245,192,54,.65); font-size: 15px; font-weight: 700; }
  .tryon-result-figure figcaption > b { font-family: 'DM Mono', monospace; color: var(--studio-pink); font-size: 11px; }
  .tryon-result-figure figcaption small { display: block; margin-top: 3px; color: var(--studio-muted); font-size: 11px; font-weight: 400; line-height: 1.6; }
  .tryon-result-figure figcaption > strong { color: var(--studio-muted); font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: .14em; font-weight: 500; }
  @keyframes tryon-gold-sheen { from { background-position: 130% 0; } to { background-position: -130% 0; } }
  @keyframes tryon-gold-spark { 0%, 72%, 100% { opacity: 0; transform: scale(.65); } 80% { opacity: .9; transform: scale(1); } 88% { opacity: .18; transform: scale(.8); } }
  .tryon-result-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 18px 0; border-bottom: 1px solid var(--studio-line); }
  .tryon-result-meta > div { display: flex; gap: 9px; align-items: flex-start; }
  .tryon-result-meta svg { flex: 0 0 auto; margin-top: 2px; color: var(--studio-pink); }
  .tryon-result-meta p { margin: 0; color: var(--studio-muted); font-size: 12px; line-height: 1.7; }
  .tryon-result-meta strong { color: var(--studio-ink); }
  .tryon-share-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px 50px; align-items: center; padding: 28px 0; border-bottom: 1px solid var(--studio-ink); }
  .tryon-share-box h3 { margin: 6px 0; font-family: 'Noto Serif TC', serif; font-size: 24px; }
  .tryon-share-box > div:first-child > p:not(.tryon-kicker) { max-width: 680px; margin: 0; color: var(--studio-muted); font-size: 14px; line-height: 1.75; }
  .tryon-share-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
  .tryon-share-note { grid-column: 1 / -1; margin: 0; color: var(--studio-muted); font-size: 12px; line-height: 1.8; }
  .tryon-share-note strong { color: var(--studio-ink); }
  .tryon-delete-zone { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding-top: 16px; }
  .tryon-delete-zone > p { display: flex; gap: 8px; align-items: flex-start; max-width: 680px; margin: 0; color: var(--studio-muted); font-size: 12px; line-height: 1.7; }
  .tryon-delete-zone > p svg { flex: 0 0 auto; }
  .tryon-delete-confirm { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; max-width: 560px; color: var(--studio-pink); font-size: 12px; }
  .tryon-delete-confirm span { flex: 1 1 100%; text-align: right; }
  .tryon-delete-confirm button { min-height: 44px; padding: 0 14px; border: 1px solid var(--studio-pink); background: transparent; color: var(--studio-pink); cursor: pointer; }
  .tryon-delete-confirm button:first-of-type { background: var(--studio-pink); color: var(--studio-paper); }
  .tryon-footer-note { max-width: 1380px; margin: 54px auto 0; display: flex; justify-content: space-between; gap: 30px; padding-top: 18px; border-top: 1px solid var(--studio-line); }
  .tryon-footer-note p { max-width: 820px; margin: 0; color: var(--studio-muted); font-size: 12px; line-height: 1.8; }
  .tryon-footer-note strong { color: var(--studio-ink); }
  .tryon-footer-note a { flex: 0 0 auto; color: var(--studio-pink); font-size: 12px; font-weight: 700; text-underline-offset: 4px; }
  .tryon-toast { position: fixed; left: 50%; bottom: max(24px, env(safe-area-inset-bottom)); z-index: 80; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); display: flex; align-items: center; gap: 8px; padding: 13px 18px; background: var(--studio-ink); color: var(--studio-paper); font-size: 13px; box-shadow: 0 12px 36px rgba(10,6,20,.18); }
  .tryon-spin { animation: tryon-spin 1s linear infinite; }
  @keyframes tryon-spin { to { transform: rotate(360deg); } }
  /* 2026-10-25 friendly workflow：動態只表達目前步驟、選擇及真實處理狀態。 */
  .tryon-page { --studio-soft: rgba(255, 0, 84, .055); --studio-shadow: 0 18px 48px rgba(10, 6, 20, .09); }
  .tryon-hero-copy { font-size: 16px; line-height: 1.8; }
  .tryon-step-list li { position: relative; padding-right: 34px; border-radius: 10px; transition: background-color .2s ease-out, color .2s ease-out; }
  .tryon-step-list li[data-current='true'] { padding-left: 12px; background: var(--studio-soft); }
  .tryon-step-list li[data-complete='true'] b { color: var(--studio-ink); }
  .tryon-step-list li > i { position: absolute; top: 16px; right: 10px; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; background: var(--studio-ink); color: var(--studio-paper); opacity: 0; transform: scale(.85); transition: transform .18s ease-out, opacity .18s ease-out; }
  .tryon-step-list li[data-complete='true'] > i { opacity: 1; transform: scale(1); }
  .tryon-account-strip { padding: 18px 20px; border-radius: 16px; background: var(--studio-soft); }
  .tryon-photo-stage { border-radius: 20px; box-shadow: var(--studio-shadow); }
  .tryon-photo-placeholder { border: 0; }
  .tryon-photo-tips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 14px; margin: 2px 0 16px; color: var(--studio-ink); font-size: 13px; font-weight: 700; }
  .tryon-photo-tips span { display: inline-flex; align-items: center; gap: 4px; }
  .tryon-photo-tips svg { color: var(--studio-pink); }
  .tryon-camera-hint { display: flex; align-items: flex-start; gap: 7px; margin: 12px 0 0; color: var(--studio-muted); font-size: 13px; line-height: 1.7; }
  .tryon-camera-hint svg { flex: 0 0 auto; margin-top: 3px; color: var(--studio-pink); }
  .tryon-primary-button, .tryon-secondary-button, .tryon-generate-button, .tryon-primary-link { border-radius: 12px; transition: transform .18s ease-out, background-color .18s ease-out, color .18s ease-out, border-color .18s ease-out; }
  .tryon-primary-button:hover:not(:disabled), .tryon-secondary-button:hover:not(:disabled), .tryon-generate-button:hover:not(:disabled), .tryon-primary-link:hover { transform: translateY(-2px); }
  .tryon-primary-button:active:not(:disabled), .tryon-secondary-button:active:not(:disabled), .tryon-generate-button:active:not(:disabled), .tryon-primary-link:active { transform: translateY(0); }
  .tryon-kind-filters button { min-height: 44px; padding-inline: 14px; border-radius: 999px; font-size: 12px; transition: background-color .18s ease-out, color .18s ease-out, border-color .18s ease-out; }
  .tryon-product-image-wrap { border-radius: 12px; }
  .tryon-product-card { transition: border-color .18s ease-out; }
  .tryon-product-card[data-selected='true'] .tryon-product-image-wrap { outline: 2px solid var(--studio-pink); outline-offset: 3px; }
  .tryon-product-image-wrap > i { transition: transform .18s ease-out; }
  .tryon-generate-button { min-height: 56px; font-size: 15px; box-shadow: 0 10px 24px rgba(255, 0, 84, .14); }
  .tryon-progress, .tryon-failed { border-radius: 18px; }
  .tryon-progress { background: var(--studio-soft); }
  .tryon-progress-mark { width: 76px; height: 76px; border: 0; border-radius: 20px; background: var(--studio-paper); box-shadow: 0 8px 24px rgba(10, 6, 20, .07); }
  .tryon-generation-bars { height: 36px; display: flex; align-items: center; justify-content: center; gap: 4px; }
  .tryon-generation-bars i { display: block; width: 3px; height: 32px; border-radius: 1.5px; background: var(--studio-pink); opacity: .4; transform: scaleY(.25); animation: tryon-generation-bar .72s ease-in-out infinite alternate; }
  .tryon-generation-bars i:nth-child(1), .tryon-generation-bars i:nth-child(7) { animation-duration: .5s; animation-delay: -.28s; }
  .tryon-generation-bars i:nth-child(2), .tryon-generation-bars i:nth-child(6) { animation-duration: .65s; animation-delay: -.16s; }
  .tryon-generation-bars i:nth-child(3), .tryon-generation-bars i:nth-child(5) { animation-duration: .8s; animation-delay: -.36s; }
  .tryon-generation-bars i:nth-child(4) { animation-duration: .9s; animation-delay: -.1s; }
  .tryon-progress p:not(.tryon-kicker), .tryon-failed p { font-size: 16px; line-height: 1.75; }
  .tryon-failure-lead { display: block; margin: 8px 0 4px; color: var(--studio-ink); font-size: 16px; line-height: 1.65; }
  .tryon-tech-details { width: fit-content; margin: 10px 0; color: var(--studio-muted); font-size: 12px; }
  .tryon-tech-details summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  .tryon-tech-details code { display: block; padding: 8px 10px; border-radius: 8px; background: rgba(10, 6, 20, .06); color: var(--studio-ink); }
  .tryon-failed .tryon-failed-note { margin-top: 12px; font-size: 12px; }
  .tryon-swipe-hint { display: none; }
  .tryon-delete-zone > .tryon-text-button { flex: 0 0 auto; max-width: 100%; white-space: nowrap; }
  .tryon-toast { border-radius: 12px; animation: tryon-toast-in .2s ease-out; }
  @keyframes tryon-generation-bar { from { opacity: .35; transform: scaleY(.25); } to { opacity: 1; transform: scaleY(1); } }
  @keyframes tryon-toast-in { from { opacity: 0; transform: translate(-50%, 8px) scale(.95); } to { opacity: 1; transform: translate(-50%, 0) scale(1); } }
  /* ===== 2026-10-26 華麗動態美化（presentation only）=====
     規矩：持續動畫只用 transform／opacity／background-position（GPU compositor 友好），
     唔郁 layout、唔改任何互動邏輯；overflow-x: clip 保證 375/390 都冇橫向 overflow；
     全部動效喺檔尾 prefers-reduced-motion 一律停用。 */
  .tryon-page { overflow-x: clip; }
  @keyframes tryon-rise-in { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: translateY(0); } }
  .tryon-hero > div, .tryon-disclaimer, .tryon-account-strip, .tryon-continue-look, .tryon-workbench, .tryon-result-section { animation: tryon-rise-in .7s cubic-bezier(.16,.8,.3,1) both; }
  .tryon-hero-side { animation-delay: .12s; }
  .tryon-disclaimer { animation-delay: .2s; }
  .tryon-workbench, .tryon-result-section { animation-delay: .1s; }
  /* Hero 標題粉紅字：金粉漸變流光（background-position 動畫，唔觸發 layout） */
  .tryon-hero h1 span {
    background: linear-gradient(92deg, var(--studio-pink) 15%, var(--studio-gold) 50%, var(--studio-pink) 85%);
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: tryon-title-sheen 7s linear infinite;
  }
  @keyframes tryon-title-sheen { from { background-position: 0% 0; } to { background-position: 220% 0; } }
  /* 開放資格膠囊：呼吸點 */
  .tryon-status-pill > span { animation: tryon-dot-pulse 2.2s ease-in-out infinite; }
  @keyframes tryon-dot-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: .55; } }
  /* 步驟列表：而家嗰步左邊金粉呼吸線 */
  .tryon-step-list li[data-current='true']::before {
    content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 2px;
    background: linear-gradient(180deg, var(--studio-gold), var(--studio-pink));
    animation: tryon-step-glow 2.4s ease-in-out infinite;
  }
  @keyframes tryon-step-glow { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
  /* 未影相嘅 placeholder：柔和掃描光帶由上落（call 返個 ScanLine 圖示） */
  .tryon-photo-placeholder > * { position: relative; z-index: 1; }
  .tryon-photo-placeholder::after {
    content: ''; position: absolute; left: 0; right: 0; top: 0; height: 22%;
    background: linear-gradient(180deg, transparent, rgba(214, 0, 71, .07) 45%, rgba(245, 192, 54, .14));
    transform: translateY(-110%);
    animation: tryon-scan-sweep 3.8s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes tryon-scan-sweep {
    0% { transform: translateY(-110%); opacity: 0; }
    15% { opacity: 1; }
    70% { opacity: 1; }
    100% { transform: translateY(560%); opacity: 0; }
  }
  /* 商品卡：hover 浮起＋相片緩慢放大（transform only；disabled 唔郁） */
  .tryon-product-card { transition: transform .22s cubic-bezier(.2,.7,.3,1), border-color .18s ease-out; }
  .tryon-product-card:hover:not(:disabled) { transform: translateY(-4px); }
  .tryon-product-image-wrap > img { transition: transform .6s cubic-bezier(.16,.8,.3,1); }
  .tryon-product-card:hover:not(:disabled) .tryon-product-image-wrap > img { transform: scale(1.06); }
  .tryon-product-card[data-selected='true'] .tryon-product-image-wrap { animation: tryon-selected-pop .3s cubic-bezier(.2,.7,.3,1); }
  @keyframes tryon-selected-pop { 0% { transform: scale(.96); } 60% { transform: scale(1.02); } 100% { transform: scale(1); } }
  /* 生成主掣：流光掃過（disabled 即停，唔會誤導以為撳得） */
  .tryon-generate-button { position: relative; overflow: hidden; }
  .tryon-generate-button::after {
    content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 38%;
    background: linear-gradient(100deg, transparent, rgba(255, 247, 232, .5), transparent);
    transform: translateX(-160%) skewX(-12deg);
    animation: tryon-cta-sheen 3.2s ease-in-out infinite;
    pointer-events: none;
  }
  .tryon-generate-button:disabled::after { animation: none; opacity: 0; }
  @keyframes tryon-cta-sheen {
    0%, 55% { transform: translateX(-160%) skewX(-12deg); }
    85%, 100% { transform: translateX(320%) skewX(-12deg); }
  }
  /* 生成中標記：輕輕浮動（同入面嘅節奏 bar 一齊表達「真・處理中」） */
  .tryon-progress-mark { animation: tryon-mark-float 3s ease-in-out infinite; }
  @keyframes tryon-mark-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  /* 已揀商品行＋批核計劃條：入場浮上 */
  .tryon-selected-product, .tryon-batch-plan { animation: tryon-rise-in .45s cubic-bezier(.16,.8,.3,1) both; }
  /* 造型紀錄步驟切換：背景淡入淡出 */
  .tryon-look-line button { transition: background-color .2s ease-out; }
  @media (max-width: 1100px) {
    .tryon-workbench { grid-template-columns: 1fr; }
    .tryon-photo-panel { padding: 28px 0 32px; border-right: 0; border-bottom: 1px solid var(--studio-ink); }
    .tryon-product-panel { padding: 28px 0 32px; }
    .tryon-photo-stage { max-height: 760px; }
    .tryon-contact-sheet { grid-template-columns: repeat(4, minmax(0, 1fr)); max-height: 620px; }
  }
  @media (max-width: 820px) {
    .tryon-page { padding-top: 46px; }
    .tryon-hero { grid-template-columns: 1fr; gap: 34px; }
    .tryon-hero h1 { font-size: clamp(42px, 10vw, 68px); }
    .tryon-hero-side { max-width: 560px; }
    .tryon-step-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .tryon-step-list li { display: block; }
    .tryon-step-list small { min-height: 34px; }
    .tryon-comparison { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; overflow: visible; padding: 4px 0 0; }
    .tryon-comparison figure > div { aspect-ratio: 4 / 5; border-radius: 14px; }
    .tryon-result-figure { margin-top: 34px; }
    .tryon-result-frame { height: auto; min-height: 0; aspect-ratio: 4 / 5; }
    .tryon-result-figure figcaption { grid-template-columns: 28px minmax(0, 1fr); }
    .tryon-result-figure figcaption > strong { display: none; }
    .tryon-continue-look, .tryon-batch-plan { align-items: flex-start; flex-direction: column; }
    .tryon-batch-actions { align-items: flex-start; }
    .tryon-result-meta { grid-template-columns: 1fr; gap: 10px; }
    .tryon-delete-zone { flex-direction: column; }
    .tryon-delete-zone > .tryon-text-button { align-self: flex-start; white-space: normal; text-align: left; }
    .tryon-failed { flex-direction: column; }
    .tryon-failed > button { width: 100%; }
    .tryon-share-box { grid-template-columns: 1fr; gap: 18px; }
    .tryon-share-actions { justify-content: flex-start; }
    .tryon-footer-note { flex-direction: column; }
    .tryon-contact-sheet { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 560px) {
    .tryon-page { padding: 34px 16px 72px; }
    .tryon-hero h1 { font-size: 43px; letter-spacing: -.04em; }
    .tryon-hero-copy { margin-top: 20px; font-size: 16px; }
    .tryon-step-list { gap: 6px; }
    .tryon-step-list li { padding: 12px 26px 8px 4px; }
    .tryon-step-list li[data-current='true'] { padding-left: 8px; }
    .tryon-step-list span { font-size: 14px; }
    .tryon-step-list small { font-size: 11px; }
    .tryon-disclaimer { margin-top: 28px; }
    .tryon-account-strip { align-items: flex-start; flex-direction: column; padding: 16px; }
    .tryon-account-strip h2 { font-size: 23px; }
    .tryon-quota-group { text-align: left; }
    .tryon-quota { justify-content: flex-start; }
    .tryon-inline-alert { flex-wrap: wrap; }
    .tryon-panel-heading h2, .tryon-result-heading h2 { font-size: 23px; }
    .tryon-photo-stage { aspect-ratio: 3 / 4; }
    .tryon-camera-controls > button { flex: 1 1 calc(50% - 8px); padding: 0 12px; }
    .tryon-camera-controls > .tryon-primary-button { flex-basis: 100%; }
    .tryon-camera-controls > .tryon-text-button { flex: 0 0 auto; }
    .tryon-contact-sheet { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 590px; }
    .tryon-product-card > strong { font-size: 14px; }
    .tryon-result-section { margin-top: 48px; }
    .tryon-result-frame { aspect-ratio: 3 / 4; }
    .tryon-continue-look > button, .tryon-batch-actions, .tryon-batch-actions > button { width: 100%; }
    .tryon-result-heading { flex-direction: column; gap: 8px; }
    .tryon-progress, .tryon-failed { flex-direction: column; align-items: flex-start; padding: 22px; }
    .tryon-progress-mark { width: 54px; height: 54px; }
    .tryon-failed > button { width: 100%; }
    .tryon-share-actions { flex-direction: column; }
    .tryon-share-actions > * { width: 100%; }
    .tryon-delete-zone { flex-direction: column; }
    .tryon-delete-confirm { justify-content: flex-start; }
    .tryon-delete-confirm span { text-align: left; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tryon-spin, .tryon-generation-bars i, .tryon-toast, .tryon-result-frame::before, .tryon-result-spark { animation: none; }
    .tryon-result-frame::before { display: none; }
    .tryon-result-spark { opacity: .55; transform: none; }
    .tryon-generation-bars i { opacity: .75; transform: scaleY(.7); }
    .tryon-page * { scroll-behavior: auto !important; transition: none !important; }
    /* 2026-10-26 華麗動效一齊降級：入場/流光/掃描/浮動全停，靜態畫面完整可讀 */
    .tryon-hero > div, .tryon-disclaimer, .tryon-account-strip, .tryon-continue-look,
    .tryon-workbench, .tryon-result-section, .tryon-selected-product, .tryon-batch-plan,
    .tryon-hero h1 span, .tryon-status-pill > span, .tryon-step-list li[data-current='true']::before,
    .tryon-progress-mark, .tryon-product-card[data-selected='true'] .tryon-product-image-wrap { animation: none !important; }
    .tryon-generate-button::after, .tryon-photo-placeholder::after { display: none; }
    .tryon-hero h1 span { background: none; color: var(--studio-pink); }
  }
`;
