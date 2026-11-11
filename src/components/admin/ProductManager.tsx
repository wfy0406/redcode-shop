import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Ban, Pencil, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { getToken } from '@/lib/auth';
import { PRODUCT_CATEGORIES, productCategoryLabel } from '@contracts/types';
import { parseAiTagsJson } from '@/components/shop/shop-utils';
import { fmtDate, fmtHKD } from './format';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 商品管理 —— products.adminList（包括下架貨，dim 顯示）/ create / update / remove
 * 編輯模式：撳行內「編輯」→ populate 表單 → submit 分流 products.update；
 * 編輯中表單標題轉「編輯商品」+ 出「取消編輯」掣。
 * 定時自動下架：開關 + datetime-local；到時前台自動消失（server 查詢時判斷，唔使 cron）。
 * 📺 直播場次商品（2026-09-29 F8）：開關 + 直播日期（date→YYYYMMDD）+ 場次（≥1）；
 * 開咗商品歸入該場直播（前台 /products?liveDate=…&liveSession=… 篩到），閂咗 payload 畀 null 清走。
 */

const inputCls =
  'h-12 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

const initialForm = {
  name: '',
  sku: '',
  price: '',
  discountPrice: '',
  category: 'other',
  listedDate: new Date().toISOString().slice(0, 10),
  image: '/product-1.jpg',
  stock: '0',
  sizes: '',
  note: '',
  description: '',
};

/** products.adminList 未 merge 前嘅本地型別（同 products 表 $inferSelect 一致） */
type ProductRow = {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  image: string;
  photos: string[] | null;
  price: number;
  discountPrice: number | null;
  sizes: string | null;
  sizeEnabled: boolean;
  delistEnabled: boolean;
  delistAt: Date | null;
  liveDate: string | null; // F8：直播日期 YYYYMMDD；null＝普通商品
  liveSession: string | null; // F8：場次 '1','2'…（一定要配 liveDate，唔會單獨存在）
  note: string | null;
  category: string;
  listedDate: Date;
  stock: number;
  isActive: boolean;
  createdAt: Date;
  /** 重點標籤原始 JSON 字串（adminList 合約：string|null；壞資料用 parseAiTagsJson 擋） */
  aiTags: string | null;
  /** 重點標籤啟用狀態（adminList 合約：boolean）：false＝已停用（原始標籤照舊保留，唔會回返去公開 API） */
  aiTagsEnabled: boolean;
};

/** 後端新合約 products.disableAiTags（supervisor/admin only，員工 server 會 FORBIDDEN）。
 *  AppRouter 型別未更新前用結構型別接住；前端隱藏按鈕只係 UX，唔係保安防線。 */
type DisableAiTagsApi = {
  useMutation: (opts?: {
    onSuccess?: (result: unknown, vars: { ids: number[] }) => void;
    onError?: (err: { message?: string }) => void;
  }) => {
    mutate: (
      vars: { ids: number[] },
      opts?: {
        onSuccess?: (result: unknown, vars: { ids: number[] }) => void;
        onError?: (err: { message?: string }) => void;
      },
    ) => void;
    mutateAsync: (vars: { ids: number[] }) => Promise<unknown>;
    isPending: boolean;
  };
};

/** 後端 products.disableAiTags 每 call 最多 100 ids（zod max(100)）；批量 UI 按呢個上限 chunk */
export const AI_TAGS_DISABLE_CHUNK_SIZE = 100;

/** 將已揀 id 切成 ≤100 嘅 chunk（保持原有順序；空陣列 → 空） */
export function chunkAiDisableIds(ids: number[], size = AI_TAGS_DISABLE_CHUNK_SIZE): number[][] {
  const cap = Math.max(1, Math.floor(size));
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += cap) chunks.push(ids.slice(i, i + cap));
  return chunks;
}

/** 批量停用逐 chunk 順序執行嘅如實結果（部份失敗唔會報全成功） */
export interface AiTagsDisableRunResult {
  /** server 實際更新行數總和（逐 chunk count 相加） */
  updatedCount: number;
  /** 成功 chunk 嘅 ids（UI 淨係清呢啲選擇） */
  succeededIds: number[];
  /** 失敗 chunk 嘅 ids（保留選擇等主管重試） */
  failedIds: number[];
  firstError: string | null;
}

/**
 * L3：逐 100 ids chunk、順序 mutateAsync。其中一 chunk 失敗唔會中斷後面嘅 chunk，
 * 亦唔會當全成功——逐 chunk 記低成敗，由 UI 如實報總數。
 */
export async function runAiTagsDisableInChunks(
  ids: number[],
  mutateAsync: (vars: { ids: number[] }) => Promise<unknown>,
): Promise<AiTagsDisableRunResult> {
  const result: AiTagsDisableRunResult = {
    updatedCount: 0,
    succeededIds: [],
    failedIds: [],
    firstError: null,
  };
  for (const chunk of chunkAiDisableIds(ids)) {
    try {
      const res = await mutateAsync({ ids: chunk });
      result.updatedCount += (res as { count?: number } | null)?.count ?? chunk.length;
      result.succeededIds.push(...chunk);
    } catch (e) {
      result.failedIds.push(...chunk);
      if (!result.firstError) {
        result.firstError = (e as { message?: string })?.message || '未知錯誤';
      }
    }
  }
  return result;
}

/** Date（superjson 已還原）→ datetime-local 欄位格式（本地時間 YYYY-MM-DDTHH:mm） */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 列表 chip 用：M月D日 HH:mm */
function fmtDelist(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** F8 直播日期 chip 用：YYYYMMDD → M月D日 */
function fmtLiveDate(yyyymmdd: string): string {
  const m = Number.parseInt(yyyymmdd.slice(4, 6), 10);
  const d = Number.parseInt(yyyymmdd.slice(6, 8), 10);
  return `${m}月${d}日`;
}

/** F8 直播日期：DB 嘅 YYYYMMDD → date input 嘅 YYYY-MM-DD */
function liveDateToInput(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 上載日期 key（本地日曆日 YYYY-MM-DD）：每日新增款式分組＋篩選用 */
function dayKeyOf(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 排列選項（2026-08-04 Glo 要求）：上載日期／名稱／上架日期／分類 */
const SORT_OPTIONS = [
  { key: 'created', label: '上載日期' },
  { key: 'name', label: '名稱' },
  { key: 'listed', label: '上架日期' },
  { key: 'category', label: '分類' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['key'];

export default function ProductManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  // 重點標籤停用控制只畀 supervisor/admin 睇（UX）；真正權限喺 server（員工會 FORBIDDEN）
  const canManageAiTags = user?.role === 'supervisor' || user?.role === 'admin';
  const listQuery = trpc.products.adminList.useQuery(undefined);
  const [form, setForm] = useState(initialForm);
  // 尺寸選項總開關（boolean，唔入 initialForm 嘅 string 結構）：閂咗商品頁唔顯示尺寸、落單唔使揀
  const [sizeEnabled, setSizeEnabled] = useState(true);
  // 定時自動下架：開關 + 下架時間（到時前台自動消失；開關開咗冇填時間＝唔會自動落）
  const [delistEnabled, setDelistEnabled] = useState(false);
  const [delistAt, setDelistAt] = useState('');
  // 📺 直播場次商品（F8）：開關 + 直播日期（date input）+ 場次（≥1）；閂咗＝payload 畀 null 清走
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveDate, setLiveDate] = useState('');
  const [liveSession, setLiveSession] = useState('1');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const imageFileRef = useRef<HTMLInputElement | null>(null);
  // 編輯表格 ref：撳支筆時自動碌返去表格（手機表格喺最頂，唔跳會以為支筆冇反應）
  const formRef = useRef<HTMLFormElement | null>(null);
  // 商品相簿（多張相）：photos[0]＝封面；空陣列＝用 form.image 路徑做唯一圖
  const [photos, setPhotos] = useState<string[]>([]);
  // 每日新增篩選：dayKeyOf(createdAt) 嘅 key；null＝全部
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  // 排列方式：created 上載日期（最新先）／name 名稱／listed 上架日期（最新先）／category 分類
  const [sortKey, setSortKey] = useState<SortKey>('created');
  // 重點標籤：逐件停用嘅 inline 兩步確認＋批量多選（淨係可揀有啟用標籤嘅商品）
  const [confirmDisableAiId, setConfirmDisableAiId] = useState<number | null>(null);
  const [selectedAiIds, setSelectedAiIds] = useState<number[]>([]);

  /** 商品圖片上傳（一次過可揀多張）：逐張 POST /api/upload（staff JWT），路徑加入相簿 */
  const uploadImages = async (files: File[]) => {
    if (files.length === 0) return;
    if (photos.length + files.length > 12) {
      toast(`最多 12 張相（而家 ${photos.length} 張），請先刪走啲先`, 'error');
      return;
    }
    setUploading(true);
    try {
      const paths: string[] = [];
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { authorization: `Bearer ${getToken() ?? ''}` },
          body: fd,
        });
        const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!res.ok || !data.path) throw new Error(data.error ?? `HTTP ${res.status}`);
        paths.push(data.path);
      }
      setPhotos((p) => [...p, ...paths]);
      toast(`已上傳 ${paths.length} 張相`, 'success');
    } catch (e) {
      toast(`圖片上傳失敗：${e instanceof Error ? e.message : '未知錯誤'}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  /** 手動貼嘅路徑加入相簿（重複／爆上限會擋） */
  const addManualPhoto = () => {
    const v = form.image.trim();
    if (!v) return;
    if (photos.includes(v)) {
      toast('呢張相已經喺相簿度', 'error');
      return;
    }
    if (photos.length >= 12) {
      toast('最多 12 張相', 'error');
      return;
    }
    setPhotos((p) => [...p, v]);
  };

  /** 後台同前台 cache 一齊更新（adminList 包下架貨，list 係前台用） */
  const invalidateProducts = () => {
    void utils.products.adminList.invalidate();
    void utils.products.list.invalidate();
  };

  /** 表單＋開關全部還原（新增成功／取消編輯用） */
  const resetForm = () => {
    setForm(initialForm);
    setPhotos([]);
    setSizeEnabled(true);
    setDelistEnabled(false);
    setDelistAt('');
    setLiveEnabled(false);
    setLiveDate('');
    setLiveSession('1');
  };

  const createMutation = trpc.products.create.useMutation({
    onSuccess: (created) => {
      // 三級制（2026-08-06）：員工提交會進入審批，唔係即時生效
      if (created && 'pendingApproval' in created) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        resetForm();
        void utils.approvals.myRequests.invalidate();
        return;
      }
      toast(`已新增商品「${created?.name ?? ''}」`, 'success');
      resetForm();
      setFormError(null);
      invalidateProducts();
    },
    onError: (err) => toast(err.message || '新增商品失敗', 'error'),
  });

  // 編輯模式 submit（products.update 全欄位）
  const editMutation = trpc.products.update.useMutation({
    onSuccess: (updated) => {
      // 三級制（2026-08-06）：員工提交會進入審批，唔係即時生效
      if (updated && 'pendingApproval' in updated) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        resetForm();
        setEditingId(null);
        void utils.approvals.myRequests.invalidate();
        return;
      }
      toast(`已更新商品「${updated?.name ?? ''}」`, 'success');
      resetForm();
      setEditingId(null);
      setFormError(null);
      invalidateProducts();
    },
    onError: (err) => toast(err.message || '更新商品失敗', 'error'),
  });

  // isActive toggle：樂觀更新 adminList cache，下架貨 dim 顯示、可以隨時重新上架
  const toggleMutation = trpc.products.update.useMutation({
    onMutate: async (vars) => {
      await utils.products.adminList.cancel();
      const prev = utils.products.adminList.getData(undefined) as ProductRow[] | undefined;
      utils.products.adminList.setData(undefined, (old: ProductRow[] | undefined) =>
        old?.map((p) => (p.id === vars.id ? { ...p, isActive: vars.isActive ?? p.isActive } : p)),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      utils.products.adminList.setData(undefined, ctx?.prev);
      toast(err.message || '更新失敗', 'error');
    },
    onSuccess: (updated) => {
      // 三級制（2026-08-06）：員工提交會進入審批——樂觀更新咗嘅 cache 要 invalidate 還原
      if (updated && 'pendingApproval' in updated) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        void utils.approvals.myRequests.invalidate();
        invalidateProducts();
        return;
      }
      toast(updated?.isActive ? '已重新上架' : '已下架（列表 dim 顯示，可以隨時再上架）', 'success');
      invalidateProducts();
    },
  });

  const removeMutation = trpc.products.remove.useMutation({
    onSuccess: (result) => {
      // 三級制（2026-08-06）：員工提交會進入審批，唔係即時生效
      if ((result as { pendingApproval?: boolean } | null)?.pendingApproval) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        setConfirmRemoveId(null);
        void utils.approvals.myRequests.invalidate();
        return;
      }
      toast('已刪除商品', 'info');
      setConfirmRemoveId(null);
      invalidateProducts();
    },
    onError: (err) => {
      setConfirmRemoveId(null);
      toast(err.message || '刪除失敗', 'error');
    },
  });

  // 類別即時修改（列表行內 dropdown）
  const categoryMutation = trpc.products.update.useMutation({
    onSuccess: (updated) => {
      // 三級制（2026-08-06）：員工提交會進入審批，唔係即時生效
      if (updated && 'pendingApproval' in updated) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        void utils.approvals.myRequests.invalidate();
        return;
      }
      toast(`已將「${updated?.name ?? ''}」歸類做${productCategoryLabel(updated?.category)}`, 'success');
      invalidateProducts();
    },
    onError: (err) => toast(err.message || '更新類別失敗', 'error'),
  });

  /** 重點標籤停用成功後：後台列表＋前台公開查詢一齊更新（公開端停用後 server 會回 []） */
  const invalidateAiTagViews = () => {
    void utils.products.adminList.invalidate();
    void utils.products.list.invalidate();
    void utils.products.latest.invalidate();
    void utils.products.byId.invalidate();
  };

  // products.disableAiTags：一次過停一件或多件；冇重新啟用（停咗就停咗）。
  // 成功/失敗處理放喺逐次呼叫嘅 callback（單件）同 chunked runner（批量），
  // 唔放 mutation 級——否則批量逐 chunk mutateAsync 會每件都 toast＋清晒選擇。
  const disableAiTagsMutation = (
    trpc.products as unknown as { disableAiTags: DisableAiTagsApi }
  ).disableAiTags.useMutation();

  /** L3：批量停用進行中（chunked runner 自定狀態；mutation.isPending 只蓋單次呼叫） */
  const [batchAiDisabling, setBatchAiDisabling] = useState(false);

  /** 單件停用成功（原行為）：toast server 實際 count＋清確認狀態＋刷新 */
  const onSingleDisableSuccess = (result: unknown, vars: { ids: number[] }) => {
    const updated = (result as { count?: number } | null)?.count ?? vars.ids.length;
    toast(`已停用 ${updated} 件商品嘅 重點標籤（原始標籤會保留，但前台唔再顯示）`, 'success');
    setSelectedAiIds([]);
    setConfirmDisableAiId(null);
    invalidateAiTagViews();
  };

  /** L3：批量停用——揀幾多都得，後端每 call 最多 100 ids 所以逐 100 chunk 順序送。
   *  全部成功先清晒選擇；部份失敗如實報總數，失敗嘅 ids 保留選擇等主管重試。 */
  const runBatchDisableAiTags = async () => {
    const ids = selectedAiIds;
    if (ids.length === 0 || batchAiDisabling) return;
    setBatchAiDisabling(true);
    try {
      const result = await runAiTagsDisableInChunks(ids, disableAiTagsMutation.mutateAsync);
      if (result.failedIds.length === 0) {
        toast(
          `已停用 ${result.updatedCount} 件商品嘅 重點標籤（原始標籤會保留，但前台唔再顯示）`,
          'success',
        );
        setSelectedAiIds([]);
        setConfirmDisableAiId(null);
      } else {
        // 如實提示：成功幾多、失敗幾多、點解；失敗嘅保留選擇，唔會單 chunk 成功就報全成功
        toast(
          `已停用 ${result.updatedCount} 件；${result.failedIds.length} 件失敗（${result.firstError}）。未成功嘅已保留喺選擇入面，可以即刻重試。`,
          'error',
        );
        const failed = new Set(result.succeededIds);
        setSelectedAiIds((cur) => cur.filter((id) => !failed.has(id)));
      }
      invalidateAiTagViews();
    } finally {
      setBatchAiDisabling(false);
    }
  };

  /** 批量多選 toggle（淨係有啟用標籤嘅商品先有 checkbox） */
  const toggleAiSelect = (id: number) =>
    setSelectedAiIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  /** 進入編輯模式：populate 表單（日期轉 YYYY-MM-DD、null 欄轉空字串） */
  const startEdit = (p: ProductRow) => {
    setEditingId(p.id);
    setFormError(null);
    setSizeEnabled(p.sizeEnabled ?? true);
    setDelistEnabled(p.delistEnabled ?? false);
    setDelistAt(p.delistAt ? toLocalInput(new Date(p.delistAt)) : '');
    // 📺 直播場次（F8）：有 liveDate 即開開關；DB YYYYMMDD → date input YYYY-MM-DD
    setLiveEnabled(!!p.liveDate);
    setLiveDate(p.liveDate ? liveDateToInput(p.liveDate) : '');
    setLiveSession(p.liveSession ?? '1');
    setForm({
      name: p.name,
      sku: p.sku,
      price: String(p.price),
      discountPrice: p.discountPrice != null ? String(p.discountPrice) : '',
      category: p.category,
      listedDate: new Date(p.listedDate).toISOString().slice(0, 10),
      image: p.image,
      stock: String(p.stock),
      sizes: p.sizes ?? '',
      note: p.note ?? '',
      description: p.description ?? '',
    });
    // 相簿：有 photos 用 photos；冇（舊貨）就由 image 做唯一一張
    setPhotos(p.photos?.length ? p.photos : [p.image]);
    // 自動碌去編輯表格（等 React 先 render 新狀態先郁）
    window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const cancelEdit = () => {
    setEditingId(null);
    resetForm();
    setFormError(null);
  };

  const set = (key: keyof typeof initialForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const price = Number.parseInt(form.price, 10);
    if (!form.name.trim() || !form.sku.trim()) {
      setFormError('品名同貨號必填');
      return;
    }
    if (!Number.isInteger(price) || price < 0) {
      setFormError('價錢要係 0 或以上嘅整數（HKD）');
      return;
    }
    const discount = form.discountPrice.trim() ? Number.parseInt(form.discountPrice, 10) : undefined;
    if (discount !== undefined && (!Number.isInteger(discount) || discount < 0)) {
      setFormError('折扣價要係正整數');
      return;
    }
    const stock = form.stock.trim() ? Number.parseInt(form.stock, 10) : 0;
    if (!Number.isInteger(stock) || stock < 0) {
      setFormError('庫存要係 0 或以上嘅整數');
      return;
    }
    if (delistEnabled && !delistAt) {
      setFormError('開咗定時下架就要揀下架時間（或者閂返個開關）');
      return;
    }
    // 📺 直播場次（F8）：開咗就要揀日期；場次要係 ≥1 嘅整數
    if (liveEnabled && !liveDate) {
      setFormError('開咗直播場次商品就要揀直播日期（或者閂返個開關）');
      return;
    }
    const liveSessionNum = Number.parseInt(liveSession, 10);
    if (liveEnabled && (!Number.isInteger(liveSessionNum) || liveSessionNum < 1)) {
      setFormError('直播場次要係 1 或以上嘅整數');
      return;
    }
    setFormError(null);
    const sizesValue = form.sizes.trim() || null;
    // datetime-local 值係本地時間；閂咗開關就畀 null 清走舊設定
    const delistAtValue = delistEnabled && delistAt ? new Date(delistAt) : null;
    // date input 值 YYYY-MM-DD → DB YYYYMMDD；閂咗開關＝null（server 會連場次一齊清）
    const liveDateValue = liveEnabled && liveDate ? liveDate.replaceAll('-', '') : null;
    const liveSessionValue = liveEnabled && liveDate ? String(liveSessionNum) : null;
    if (editingId != null) {
      // 編輯模式：products.update 全欄位（可清空嘅欄用 null 覆寫）
      editMutation.mutate({
        id: editingId,
        name: form.name.trim(),
        sku: form.sku.trim(),
        price,
        discountPrice: discount ?? null,
        note: form.note.trim() || null,
        category: form.category,
        listedDate: form.listedDate ? new Date(`${form.listedDate}T00:00:00`) : undefined,
        image: form.image.trim() || '/product-1.jpg',
        photos: photos.length ? photos : [form.image.trim() || '/product-1.jpg'],
        stock,
        sizes: sizesValue,
        sizeEnabled,
        delistEnabled,
        delistAt: delistAtValue,
        liveDate: liveDateValue,
        liveSession: liveSessionValue,
        description: form.description.trim() || null,
      });
      return;
    }
    createMutation.mutate({
      name: form.name.trim(),
      sku: form.sku.trim(),
      price,
      discountPrice: discount,
      note: form.note.trim() || undefined,
      category: form.category,
      listedDate: form.listedDate ? new Date(`${form.listedDate}T00:00:00`) : undefined,
      image: form.image.trim() || '/product-1.jpg',
      photos: photos.length ? photos : [form.image.trim() || '/product-1.jpg'],
      stock,
      sizes: sizesValue ?? undefined,
      sizeEnabled,
      delistEnabled,
      delistAt: delistAtValue,
      liveDate: liveDateValue,
      liveSession: liveSessionValue,
      description: form.description.trim() || undefined,
    });
  };

  const products = (listQuery.data ?? []) as ProductRow[];
  const submitting = createMutation.isPending || editMutation.isPending;

  // 每日新增款式統計：按「上載日期」（createdAt 產生當日）分組數款數，最新一日排最前
  const dailyCounts = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const p of products) {
      const d = new Date(p.createdAt);
      const key = dayKeyOf(d);
      const label = `${d.getMonth() + 1}月${d.getDate()}日`;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { label, count: 1 });
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [products]);

  const todayKey = dayKeyOf(new Date());
  // 篩選（每日新增 chip）＋排列（上載日期／名稱／上架日期／分類）
  const visibleProducts = useMemo(() => {
    const filtered = dayFilter
      ? products.filter((p) => dayKeyOf(p.createdAt) === dayFilter)
      : [...products];
    const time = (d: Date | string) => new Date(d).getTime();
    switch (sortKey) {
      case 'name':
        // 中文品名用 localeCompare（zh-Hant）排；同名就新上載先
        filtered.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant-HK') || b.id - a.id);
        break;
      case 'listed':
        filtered.sort((a, b) => time(b.listedDate) - time(a.listedDate) || b.id - a.id);
        break;
      case 'category': {
        // 跟 PRODUCT_CATEGORIES 表嘅次序排；同類入面新上載先
        const order = new Map<string, number>(PRODUCT_CATEGORIES.map((c, i) => [c.value, i]));
        filtered.sort(
          (a, b) =>
            (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) ||
            time(b.createdAt) - time(a.createdAt) ||
            b.id - a.id,
        );
        break;
      }
      default:
        // created：最新上載排最前
        filtered.sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
    }
    return filtered;
  }, [products, dayFilter, sortKey]);

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
      {/* 左：新增／編輯商品表單（5） */}
      <form
        ref={formRef}
        onSubmit={submit}
        className="scroll-mt-24 rounded-2xl border p-5 backdrop-blur-xl md:p-6 xl:col-span-5"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
          {editingId != null ? (
            <Pencil size={16} className="text-gold" aria-hidden="true" />
          ) : (
            <Plus size={16} className="text-gold" aria-hidden="true" />
          )}
          {editingId != null ? '編輯商品' : '新增商品'}
        </h3>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="np-name" className="mb-1.5 block text-[14px] text-txt-2">
              品名 *
            </label>
            <input
              id="np-name"
              value={form.name}
              onChange={(e) => set('name')(e.target.value)}
              className={inputCls}
              placeholder="例如：星空雪紡連身裙"
            />
          </div>
          <div>
            <label htmlFor="np-sku" className="mb-1.5 block text-[14px] text-txt-2">
              貨號 *
            </label>
            <input
              id="np-sku"
              value={form.sku}
              onChange={(e) => set('sku')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="RC-0001"
            />
            {editingId != null && (
              <p className="mt-1.5 text-[12px] leading-[1.5] text-gold-soft">
                改貨號要小心：唔可以同其他商品重複，舊訂單快照唔會跟住改。
              </p>
            )}
          </div>
          <div>
            <label htmlFor="np-date" className="mb-1.5 block text-[14px] text-txt-2">
              上架日期
            </label>
            <input
              id="np-date"
              type="date"
              value={form.listedDate}
              onChange={(e) => set('listedDate')(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="np-category" className="mb-1.5 block text-[14px] text-txt-2">
              類別 *
            </label>
            <select
              id="np-category"
              value={form.category}
              onChange={(e) => set('category')(e.target.value)}
              className={inputCls}
            >
              {PRODUCT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="np-price" className="mb-1.5 block text-[14px] text-txt-2">
              價錢 HKD *
            </label>
            <input
              id="np-price"
              inputMode="numeric"
              value={form.price}
              onChange={(e) => set('price')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="299"
            />
          </div>
          <div>
            <label htmlFor="np-discount" className="mb-1.5 block text-[14px] text-txt-2">
              折扣價（選填）
            </label>
            <input
              id="np-discount"
              inputMode="numeric"
              value={form.discountPrice}
              onChange={(e) => set('discountPrice')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="259"
            />
          </div>
          <div>
            <label htmlFor="np-stock" className="mb-1.5 block text-[14px] text-txt-2">
              庫存
            </label>
            <input
              id="np-stock"
              inputMode="numeric"
              value={form.stock}
              onChange={(e) => set('stock')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="10"
            />
          </div>
          {/* 尺寸選項開關：閂咗商品頁唔會顯示尺寸揀選（袋/飾物呢類冇尺寸嘅貨用） */}
          <div>
            <span className="mb-1.5 block text-[14px] text-txt-2">尺寸選項</span>
            <button
              type="button"
              role="switch"
              aria-checked={sizeEnabled}
              aria-label="尺寸選項開關"
              onClick={() => setSizeEnabled((v) => !v)}
              className="flex h-12 items-center gap-2.5"
            >
              <span
                className="relative h-6 w-11 shrink-0 rounded-full border transition-colors"
                style={{
                  background: sizeEnabled ? 'var(--success)' : 'var(--space-4)',
                  borderColor: sizeEnabled ? 'var(--success)' : 'var(--space-line)',
                }}
              >
                <span
                  className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
                  style={{
                    background: sizeEnabled ? 'var(--space-1)' : 'var(--text-3)',
                    transform: sizeEnabled ? 'translateX(22px)' : 'translateX(2px)',
                  }}
                  aria-hidden="true"
                />
              </span>
              <span className="text-[13px] text-txt-3">{sizeEnabled ? '開（商品頁要揀尺寸）' : '閂（冇尺寸，唔使揀）'}</span>
            </button>
          </div>
          <div>
            <label htmlFor="np-sizes" className="mb-1.5 block text-[14px] text-txt-2">
              尺寸（選填，逗號分隔）
            </label>
            <input
              id="np-sizes"
              value={form.sizes}
              onChange={(e) => set('sizes')(e.target.value)}
              disabled={!sizeEnabled}
              className={`${inputCls} font-mono disabled:opacity-50`}
              placeholder="S,M,L"
            />
          </div>
          {/* 定時自動下架：開關 + 時間。到時前台自動消失（server 查詢判斷，唔使 cron） */}
          <div>
            <span className="mb-1.5 block text-[14px] text-txt-2">定時自動下架</span>
            <button
              type="button"
              role="switch"
              aria-checked={delistEnabled}
              aria-label="定時自動下架開關"
              onClick={() => setDelistEnabled((v) => !v)}
              className="flex h-12 items-center gap-2.5"
            >
              <span
                className="relative h-6 w-11 shrink-0 rounded-full border transition-colors"
                style={{
                  background: delistEnabled ? 'var(--gold)' : 'var(--space-4)',
                  borderColor: delistEnabled ? 'var(--gold)' : 'var(--space-line)',
                }}
              >
                <span
                  className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
                  style={{
                    background: delistEnabled ? 'var(--space-1)' : 'var(--text-3)',
                    transform: delistEnabled ? 'translateX(22px)' : 'translateX(2px)',
                  }}
                  aria-hidden="true"
                />
              </span>
              <span className="text-[13px] text-txt-3">
                {delistEnabled ? '開（到時間自動下架）' : '閂（唔會自動下架）'}
              </span>
            </button>
          </div>
          <div>
            <label htmlFor="np-delist" className="mb-1.5 block text-[14px] text-txt-2">
              下架時間（選填）
            </label>
            <input
              id="np-delist"
              type="datetime-local"
              value={delistAt}
              onChange={(e) => setDelistAt(e.target.value)}
              disabled={!delistEnabled}
              className={`${inputCls} font-mono disabled:opacity-50`}
            />
          </div>
          {/* 📺 直播場次商品（F8）：開關 + 直播日期 + 場次。開咗商品會歸入該場直播，前台可以按場次篩 */}
          <div>
            <span className="mb-1.5 block text-[14px] text-txt-2">📺 直播場次商品</span>
            <button
              type="button"
              role="switch"
              aria-checked={liveEnabled}
              aria-label="直播場次商品開關"
              onClick={() => setLiveEnabled((v) => !v)}
              className="flex h-12 items-center gap-2.5"
            >
              <span
                className="relative h-6 w-11 shrink-0 rounded-full border transition-colors"
                style={{
                  background: liveEnabled ? 'var(--gold)' : 'var(--space-4)',
                  borderColor: liveEnabled ? 'var(--gold)' : 'var(--space-line)',
                }}
              >
                <span
                  className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
                  style={{
                    background: liveEnabled ? 'var(--space-1)' : 'var(--text-3)',
                    transform: liveEnabled ? 'translateX(22px)' : 'translateX(2px)',
                  }}
                  aria-hidden="true"
                />
              </span>
              <span className="text-[13px] text-txt-3">
                {liveEnabled ? '開（歸入指定直播場次）' : '閂（普通商品）'}
              </span>
            </button>
          </div>
          <div>
            <label htmlFor="np-livedate" className="mb-1.5 block text-[14px] text-txt-2">
              直播日期
            </label>
            <input
              id="np-livedate"
              type="date"
              value={liveDate}
              onChange={(e) => setLiveDate(e.target.value)}
              disabled={!liveEnabled}
              className={`${inputCls} font-mono disabled:opacity-50`}
            />
          </div>
          <div>
            <label htmlFor="np-livesession" className="mb-1.5 block text-[14px] text-txt-2">
              場次（第幾場）
            </label>
            <input
              id="np-livesession"
              type="number"
              min={1}
              step={1}
              value={liveSession}
              onChange={(e) => setLiveSession(e.target.value)}
              disabled={!liveEnabled}
              className={`${inputCls} font-mono disabled:opacity-50`}
              placeholder="1"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="np-image" className="mb-1.5 block text-[14px] text-txt-2">
              商品圖片（可以好多張；第一張＝封面，最多 12 張）
            </label>
            {/* 相簿縮圖：✕ 刪除；第一張係封面 */}
            {photos.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2.5">
                {photos.map((src, i) => (
                  <span key={`${src}-${i}`} className="relative inline-block">
                    <img
                      src={src}
                      alt={`商品圖片 ${i + 1}`}
                      className="h-14 w-14 rounded-lg border object-cover"
                      style={{ borderColor: i === 0 ? 'var(--pink)' : 'var(--space-line)' }}
                    />
                    {i === 0 && (
                      <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-pink px-1.5 text-[10px] font-bold leading-4 text-space-1">
                        封面
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`刪除第 ${i + 1} 張相`}
                      onClick={() => setPhotos((p) => p.filter((_, idx) => idx !== i))}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border bg-space-1 text-txt-3 transition-colors hover:text-pink-soft"
                      style={{ borderColor: 'var(--space-line)' }}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                id="np-image"
                value={form.image}
                onChange={(e) => set('image')(e.target.value)}
                className={`${inputCls} font-mono`}
                placeholder="手動貼路徑，例如 /product-1.jpg"
              />
              <button
                type="button"
                onClick={addManualPhoto}
                className="btn btn-secondary shrink-0 !px-3 !py-2.5 text-[13px]"
              >
                加入
              </button>
              <input
                ref={imageFileRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const fs = e.target.files ? [...e.target.files] : [];
                  if (fs.length > 0) void uploadImages(fs);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => imageFileRef.current?.click()}
                disabled={uploading}
                className="btn btn-primary shrink-0 !px-4 !py-2.5 text-[13px] disabled:opacity-60"
              >
                <Upload size={14} aria-hidden="true" />
                {uploading ? '上傳中…' : '上傳（可揀多張）'}
              </button>
            </div>
            {photos.length === 0 && (
              <p className="mt-1.5 text-[12px] text-txt-3">
                相簿而家係空：會用上面路徑嗰張做唯一商品圖。
              </p>
            )}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="np-note" className="mb-1.5 block text-[14px] text-txt-2">
              備註（選填，內部用，例如：直播講過嘅重點、供應商貨號）
            </label>
            <input
              id="np-note"
              value={form.note}
              onChange={(e) => set('note')(e.target.value)}
              className={inputCls}
              placeholder="內部備註，客人睇唔到"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="np-desc" className="mb-1.5 block text-[14px] text-txt-2">
              描述（選填）
            </label>
            <textarea
              id="np-desc"
              value={form.description}
              onChange={(e) => set('description')(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-space-line bg-space-2 px-4 py-3 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink"
              placeholder="布料、剪裁、著身感…"
            />
          </div>
        </div>
        {formError && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-pink-soft" role="alert">
            <span
              className="inline-block h-2 w-2 rotate-45"
              style={{ background: 'var(--gold)' }}
              aria-hidden="true"
            />
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="btn btn-primary mt-5 w-full disabled:opacity-60"
        >
          {submitting ? (
            <WishingStar size={16} />
          ) : editingId != null ? (
            <Pencil size={16} aria-hidden="true" />
          ) : (
            <Plus size={16} aria-hidden="true" />
          )}
          {editingId != null ? '儲存修改' : '新增商品'}
        </button>
        {editingId != null && (
          <button
            type="button"
            onClick={cancelEdit}
            disabled={submitting}
            className="btn btn-secondary mt-3 w-full disabled:opacity-60"
          >
            <X size={16} aria-hidden="true" />
            取消編輯
          </button>
        )}
      </form>

      {/* 右：現有商品列表（7） */}
      <div className="xl:col-span-7">
        <h3 className="text-[16px] font-bold text-txt-1">
          現有商品
          <span className="ml-2 font-mono text-[13px] font-normal text-txt-3">
            {products.length} 款
            {dayFilter != null ? `（篩緊 ${visibleProducts.length} 款）` : ''}
          </span>
        </h3>
        {/* 排列方式：上載日期（最新先）／名稱／上架日期（最新先）／分類（跟類別表次序） */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-txt-3">排列：</span>
          {SORT_OPTIONS.map((opt) => {
            const active = sortKey === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSortKey(opt.key)}
                aria-pressed={active}
                className="shrink-0 rounded-full border px-3 py-1.5 font-mono text-[12px] transition-colors"
                style={{
                  borderColor: active ? 'var(--pink)' : 'var(--glass-border)',
                  background: active ? 'var(--glass-bg-strong)' : 'var(--glass-bg)',
                  color: active ? 'var(--pink)' : 'var(--text-3)',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {/* 每日新增款式：按上載日期（產生當日）分組；撳 chip 篩出嗰日嘅款，再撳一次取消 */}
        {dailyCounts.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1.5">
            <button
              type="button"
              onClick={() => setDayFilter(null)}
              aria-pressed={dayFilter === null}
              className="shrink-0 rounded-full border px-3 py-1.5 font-mono text-[12px] transition-colors"
              style={{
                borderColor: dayFilter === null ? 'var(--pink)' : 'var(--glass-border)',
                background: dayFilter === null ? 'var(--glass-bg-strong)' : 'var(--glass-bg)',
                color: dayFilter === null ? 'var(--pink)' : 'var(--text-3)',
              }}
            >
              全部
            </button>
            {dailyCounts.map(([key, info]) => {
              const active = dayFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDayFilter((cur) => (cur === key ? null : key))}
                  aria-pressed={active}
                  className="shrink-0 rounded-full border px-3 py-1.5 font-mono text-[12px] transition-colors"
                  style={{
                    borderColor: active ? 'var(--pink)' : 'var(--glass-border)',
                    background: active ? 'var(--glass-bg-strong)' : 'var(--glass-bg)',
                    color: active ? 'var(--pink)' : 'var(--text-2)',
                  }}
                >
                  {info.label} ＋{info.count}款{key === todayKey ? '（今日）' : ''}
                </button>
              );
            })}
          </div>
        )}
        {listQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊貨…" />
        ) : products.length === 0 ? (
          <p className="py-14 text-center text-[14px] text-txt-3">未有商品，左手邊新增第一款啦。</p>
        ) : (
          <>
          {/* 原位批量行動列（supervisor/admin）：揀咗有啟用標籤嘅商品先出現，唔係 modal */}
          {canManageAiTags && selectedAiIds.length > 0 && (
            <div
              className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
              style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)' }}
              role="region"
              aria-label="批量停用 重點標籤"
            >
              <p className="text-[13px] text-txt-2">
                已揀 <span className="font-mono font-bold text-gold">{selectedAiIds.length}</span> 件商品
              </p>
              <button
                type="button"
                disabled={disableAiTagsMutation.isPending || batchAiDisabling}
                onClick={() => void runBatchDisableAiTags()}
                className="btn btn-primary !min-h-11 !px-4 !py-2 text-[13px] disabled:opacity-60"
              >
                {disableAiTagsMutation.isPending || batchAiDisabling ? (
                  <WishingStar size={13} />
                ) : (
                  <Ban size={13} aria-hidden="true" />
                )}
                批量停用 重點標籤
              </button>
              <button
                type="button"
                disabled={disableAiTagsMutation.isPending || batchAiDisabling}
                onClick={() => setSelectedAiIds([])}
                className="btn btn-secondary !min-h-11 !px-4 !py-2 text-[13px] disabled:opacity-60"
              >
                清除選擇
              </button>
            </div>
          )}
          <ul className="mt-4 flex flex-col gap-2">
            {visibleProducts.map((p) => {
              // 存貨 10 件以下都當緊張（直播前提醒補貨）
              const lowStock = p.stock < 10;
              // 定時下架已到時（前台已經見唔到；後台行照顯示但 dim）
              const autoDelisted =
                p.delistEnabled && p.delistAt !== null && new Date(p.delistAt).getTime() <= Date.now();
              const removing = removeMutation.isPending && confirmRemoveId === p.id;
              // 重點標籤：parse JSON 防壞資料；啟用中＝server 話 enabled 兼且有標籤
              const aiTags = parseAiTagsJson(p.aiTags);
              const aiEnabled = p.aiTagsEnabled === true && aiTags.length > 0;
              const disablingAi = disableAiTagsMutation.isPending && confirmDisableAiId === p.id;
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-2xl border px-4 py-3.5"
                  style={{
                    borderColor: 'var(--space-line)',
                    background: 'var(--space-2)',
                    opacity: p.isActive && !autoDelisted ? 1 : 0.55,
                  }}
                >
                  {/* 批量多選 checkbox（supervisor/admin；淨係有啟用中 重點標籤嘅商品先可揀） */}
                  {canManageAiTags && aiEnabled && (
                    <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selectedAiIds.includes(p.id)}
                        onChange={() => toggleAiSelect(p.id)}
                        aria-label={`選擇 ${p.name} 以批量停用 重點標籤`}
                        className="h-4 w-4 accent-pink"
                      />
                    </label>
                  )}
                  <img
                    src={p.image}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-lg border object-cover"
                    style={{ borderColor: 'var(--glass-border)', background: 'var(--space-0)' }}
                    loading="lazy"
                  />
                  {/* 手機：資料跟圖片同一行攞晒剩底嘅位；價錢+掣跌落第二行右齊。sm 起返正常一行過 */}
                  <div className="min-w-0 flex-1 basis-[calc(100%-4rem)] sm:basis-0">
                    <p className="truncate text-[14px] font-bold text-txt-1">{p.name}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">
                      {p.sku} · 上架 {fmtDate(p.listedDate)}
                    </p>
                    {p.note && (
                      <p className="mt-1 text-[12px] leading-[1.5] text-gold-soft">
                        備註：{p.note}
                      </p>
                    )}
                    {/* 重點標籤行：原始標籤照顯示（停咗用都睇返）；狀態 badge ＋ 逐件停用（inline 兩步確認）。
                        員工睇到標籤同狀態，但停用控制只畀 supervisor/admin */}
                    {aiTags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Sparkles size={12} aria-hidden="true" className="shrink-0 text-gold" />
                        {aiTags.map((t) => (
                          <span
                            key={t}
                            className="rounded-md border px-2 py-0.5 font-mono text-[12px] leading-[1.6]"
                            style={{
                              borderColor: 'var(--glass-border)',
                              background: 'var(--glass-bg)',
                              color: aiEnabled ? 'var(--gold-soft)' : 'var(--text-3)',
                            }}
                          >
                            {t}
                          </span>
                        ))}
                        {aiEnabled ? (
                          <span
                            className="rounded-full border px-2 py-0.5 font-mono text-[12px] text-success"
                            style={{ borderColor: 'var(--success)', background: 'var(--glass-bg)' }}
                          >
                            重點標籤啟用中
                          </span>
                        ) : (
                          <span
                            className="rounded-full border px-2 py-0.5 font-mono text-[12px] text-txt-3"
                            style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
                          >
                            重點標籤已停用（前台唔顯示）
                          </span>
                        )}
                        {canManageAiTags &&
                          aiEnabled &&
                          (confirmDisableAiId === p.id ? (
                            <>
                              <button
                                type="button"
                                disabled={disablingAi}
                                onClick={() =>
                                  disableAiTagsMutation.mutate(
                                    { ids: [p.id] },
                                    {
                                      onSuccess: onSingleDisableSuccess,
                                      // 失敗保留選擇同確認狀態，等主管可以即刻重試
                                      onError: (err) =>
                                        toast(err.message || '停用 重點標籤失敗', 'error'),
                                    },
                                  )
                                }
                                className="btn btn-primary shrink-0 !min-h-11 !px-3 !py-2 text-[12px] disabled:opacity-60"
                              >
                                {disablingAi ? <WishingStar size={12} /> : null}
                                確認停用？
                              </button>
                              <button
                                type="button"
                                disabled={disablingAi}
                                onClick={() => setConfirmDisableAiId(null)}
                                className="btn btn-secondary shrink-0 !min-h-11 !px-3 !py-2 text-[12px] disabled:opacity-60"
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDisableAiId(p.id)}
                              className="btn btn-secondary shrink-0 !min-h-11 !px-3 !py-2 text-[12px]"
                            >
                              <Ban size={12} aria-hidden="true" />
                              停用 重點標籤
                            </button>
                          ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {/* 類別 badge */}
                      <span
                        className="rounded-full border px-2.5 py-0.5 font-mono text-[11px] text-lavender"
                        style={{
                          borderColor: 'var(--glass-border)',
                          background: 'var(--glass-bg)',
                        }}
                      >
                        {productCategoryLabel(p.category)}
                      </span>
                      {/* 尺寸 badge（開咗尺寸選項＋有填尺寸先顯示） */}
                      {p.sizeEnabled && p.sizes && (
                        <span
                          className="rounded-full border px-2.5 py-0.5 font-mono text-[11px] text-txt-2"
                          style={{
                            borderColor: 'var(--glass-border)',
                            background: 'var(--glass-bg)',
                          }}
                        >
                          尺寸 {p.sizes.split(',').map((s) => s.trim()).filter(Boolean).join(' / ')}
                        </span>
                      )}
                      {/* 定時下架 badge（有設定先顯示） */}
                      {p.delistEnabled && p.delistAt && (
                        <span
                          className="rounded-full border px-2.5 py-0.5 font-mono text-[11px]"
                          style={{
                            borderColor: autoDelisted ? 'var(--pink)' : 'var(--glass-border)',
                            background: 'var(--glass-bg)',
                            color: autoDelisted ? 'var(--pink-soft)' : 'var(--gold-soft)',
                          }}
                        >
                          {autoDelisted
                            ? '已到時自動下架（前台隱藏）'
                            : `${fmtDelist(new Date(p.delistAt))} 自動下架`}
                        </span>
                      )}
                      {/* 📺 直播場次 badge（F8：有直播日期先顯示） */}
                      {p.liveDate && (
                        <span
                          className="rounded-full border px-2.5 py-0.5 font-mono text-[11px]"
                          style={{
                            borderColor: 'var(--glass-border)',
                            background: 'var(--glass-bg)',
                            color: 'var(--pink-soft)',
                          }}
                        >
                          📺 {fmtLiveDate(p.liveDate)}
                          {p.liveSession ? `·第${p.liveSession}場` : ''}
                        </span>
                      )}
                      {/* 行內改類別（即時 update） */}
                      <select
                        value={p.category}
                        disabled={categoryMutation.isPending}
                        onChange={(e) =>
                          categoryMutation.mutate({ id: p.id, category: e.target.value })
                        }
                        aria-label={`更改 ${p.name} 類別`}
                        className="h-7 rounded-lg border bg-space-2 px-2 font-mono text-[11px] text-txt-3 transition-colors focus:border-pink disabled:opacity-60"
                        style={{ borderColor: 'var(--space-line)' }}
                      >
                        {PRODUCT_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>
                            改做：{c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* 價錢/存貨 + 操作掣：手機跌落第二行右齊，desktop 同一行 */}
                  <div className="ml-auto flex items-center gap-3">
                    <div className="text-right">
                      <p className="font-mono text-[14px] text-pink">
                        {p.discountPrice != null ? fmtHKD(p.discountPrice) : fmtHKD(p.price)}
                        {p.discountPrice != null && (
                          <span className="ml-2 text-[12px] text-txt-3 line-through">
                            {fmtHKD(p.price)}
                          </span>
                        )}
                      </p>
                      <p
                        className="mt-0.5 font-mono text-[12px]"
                        style={{ color: lowStock ? 'var(--gold)' : 'var(--text-3)' }}
                      >
                        存貨 {p.stock}
                        {lowStock ? '（緊張）' : ''}
                      </p>
                    </div>
                    {/* 編輯：populate 表單進入編輯模式 */}
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      disabled={editingId === p.id}
                      aria-label={`編輯 ${p.name}`}
                      className="btn btn-secondary shrink-0 !h-10 !w-10 !rounded-full !p-0 disabled:opacity-50"
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    {/* isActive toggle */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={p.isActive}
                      aria-label={`${p.name} 上架狀態`}
                      disabled={toggleMutation.isPending}
                      onClick={() =>
                        toggleMutation.mutate({ id: p.id, isActive: !p.isActive })
                      }
                      className="relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60"
                      style={{
                        background: p.isActive ? 'var(--success)' : 'var(--space-4)',
                        borderColor: p.isActive ? 'var(--success)' : 'var(--space-line)',
                      }}
                    >
                      <span
                        className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
                        style={{
                          background: p.isActive ? 'var(--space-1)' : 'var(--text-3)',
                          transform: p.isActive ? 'translateX(22px)' : 'translateX(2px)',
                        }}
                        aria-hidden="true"
                      />
                    </button>
                    {/* 刪除（兩步確認） */}
                    {confirmRemoveId === p.id ? (
                      <button
                        type="button"
                        disabled={removing}
                        onClick={() =>
                          removeMutation.mutate(
                            { id: p.id },
                            { onError: () => setConfirmRemoveId(null) },
                          )
                        }
                        className="btn btn-primary shrink-0 !px-4 !py-2 text-[12px] disabled:opacity-60"
                      >
                        {removing ? <WishingStar size={13} /> : null}
                        確認刪除？
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(p.id)}
                        aria-label={`刪除 ${p.name}`}
                        className="btn btn-secondary shrink-0 !h-10 !w-10 !rounded-full !p-0"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          </>
        )}
      </div>
    </div>
  );
}
