import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  Check,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';
import { trpc } from '@/providers/trpc';
import GloGuideRichText from '@/components/GloGuideRichText';
import { parseGloGuideRichText, wrapGloGuideSelection, type GloGuideRichTag } from '@contracts/gloGuideRichText';
import { productCategoryLabel } from '@contracts/types';
import { fmtDateTime, fmtHKD } from './format';
import GloGuideUsagePanel from './GloGuideUsagePanel';
import type { ToastKind } from './useToasts';
import './GloGuidePanel.css';

/**
 * Glo Glo 精選文章後台面板（/admin sidebar「精選文章」）。
 *
 * ─ 資料全部經 trpc.gloGuideAdmin（staff JWT）；approve/reject/archive 後端係
 *   supervisorProcedure——UI 收埋掣只係體驗，後端照樣擋 staff 越權。
 * ─ 系統自動稿同手動稿共用 DB，所以出現喺同一 list。
 * ─ 富文本：[b]/[gold]/[pink]/[tag] toolbar（揀文字→包標記）＋即時安全預覽
 *   （GloGuideRichText React render，唔用 dangerouslySetInnerHTML）。
 * ─ 未發布圖預覽行 imageRead（authenticated base64），唔會繞公開 media gate。
 * ─ inline 展開編輯，唔用全屏彈窗；mobile-first，全部 control ≥44px。
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type GuideArticle = RouterOutputs['gloGuideAdmin']['articles']['items'][number];
export type GuideImage = GuideArticle['images'][number];
/** 已揀商品（審批對照卡用）：snapshot＋現行商品 facts */
export type GuideProduct = GuideArticle['products'][number];
/** 模特兒原圖列表回應（後台限定；原圖絕不公開） */
export type ModelImageList = RouterOutputs['gloGuideAdmin']['modelImages'];
export type ModelImageItem = ModelImageList['items'][number];
/** DB status 欄係 string；呢度收做字面 union 俾 filter／狀態閘用（後端 zod enum 同款白名單） */
export type GuideStatus = 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';

// ── 選貨 contract（iteration-4 SPEC 凍結）────────────────────────────────
// 後端 agent 同步喺 gloGuideAdmin router 落 productSources／products／generate{selection}。
// 呢度按凍結 SPEC 定本地型別＋單點 cast 接線；router 落地後 procedure 名同 payload
// 完全一致，cast 自然對齊真型別，唔使再改 UI。

/** 選貨方式：自動逐週 fallback／指定星期／指定日期／指定場次／直接指定商品 */
export type SourceMode = 'auto' | 'week' | 'date' | 'session' | 'products';

export type GloGuideProductFilter =
  | { mode: 'auto' }
  | { mode: 'week'; weekStart: string } // HK Monday，YYYY-MM-DD
  | { mode: 'date'; liveDate: string } // YYYYMMDD，當日全部場次
  | { mode: 'session'; liveDate: string; liveSession: string } // YYYYMMDD＋真場次
  | { mode: 'search'; query: string }; // 直接商品搜尋，1–60 字

export type GloGuideGenerateSelection =
  | { mode: 'auto' }
  | { mode: 'week'; weekStart: string; productIds?: number[] }
  | { mode: 'date'; liveDate: string; productIds?: number[] }
  | { mode: 'session'; liveDate: string; liveSession: string; productIds?: number[] }
  | { mode: 'products'; productIds: number[] };

/** productSources 回傳嘅真實選項（staff 可查；server 重查 DB） */
export interface GloGuideProductSources {
  weeks: Array<{ weekStart: string; weekEnd: string; total: number; eligible: number }>;
  dates: Array<{ liveDate: string; total: number; eligible: number }>;
  sessions: Array<{ liveDate: string; liveSession: string; total: number; eligible: number }>;
}

export type IneligibleReason = 'used' | 'inactive' | 'out_of_stock' | 'delisted' | 'no_image' | 'category';

/** GloGuideProductRef：原欄（同舊 weeklyProducts item 一致）＋永久去重／資格欄 */
export interface SourceProduct {
  id: number;
  sku: string | null;
  name: string;
  image: string;
  price: number;
  discountPrice: number | null;
  aiTags: string[];
  liveDate: string | null;
  liveSession: string | null;
  category: string;
  stock: number;
  /** 曾屬任何指南文章 → 永久唔可以再用 */
  usedBefore: boolean;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
}

/** 同 trpc useQuery 回傳結構相容嘅最小介面（cast 用；router 落地後即係真型別） */
interface SourceQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => Promise<unknown>;
}

interface GloGuideSourceContract {
  productSources: {
    useQuery: (input: undefined, opts?: { refetchOnWindowFocus?: boolean }) => SourceQueryResult<GloGuideProductSources>;
  };
  products: {
    useQuery: (
      input: GloGuideProductFilter,
      opts?: { enabled?: boolean; refetchOnWindowFocus?: boolean },
    ) => SourceQueryResult<{ items: SourceProduct[] }>;
  };
  generate: {
    useMutation: () => {
      mutateAsync: (input: { selection: GloGuideGenerateSelection; themeHint?: string }) => Promise<{ id: number }>;
      isPending: boolean;
    };
  };
}

type Toast = (text: string, kind?: ToastKind) => void;

// ──────────────────────────── 純邏輯（export 俾測試抽）────────────────────────────

/* eslint-disable react-refresh/only-export-components -- 面板純邏輯 export 俾單元測試抽（同 TryOnShared.tsx 做法一致） */

/** body 純文字字數（剝格式標記；空白唔計）——同 service countBodyCodePoints 同一規則 */
export function plainBodyCharCount(body: string): number {
  let n = 0;
  for (const ch of parseGloGuideRichText(body).plainText) {
    if (!/\s/u.test(ch)) n++;
  }
  return n;
}

export const BODY_MIN = 150;
export const BODY_MAX = 300;

/** 字數閘狀態：合格 150–300 */
export function bodyCountOk(count: number): boolean {
  return count >= BODY_MIN && count <= BODY_MAX;
}

/** published 文章唔可以直接改（SPEC：先落架）；生成中都鎖住 */
export function canEditArticle(article: Pick<GuideArticle, 'status' | 'generationStatus'>): boolean {
  return article.status !== 'published' && !isGenerating(article);
}

export function isGenerating(article: Pick<GuideArticle, 'generationStatus'>): boolean {
  return article.generationStatus === 'queued' || article.generationStatus === 'processing';
}

export function canSubmitArticle(status: string): boolean {
  return status === 'draft' || status === 'rejected';
}
export function canApproveArticle(status: string): boolean {
  return status === 'pending_review';
}
export function canArchiveArticle(status: string): boolean {
  return status === 'published';
}

/** 上傳前 client 檢查：dataURL → { mime, base64 }；唔啲回錯誤字串 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function validateUploadFile(file: { size: number; type: string }): string | null {
  if (!(UPLOAD_MIMES as readonly string[]).includes(file.type)) {
    return '只支援 JPEG／PNG／WebP 圖片';
  }
  if (file.size > UPLOAD_MAX_BYTES) return '圖片超過 10MB 上限';
  return null;
}

export function dataUrlToBase64(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const base64 = dataUrl.slice(comma + 1);
  return base64.length > 0 ? base64 : null;
}

export const STATUS_META: Record<GuideStatus, { label: string; tone: string }> = {
  draft: { label: '草稿', tone: 'lavender' },
  pending_review: { label: '待審批', tone: 'gold' },
  published: { label: '已上架', tone: 'green' },
  rejected: { label: '已拒絕', tone: 'pink' },
  archived: { label: '已落架', tone: 'default' },
};

export const IMAGE_STATUS_LABEL: Record<GuideImage['status'], string> = {
  queued: '排隊中',
  processing: '生成中',
  completed: '完成',
  failed: '失敗',
};

export const REVIEW_STATUS_META: Record<GuideImage['reviewStatus'], { label: string; tone: string }> = {
  pending: { label: '待審', tone: 'gold' },
  approved: { label: '已批', tone: 'green' },
  rejected: { label: '已拒絕', tone: 'pink' },
};

/* eslint-enable react-refresh/only-export-components */

// ──────────────────────────── 小元件 ────────────────────────────

function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className="ggp-badge" data-tone={tone}>
      {label}
    </span>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '操作失敗，請再試';
}

// ──────────────────────────── 新增文章（五種真選貨：auto／week／date／session／products）────────────────────────────

/* eslint-disable react-refresh/only-export-components -- 選貨純邏輯 export 俾單元測試抽 */

export const INELIGIBLE_LABEL: Record<IneligibleReason, string> = {
  used: '已用過（每件商品只可以出現喺一篇指南）',
  inactive: '已下架',
  out_of_stock: '缺貨',
  delisted: '已過下架期',
  no_image: '冇商品圖',
  category: '類別唔支援（限服飾／飾品）',
};

/** 商品唔可揀嘅原因字串；可揀回 null。優先用 server 嘅 ineligibleReason，fallback usedBefore。 */
export function productBlockReason(
  p: Pick<SourceProduct, 'eligible' | 'usedBefore' | 'ineligibleReason'>,
): string | null {
  if (p.eligible && !p.usedBefore) return null;
  if (p.ineligibleReason) return INELIGIBLE_LABEL[p.ineligibleReason];
  return p.usedBefore ? INELIGIBLE_LABEL.used : '唔符合今次選貨條件';
}

/** 商品搜尋字硬閘（SPEC：1–60 chars） */
export function searchQueryOk(q: string): boolean {
  const t = q.trim();
  return t.length >= 1 && t.length <= 60;
}

/**
 * 砌 generate selection（SPEC 凍結）：
 * ─ auto 唔帶商品，server 由本週向過去逐週搵最少 2 件合資格未用商品，再喺嗰週合資格池隨機抽 2–3 件；
 * ─ week／date／session 可以唔揀（server 由該來源合資格池隨機抽 2–3 件）或者人手揀最少 2 件，唔設上限；
 * ─ products 一定要直接指定最少 2 件，唔設上限；
 * ─ 條件唔齊回 null（UI 擋生成掣），絕對唔會暗中改用其他來源。
 */
export function buildGenerateSelection(
  mode: SourceMode,
  opts: {
    weekStart?: string | null;
    liveDate?: string | null;
    liveSession?: string | null;
    productIds: number[];
  },
): GloGuideGenerateSelection | null {
  const ids = opts.productIds;
  if (mode === 'auto') return { mode: 'auto' };
  if (mode === 'products') {
    return ids.length >= 2 ? { mode: 'products', productIds: [...ids] } : null;
  }
  // week／date／session：0 件＝來源合資格池隨機抽 2–3；有揀就最少 2 件、唔設上限
  if (ids.length === 1) return null;
  if (mode === 'week') {
    if (!opts.weekStart) return null;
    return ids.length > 0
      ? { mode: 'week', weekStart: opts.weekStart, productIds: [...ids] }
      : { mode: 'week', weekStart: opts.weekStart };
  }
  if (!opts.liveDate) return null;
  if (mode === 'date') {
    return ids.length > 0
      ? { mode: 'date', liveDate: opts.liveDate, productIds: [...ids] }
      : { mode: 'date', liveDate: opts.liveDate };
  }
  if (!opts.liveSession) return null;
  return ids.length > 0
    ? { mode: 'session', liveDate: opts.liveDate, liveSession: opts.liveSession, productIds: [...ids] }
    : { mode: 'session', liveDate: opts.liveDate, liveSession: opts.liveSession };
}

/* eslint-enable react-refresh/only-export-components */

const SOURCE_TABS: { mode: SourceMode; label: string; hint: string }[] = [
  { mode: 'auto', label: '自動揀貨', hint: '由本週向過去逐週搵最少 2 件從未用過嘅合資格商品' },
  { mode: 'week', label: '指定星期', hint: '揀其中一週（香港時間週一起計）嘅直播商品' },
  { mode: 'date', label: '指定日期', hint: '揀其中一日嘅全部直播商品（包括所有場次）' },
  { mode: 'session', label: '指定場次', hint: '揀其中一日嘅其中一場直播商品' },
  { mode: 'products', label: '指定商品', hint: '搜尋全部商品（普通＋直播），人手揀最少 2 件，唔設上限' },
];

const EMPTY_COPY: Record<SourceMode, string> = {
  auto: '而家冇任何星期有最少 2 件從未用過嘅合資格商品——可以改用指定商品搜尋。',
  week: '呢個星期暫時冇直播商品。',
  date: '呢一日暫時冇直播商品。',
  session: '呢個場次暫時冇商品。',
  products: '搵唔到商品——試下其他關鍵字。',
};

function CreateArticleCard({ toast, onCreated }: { toast: Toast; onCreated: (id: number) => void }) {
  const utils = trpc.useUtils();
  const contract = trpc.gloGuideAdmin as unknown as GloGuideSourceContract;
  const [mode, setMode] = useState<SourceMode>('auto');
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [dateSel, setDateSel] = useState<string | null>(null);
  const [sessionSel, setSessionSel] = useState<string | null>(null); // `${liveDate}|${liveSession}`
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [themeHint, setThemeHint] = useState('');
  const generate = contract.generate.useMutation();
  const busy = generate.isPending;

  // 真實來源選項（server 重查 DB；staff 可查）
  const sourcesQ = contract.productSources.useQuery(undefined, { refetchOnWindowFocus: false });
  const weeks = sourcesQ.data?.weeks ?? [];
  const dates = sourcesQ.data?.dates ?? [];
  const sessions = sourcesQ.data?.sessions ?? [];
  const activeWeek = mode === 'week' ? (weekStart ?? weeks[0]?.weekStart ?? null) : null;
  const activeDate = mode === 'date' ? (dateSel ?? dates[0]?.liveDate ?? null) : null;
  const activeSession = useMemo(() => {
    if (mode !== 'session') return null;
    const raw = sessionSel ?? (sessions[0] ? `${sessions[0].liveDate}|${sessions[0].liveSession}` : null);
    if (!raw) return null;
    const [liveDate, liveSession] = raw.split('|');
    return liveDate && liveSession ? { liveDate, liveSession } : null;
  }, [mode, sessionSel, sessions]);

  const filter: GloGuideProductFilter | null =
    mode === 'auto'
      ? { mode: 'auto' }
      : mode === 'week'
        ? activeWeek
          ? { mode: 'week', weekStart: activeWeek }
          : null
        : mode === 'date'
          ? activeDate
            ? { mode: 'date', liveDate: activeDate }
            : null
          : mode === 'session'
            ? activeSession
              ? { mode: 'session', liveDate: activeSession.liveDate, liveSession: activeSession.liveSession }
              : null
            : searchQueryOk(searchQuery)
              ? { mode: 'search', query: searchQuery.trim() }
              : null;

  const productsQ = contract.products.useQuery(filter ?? { mode: 'auto' }, {
    enabled: filter !== null,
    refetchOnWindowFocus: false,
  });

  // 換來源（方式／星期／日期／場次／搜尋字）→ 已揀商品即清空：productIds 一定要屬於當前來源
  useEffect(() => {
    setSelected([]);
  }, [mode, activeWeek, activeDate, activeSession?.liveDate, activeSession?.liveSession, searchQuery]);

  const toggle = (p: SourceProduct) => {
    if (productBlockReason(p)) return;
    setSelected((prev) => {
      if (prev.includes(p.id)) return prev.filter((x) => x !== p.id);
      return [...prev, p.id];
    });
  };

  const selection = buildGenerateSelection(mode, {
    weekStart: activeWeek,
    liveDate: mode === 'date' ? activeDate : (activeSession?.liveDate ?? null),
    liveSession: activeSession?.liveSession ?? null,
    productIds: selected,
  });

  const run = async () => {
    // busy 防重複：生成中再撳一律忽略（掣本身亦 disabled）
    if (busy || !selection) return;
    try {
      // 只送 selection＋themeHint——SPEC：同時送 top-level productIds 會 400
      const out = await generate.mutateAsync({
        selection,
        themeHint: themeHint.trim() || undefined,
      });
      toast('已開始生成文章＋配搭圖，完成後會自動更新', 'success');
      setSelected([]);
      setThemeHint('');
      await utils.gloGuideAdmin.articles.invalidate();
      // 用咗嘅商品要即時反映「已用過」→ invalidate 選貨 queries（後端落地後生效）
      const extra = utils.gloGuideAdmin as unknown as {
        products?: { invalidate?: () => Promise<unknown> };
        productSources?: { invalidate?: () => Promise<unknown> };
      };
      await Promise.all([extra.products?.invalidate?.(), extra.productSources?.invalidate?.()]);
      onCreated(out.id);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const renderSourcePicker = () => {
    if (mode === 'auto') {
      return (
        <p className="ggp-sub">
          自動揀貨：由本週開始向上星期、上上星期逐週搵，搵到最少 2 件從未用過嘅合資格商品就用嗰週；
          生成嗰刻 server 會喺嗰週合資格池隨機抽 2–3 件——下面只係合資格隨機池示例預覽（只讀，唔使揀），
          唔係實際必中名單；唔會暗中改用其他來源。
        </p>
      );
    }
    if (sourcesQ.isLoading) return <p className="ggp-sub">載入來源選項中…</p>;
    if (sourcesQ.isError) {
      return (
        <div>
          <p className="ggp-error" role="alert">
            載入來源選項失敗：{sourcesQ.error?.message ?? '請再試'}
          </p>
          <button type="button" className="ggp-btn ggp-btn-ghost" onClick={() => void sourcesQ.refetch()}>
            重試
          </button>
        </div>
      );
    }
    if (mode === 'week') {
      if (weeks.length === 0) return <p className="ggp-empty">暫時冇有直播商品嘅星期可以揀。</p>;
      return (
        <div>
          <label className="ggp-label" htmlFor="ggp-week">
            揀星期（香港時間，週一至週日）
          </label>
          <select
            id="ggp-week"
            className="ggp-input"
            value={activeWeek ?? ''}
            disabled={busy}
            onChange={(e) => setWeekStart(e.target.value)}
          >
            {weeks.map((w) => (
              <option key={w.weekStart} value={w.weekStart}>
                {w.weekStart} – {w.weekEnd}（可揀 {w.eligible}/{w.total} 件）
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (mode === 'date') {
      if (dates.length === 0) return <p className="ggp-empty">暫時冇有商品嘅直播日期可以揀。</p>;
      return (
        <div>
          <label className="ggp-label" htmlFor="ggp-date">
            揀直播日期（包括當日全部場次）
          </label>
          <select
            id="ggp-date"
            className="ggp-input"
            value={activeDate ?? ''}
            disabled={busy}
            onChange={(e) => setDateSel(e.target.value)}
          >
            {dates.map((d) => (
              <option key={d.liveDate} value={d.liveDate}>
                直播 {d.liveDate}・全部場次（可揀 {d.eligible}/{d.total} 件）
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (mode === 'session') {
      if (sessions.length === 0) return <p className="ggp-empty">暫時冇有商品嘅直播場次可以揀。</p>;
      const sessionValue = activeSession ? `${activeSession.liveDate}|${activeSession.liveSession}` : '';
      return (
        <div>
          <label className="ggp-label" htmlFor="ggp-session">
            揀直播日期＋場次
          </label>
          <select
            id="ggp-session"
            className="ggp-input"
            value={sessionValue}
            disabled={busy}
            onChange={(e) => setSessionSel(e.target.value)}
          >
            {sessions.map((s) => (
              <option key={`${s.liveDate}|${s.liveSession}`} value={`${s.liveDate}|${s.liveSession}`}>
                直播 {s.liveDate}・第 {s.liveSession} 場（可揀 {s.eligible}/{s.total} 件）
              </option>
            ))}
          </select>
        </div>
      );
    }
    // products：真商品搜尋（普通＋直播商品；1–60 字）
    return (
      <form
        className="ggp-search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = searchText.trim();
          if (searchQueryOk(q)) setSearchQuery(q);
        }}
      >
        <label className="ggp-label" htmlFor="ggp-product-search">
          商品搜尋（名稱關鍵字，1–60 字）
        </label>
        <div className="ggp-search-row">
          <input
            id="ggp-product-search"
            className="ggp-input"
            value={searchText}
            maxLength={60}
            disabled={busy}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="例如：蕾絲、牛仔褸"
          />
          <button type="submit" className="ggp-btn" disabled={busy || !searchQueryOk(searchText)}>
            搜尋
          </button>
        </div>
      </form>
    );
  };

  const renderProducts = () => {
    if (!filter) {
      return <p className="ggp-sub">輸入關鍵字撳「搜尋」，由全部商品（普通＋直播）人手揀最少 2 件，唔設上限。</p>;
    }
    if (productsQ.isLoading) return <p className="ggp-sub">載入商品中…</p>;
    if (productsQ.isError) {
      return (
        <div>
          <p className="ggp-error" role="alert">
            載入商品失敗：{productsQ.error?.message ?? '請再試'}
          </p>
          <button type="button" className="ggp-btn ggp-btn-ghost" onClick={() => void productsQ.refetch()}>
            重試
          </button>
        </div>
      );
    }
    const items = productsQ.data?.items ?? [];
    if (items.length === 0) return <p className="ggp-empty">{EMPTY_COPY[mode]}</p>;
    // auto：只讀預覽——合資格隨機池示例（首 3 件只供參考）；server 生成嗰刻先真正隨機抽 2–3 件，唔係實際必中名單
    if (mode === 'auto') {
      const picks = items.filter((p) => productBlockReason(p) === null).slice(0, 3);
      if (picks.length < 2) return <p className="ggp-empty">{EMPTY_COPY.auto}</p>;
      return (
        <>
          <p className="ggp-sub">
            預覽：合資格隨機池示例（以下首 {picks.length} 件只供參考）；實際生成嗰刻 server 會由最近有貨嘅星期嘅合資格池隨機抽 2–3 件，呢啲唔係必中名單：
          </p>
          <div className="ggp-product-grid" role="list" aria-label="自動揀貨預覽">
            {picks.map((p) => (
              <div key={p.id} className="ggp-product ggp-product-static" role="listitem">
                {/* 商品原圖係公開授權商品圖，可以直接顯示 */}
                <img src={p.image} alt={p.name} loading="lazy" />
                <span className="ggp-product-name">{p.name}</span>
                <span className="ggp-product-meta">貨號 {p.sku?.trim() || '未填'}</span>
                <span className="ggp-product-price">
                  {fmtHKD(p.discountPrice ?? p.price)}
                  {p.aiTags.length > 0 ? ` · ${p.aiTags.slice(0, 3).join('／')}` : ''}
                </span>
                {(p.liveDate || p.liveSession) && (
                  <span className="ggp-product-meta">
                    直播 {p.liveDate ?? '—'}
                    {p.liveSession ? `・第 ${p.liveSession} 場` : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      );
    }
    return (
      <div className="ggp-product-grid">
        {items.map((p) => {
          const active = selected.includes(p.id);
          const blocked = productBlockReason(p);
          return (
            <button
              key={p.id}
              type="button"
              className="ggp-product"
              aria-pressed={active}
              disabled={busy || blocked !== null}
              onClick={() => toggle(p)}
            >
              {active && (
                <span className="ggp-product-check" aria-hidden="true">
                  <Check size={14} />
                </span>
              )}
              {/* 商品原圖係公開授權商品圖，可以直接顯示 */}
              <img src={p.image} alt={p.name} loading="lazy" />
              <span className="ggp-product-name">{p.name}</span>
              <span className="ggp-product-price">
                {fmtHKD(p.discountPrice ?? p.price)}
                {p.aiTags.length > 0 ? ` · ${p.aiTags.slice(0, 3).join('／')}` : ''}
              </span>
              {(p.liveDate || p.liveSession) && (
                <span className="ggp-product-meta">
                  直播 {p.liveDate ?? '—'}
                  {p.liveSession ? `・第 ${p.liveSession} 場` : ''}
                </span>
              )}
              {blocked !== null && <span className="ggp-product-block">{blocked}</span>}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <section className="ggp-card" aria-label="新增精選文章">
      <h3 className="ggp-section-title">新增文章（揀選貨來源同商品）</h3>
      <p className="ggp-sub">
        人手揀貨最少 2 件、唔設上限；自動或來源隨機先維持 2–3 件。曾經出現喺任何指南嘅商品會永久鎖定，server 生成時會再驗證一次。
      </p>
      <div className="ggp-filters" role="group" aria-label="選貨方式">
        {SOURCE_TABS.map((t) => (
          <button
            key={t.mode}
            type="button"
            className="ggp-chip"
            aria-pressed={mode === t.mode}
            disabled={busy}
            onClick={() => setMode(t.mode)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="ggp-sub">{SOURCE_TABS.find((t) => t.mode === mode)?.hint}</p>

      {renderSourcePicker()}
      <div style={{ marginTop: 12 }}>{renderProducts()}</div>

      <div style={{ marginTop: 12 }}>
        <label className="ggp-label" htmlFor="ggp-theme-hint">
          主題提示（選填，例如「轉季 layering」）
        </label>
        <input
          id="ggp-theme-hint"
          className="ggp-input"
          value={themeHint}
          maxLength={120}
          onChange={(e) => setThemeHint(e.target.value)}
          placeholder="留空由 Glo Glo 自由發揮"
          disabled={busy}
        />
      </div>
      <div className="ggp-actions" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="ggp-btn ggp-btn-primary"
          disabled={busy || !selection}
          onClick={() => void run()}
        >
          {busy ? <Loader2 size={16} className="ggp-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
          產生文章＋相{selected.length > 0 ? `（已揀 ${selected.length} 件）` : ''}
        </button>
      </div>
      {mode === 'products' && selected.length < 2 && (
        <p className="ggp-sub" style={{ marginTop: 8 }} role="status">
          指定商品要揀最少 2 件先可以產生，唔設上限。
        </p>
      )}
      {(mode === 'week' || mode === 'date' || mode === 'session') && selected.length === 0 && (
        <p className="ggp-sub" style={{ marginTop: 8 }} role="status">
          唔揀商品會由呢個來源嘅合資格池隨機抽 2–3 件；唔會改用其他星期／日期／場次。
        </p>
      )}
      {(mode === 'week' || mode === 'date' || mode === 'session') && selected.length === 1 && (
        <p className="ggp-sub" style={{ marginTop: 8 }} role="status">
          人手揀最少 2 件、唔設上限（或者唔揀，由來源合資格池隨機抽 2–3 件）。
        </p>
      )}
    </section>
  );
}

// ──────────────────────────── 模特兒原圖管理（真實授權相，絕不公開）────────────────────────────

/**
 * 單張模特兒原圖：JWT base64 預覽（原圖冇公開 URL）＋設預設／刪除。
 * 刪除係軟刪留審計；預設被刪後端會自動升最早嘅備用相做預設。
 */
function ModelImageThumb({
  item,
  disabled,
  toast,
  onChanged,
}: {
  item: ModelImageItem;
  disabled: boolean;
  toast: Toast;
  onChanged: () => Promise<void>;
}) {
  const readQ = trpc.gloGuideAdmin.modelImageRead.useQuery(
    { id: item.id },
    { staleTime: 5 * 60_000, retry: 1 },
  );
  const defaultMut = trpc.gloGuideAdmin.modelImageSetDefault.useMutation();
  const deleteMut = trpc.gloGuideAdmin.modelImageDelete.useMutation();
  const busy = disabled || defaultMut.isPending || deleteMut.isPending;
  const src = readQ.data ? `data:${readQ.data.mime};base64,${readQ.data.dataBase64}` : null;

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      toast(okMsg, 'success');
      await onChanged();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="ggp-image-card">
      {readQ.isLoading ? (
        <div className="ggp-image-placeholder">載入預覽中…</div>
      ) : readQ.isError || !src ? (
        <div className="ggp-image-placeholder" role="alert">
          預覽失敗
          <button type="button" className="ggp-btn ggp-btn-ghost ggp-btn-sm" onClick={() => void readQ.refetch()}>
            重試
          </button>
        </div>
      ) : (
        <img src={src} alt={`模特兒原圖 ${item.id}`} loading="lazy" />
      )}
      <div className="ggp-badges">
        {item.isDefault ? (
          <Badge label="預設・新文章用呢張" tone="gold" />
        ) : (
          <Badge label="備用" tone="default" />
        )}
      </div>
      <p className="ggp-sub" style={{ margin: 0 }}>
        {item.width}×{item.height}
        {item.createdByName ? `・${item.createdByName}` : ''}・{fmtDateTime(item.createdAt)}
      </p>
      <div className="ggp-image-actions">
        {!item.isDefault && (
          <button
            type="button"
            className="ggp-btn ggp-btn-sm"
            disabled={busy}
            onClick={() =>
              void act(
                () => defaultMut.mutateAsync({ id: item.id }),
                '已設為預設——之後新建文章用呢張；舊文章保留當初快照',
              )
            }
          >
            <Check size={13} aria-hidden="true" /> 設為預設
          </button>
        )}
        <button
          type="button"
          className="ggp-btn ggp-btn-danger ggp-btn-sm"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                '確定刪除呢張原圖？已生成／已上架文章保留當初快照，唔受影響；刪除會留審計紀錄。',
              )
            ) {
              void act(() => deleteMut.mutateAsync({ id: item.id }), '已刪除原圖');
            }
          }}
        >
          <Trash2 size={13} aria-hidden="true" /> 刪除
        </button>
      </div>
    </div>
  );
}

/**
 * 模特兒原圖管理卡：
 * ─ Fashn 生成配搭圖每次淨係用一張＝預設嗰張；其他相係備用；
 * ─ 新建文章用當刻預設相做快照；舊文章（包括已上架）保留當初快照，唔受呢度改動影響；
 * ─ 原圖絕不公開：冇公開 URL，預覽只限員工登入後台（JWT base64）；
 * ─ 最多 8 張；JPEG／PNG／WebP，每張 ≤10MB（server 用 sharp 驗真圖再 re-encode）。
 */
function ModelImagesCard({ toast }: { toast: Toast }) {
  const utils = trpc.useUtils();
  const q = trpc.gloGuideAdmin.modelImages.useQuery(undefined, { refetchOnWindowFocus: false });
  const uploadMut = trpc.gloGuideAdmin.modelImageUpload.useMutation();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const items = q.data?.items ?? [];
  const maxCount = q.data?.maxCount ?? 8;
  const full = items.length >= maxCount;
  const busy = uploadMut.isPending;

  const refresh = async () => {
    await utils.gloGuideAdmin.modelImages.invalidate();
  };

  const onFile = (file: File) => {
    if (full) {
      toast(`最多 ${maxCount} 張模特兒原圖，請先刪除舊相`, 'error');
      return;
    }
    const err = validateUploadFile(file);
    if (err) {
      toast(err, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast('讀檔失敗，請再試', 'error');
    reader.onload = () => {
      const base64 = dataUrlToBase64(String(reader.result ?? ''));
      if (!base64) {
        toast('讀檔失敗，請再試', 'error');
        return;
      }
      void (async () => {
        try {
          await uploadMut.mutateAsync({ filename: file.name, mime: file.type, dataBase64: base64 });
          toast('已上傳模特兒原圖', 'success');
          await refresh();
        } catch (e) {
          toast(errMsg(e), 'error');
        }
      })();
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="ggp-card" aria-label="模特兒原圖">
      <h3 className="ggp-section-title">
        模特兒原圖（{items.length}/{maxCount}）
      </h3>
      <p className="ggp-sub">
        Fashn 生成配搭圖每次淨係用一張＝預設嗰張；其他相係備用。新建文章會用當刻預設相；
        已生成／已上架文章保留當初快照，唔受呢度改動影響。原圖絕不公開，預覽只限員工後台。
        只支援 JPEG／PNG／WebP，每張 ≤10MB。
      </p>
      <p className="ggp-notice" role="note">
        授權規矩（唔可繞過）：只可以上傳真實、已獲授權嘅模特兒照片；唔好用 AI 合成圖當原圖。
      </p>
      {q.isLoading ? (
        <p className="ggp-sub">載入模特兒原圖中…</p>
      ) : q.isError ? (
        <div>
          <p className="ggp-error" role="alert">
            載入模特兒原圖失敗：{q.error.message}
          </p>
          <button type="button" className="ggp-btn ggp-btn-ghost" onClick={() => void q.refetch()}>
            重試
          </button>
        </div>
      ) : (
        <>
          {q.data && q.data.effective.source === 'env' && (
            <p className="ggp-notice" role="note">
              而家冇已上傳模特兒原圖——新建文章會沿用內建預設 {q.data.fallback.ref}
              。上傳第一張真實授權相之後，新文章就會改用佢（第一張自動做預設）。
            </p>
          )}
          {items.length > 0 && (
            <div className="ggp-image-grid">
              {items.map((item) => (
                <ModelImageThumb key={item.id} item={item} disabled={busy} toast={toast} onChanged={refresh} />
              ))}
            </div>
          )}
          <div className="ggp-actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="ggp-btn"
              disabled={busy || full}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? (
                <Loader2 size={15} className="ggp-spin" aria-hidden="true" />
              ) : (
                <Upload size={15} aria-hidden="true" />
              )}
              上傳原圖
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = '';
              }}
            />
          </div>
          {full && (
            <p className="ggp-sub" style={{ marginTop: 8 }} role="status">
              已達 {maxCount} 張上限，請先刪除舊相先可以再上傳。
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ──────────────────────────── 已揀商品審批對照卡 ────────────────────────────

/**
 * 已揀商品卡（審批用後台資料）：現行商品原圖（商品被刪就回落生成當刻 snapshot）、
 * 名、類別、原價／折扣價、庫存、直播日期／場次、已批准標籤；
 * 商品原圖同生成嗰刻唔同（imageDrifted）會明確提示要重生對應配搭圖。
 */
function PickedProductCard({ item }: { item: GuideProduct }) {
  const cur = item.current;
  const img = cur?.image ?? item.sourceImageSnapshot ?? null;
  const name = cur?.name ?? item.productNameSnapshot ?? `商品 #${item.productId}`;
  return (
    <div className="ggp-pick-card">
      {img ? (
        <img src={img} alt={`${name} 原圖`} loading="lazy" />
      ) : (
        <div className="ggp-image-placeholder">冇原圖</div>
      )}
      <div className="ggp-pick-body">
        <span className="ggp-product-name">{name}</span>
        <div className="ggp-badges">
          {cur && <Badge label={productCategoryLabel(cur.category)} tone="lavender" />}
          {!cur && <Badge label="商品已刪除" tone="pink" />}
          {cur && !cur.isActive && <Badge label="已下架" tone="pink" />}
          {cur && cur.stock <= 0 && <Badge label="缺貨" tone="pink" />}
          {item.imageDrifted && <Badge label="原圖已改" tone="pink" />}
        </div>
        {cur && (
          <>
            <span className="ggp-product-price">
              {cur.discountPrice !== null && cur.discountPrice !== undefined ? (
                <>
                  {fmtHKD(cur.discountPrice)} <s className="ggp-pick-was">{fmtHKD(cur.price)}</s>
                </>
              ) : (
                fmtHKD(cur.price)
              )}
            </span>
            <span className="ggp-pick-meta">貨號 {cur.sku?.trim() || '未填'}</span>
            <span className="ggp-pick-meta">庫存 {cur.stock}</span>
            {(cur.liveDate || cur.liveSession) && (
              <span className="ggp-pick-meta">
                直播 {cur.liveDate ?? '—'}
                {cur.liveSession ? `・第 ${cur.liveSession} 場` : ''}
              </span>
            )}
            {cur.aiTags.length > 0 && (
              <span className="ggp-pick-meta">已批標籤：{cur.aiTags.join('／')}</span>
            )}
          </>
        )}
        {item.imageDrifted && (
          <p className="ggp-pick-warn" role="note">
            商品原圖同生成嗰刻唔同——對應配搭圖要重生先過到發布閘。
          </p>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────── 富文本編輯器（toolbar＋字數＋即時預覽）────────────────────────────

const TOOLBAR: { tag: GloGuideRichTag; label: string; className?: string; hint: string }[] = [
  { tag: 'b', label: 'B', hint: '粗體' },
  { tag: 'gold', label: '金', className: 'ggp-tool-gold', hint: '金黃色' },
  { tag: 'pink', label: '粉', className: 'ggp-tool-pink', hint: '粉紅色' },
  { tag: 'tag', label: '重點', hint: '重點標籤' },
];

function BodyEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const count = plainBodyCharCount(value);
  const ok = bodyCountOk(count);
  const parsed = useMemo(() => parseGloGuideRichText(value), [value]);
  const [showPreview, setShowPreview] = useState(true);

  const applyTag = (tag: GloGuideRichTag) => {
    const el = ref.current;
    if (!el) return;
    const wrapped = wrapGloGuideSelection(value, el.selectionStart, el.selectionEnd, tag);
    if (wrapped.value === value) return;
    onChange(wrapped.value);
    // 還原 selection 包住原本嗰段字，方便連續加格式
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(wrapped.selectionStart, wrapped.selectionEnd);
    });
  };

  return (
    <div>
      <div className="ggp-toolbar" role="toolbar" aria-label="內文格式">
        {TOOLBAR.map((t) => (
          <button
            key={t.tag}
            type="button"
            className={`ggp-tool ${t.className ?? ''}`.trim()}
            disabled={disabled}
            title={`揀咗文字再撳：${t.hint}`}
            aria-label={t.hint}
            onClick={() => applyTag(t.tag)}
          >
            {t.tag === 'b' ? <Bold size={15} aria-hidden="true" /> : t.label}
          </button>
        ))}
        <button
          type="button"
          className="ggp-tool"
          aria-pressed={showPreview}
          onClick={() => setShowPreview((v) => !v)}
        >
          {showPreview ? '收埋預覽' : '顯示預覽'}
        </button>
      </div>
      <textarea
        ref={ref}
        className="ggp-textarea"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label="文章內文"
      />
      <p className="ggp-count" data-ok={ok} role="status">
        純文字 {count} 字（要 {BODY_MIN}–{BODY_MAX} 字，空白／格式標記唔計）
      </p>
      {parsed.error && (
        <p className="ggp-preview-error" role="alert">
          格式錯誤：{parsed.error}
        </p>
      )}
      {showPreview && (
        <div className="ggp-preview" aria-label="內文預覽">
          <GloGuideRichText body={value} />
        </div>
      )}
    </div>
  );
}

// ──────────────────────────── 單張圖（authenticated base64 預覽＋逐圖操作）────────────────────────────

function ImageCard({
  article,
  image,
  disabled,
  canReview,
  toast,
}: {
  article: GuideArticle;
  image: GuideImage;
  disabled: boolean;
  /** 逐圖審批係主管權限（後端 supervisorProcedure）；staff 只見重生／刪除 */
  canReview: boolean;
  toast: Toast;
}) {
  const utils = trpc.useUtils();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const readQ = trpc.gloGuideAdmin.imageRead.useQuery(
    { id: article.id, imageId: image.id },
    { enabled: image.status === 'completed', staleTime: 5 * 60_000, retry: 1 },
  );
  const genMut = trpc.gloGuideAdmin.imageGenerate.useMutation();
  const delMut = trpc.gloGuideAdmin.imageDelete.useMutation();
  const reviewMut = trpc.gloGuideAdmin.imageReview.useMutation();
  const busy = genMut.isPending || delMut.isPending || reviewMut.isPending;
  const imgDisabled = disabled || busy || image.status === 'queued' || image.status === 'processing';

  const refresh = async () => {
    await Promise.all([
      utils.gloGuideAdmin.articles.invalidate(),
      utils.gloGuideAdmin.imageRead.invalidate({ id: article.id, imageId: image.id }),
    ]);
  };

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      toast(okMsg, 'success');
      await refresh();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const src = readQ.data ? `data:${readQ.data.mime};base64,${readQ.data.dataBase64}` : null;
  const review = REVIEW_STATUS_META[image.reviewStatus];

  return (
    <div className="ggp-image-card">
      {image.status !== 'completed' ? (
        <div className="ggp-image-placeholder">
          {image.status === 'failed' ? `生成失敗${image.error ? `：${image.error}` : ''}` : '圖片生成中…'}
        </div>
      ) : readQ.isLoading ? (
        <div className="ggp-image-placeholder">載入預覽中…</div>
      ) : readQ.isError || !src ? (
        <div className="ggp-image-placeholder" role="alert">
          預覽失敗
          <button type="button" className="ggp-btn ggp-btn-ghost ggp-btn-sm" onClick={() => void readQ.refetch()}>
            重試
          </button>
        </div>
      ) : (
        <img src={src} alt={`指南配搭圖 ${image.id}`} loading="lazy" />
      )}
      <div className="ggp-badges">
        <Badge label={IMAGE_STATUS_LABEL[image.status]} tone={image.status === 'failed' ? 'pink' : image.status === 'completed' ? 'green' : 'lavender'} />
        <Badge label={review.label} tone={review.tone} />
        {image.imageDrifted && <Badge label="商品圖已改" tone="pink" />}
      </div>
      {image.reviewedByName && (
        <p className="ggp-sub" style={{ margin: 0 }}>
          {image.reviewedByName} 審過{image.reviewedAt ? `（${fmtDateTime(image.reviewedAt)}）` : ''}
        </p>
      )}
      <div className="ggp-image-actions">
        <button
          type="button"
          className="ggp-btn ggp-btn-sm"
          disabled={imgDisabled}
          onClick={() => void act(() => genMut.mutateAsync({ id: article.id, imageId: image.id }), '已排程重生呢張圖')}
        >
          <RefreshCw size={13} aria-hidden="true" /> 重生
        </button>
        {canReview && image.status === 'completed' && image.reviewStatus !== 'approved' && (
          <button
            type="button"
            className="ggp-btn ggp-btn-sm"
            disabled={imgDisabled}
            onClick={() =>
              void act(
                () => reviewMut.mutateAsync({ id: article.id, imageId: image.id, decision: 'approved' }),
                '已批准呢張圖',
              )
            }
          >
            <Check size={13} aria-hidden="true" /> 批准
          </button>
        )}
        {canReview && image.status === 'completed' && image.reviewStatus !== 'rejected' && (
          <button
            type="button"
            className="ggp-btn ggp-btn-danger ggp-btn-sm"
            disabled={imgDisabled}
            onClick={() => setRejecting((v) => !v)}
          >
            拒絕
          </button>
        )}
        <button
          type="button"
          className="ggp-btn ggp-btn-danger ggp-btn-sm"
          disabled={imgDisabled}
          onClick={() => {
            if (window.confirm('確定刪除呢張圖？（歷史審批會留底）')) {
              void act(() => delMut.mutateAsync({ id: article.id, imageId: image.id }), '已刪除圖片');
            }
          }}
        >
          <Trash2 size={13} aria-hidden="true" /> 刪除
        </button>
      </div>
      {rejecting && (
        <div className="ggp-inline-form">
          <label className="ggp-label" htmlFor={`ggp-img-note-${image.id}`}>
            拒絕原因（必填）
          </label>
          <textarea
            id={`ggp-img-note-${image.id}`}
            className="ggp-textarea"
            style={{ minHeight: 72 }}
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="ggp-actions">
            <button
              type="button"
              className="ggp-btn ggp-btn-danger ggp-btn-sm"
              disabled={busy || !note.trim()}
              onClick={() =>
                void act(async () => {
                  await reviewMut.mutateAsync({
                    id: article.id,
                    imageId: image.id,
                    decision: 'rejected',
                    note: note.trim(),
                  });
                  setRejecting(false);
                  setNote('');
                }, '已拒絕呢張圖')
              }
            >
              確認拒絕
            </button>
            <button type="button" className="ggp-btn ggp-btn-ghost ggp-btn-sm" onClick={() => setRejecting(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────── 文章卡（list item＋inline 展開編輯）────────────────────────────

function ArticleCard({
  article,
  expanded,
  onToggle,
  canReview,
  toast,
}: {
  article: GuideArticle;
  expanded: boolean;
  onToggle: () => void;
  canReview: boolean;
  toast: Toast;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState({ title: article.title, theme: article.theme, body: article.body });
  const [dirty, setDirty] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [uploadProductId, setUploadProductId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 後台生成完成／外人改咗 → 冇未儲存改動就先同步最新內容落 editor
  useEffect(() => {
    if (!dirty) {
      setDraft({ title: article.title, theme: article.theme, body: article.body });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.updatedAt, article.id]);

  const updateMut = trpc.gloGuideAdmin.update.useMutation();
  const regenMut = trpc.gloGuideAdmin.regenerate.useMutation();
  const submitMut = trpc.gloGuideAdmin.submit.useMutation();
  const approveMut = trpc.gloGuideAdmin.approve.useMutation();
  const rejectMut = trpc.gloGuideAdmin.reject.useMutation();
  const archiveMut = trpc.gloGuideAdmin.archive.useMutation();
  const imgGenMut = trpc.gloGuideAdmin.imageGenerate.useMutation();
  const uploadMut = trpc.gloGuideAdmin.imageUpload.useMutation();

  const busy =
    updateMut.isPending ||
    regenMut.isPending ||
    submitMut.isPending ||
    approveMut.isPending ||
    rejectMut.isPending ||
    archiveMut.isPending ||
    imgGenMut.isPending ||
    uploadMut.isPending;

  const generating = isGenerating(article);
  const editable = canEditArticle(article);
  const statusMeta = STATUS_META[article.status as GuideStatus] ?? { label: article.status, tone: 'default' };
  const liveImages = article.images;

  const refresh = async () => {
    await utils.gloGuideAdmin.articles.invalidate();
  };

  const act = async (fn: () => Promise<unknown>, okMsg: string, kind: ToastKind = 'success') => {
    try {
      await fn();
      toast(okMsg, kind);
      await refresh();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const save = () =>
    act(async () => {
      await updateMut.mutateAsync({ id: article.id, ...draft });
      setDirty(false);
    }, '已儲存（狀態重置做草稿，圖片要重新逐張審）');

  const pickedProductId = uploadProductId ?? article.products[0]?.productId ?? null;

  const onUploadFile = (file: File) => {
    const productId = pickedProductId;
    if (!productId) {
      toast('呢篇指南冇已連結商品，唔可以上傳圖', 'error');
      return;
    }
    const err = validateUploadFile(file);
    if (err) {
      toast(err, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast('讀檔失敗，請再試', 'error');
    reader.onload = () => {
      const base64 = dataUrlToBase64(String(reader.result ?? ''));
      if (!base64) {
        toast('讀檔失敗，請再試', 'error');
        return;
      }
      void act(
        () =>
          uploadMut.mutateAsync({
            id: article.id,
            productId,
            filename: file.name,
            mime: file.type,
            dataBase64: base64,
          }),
        '已上傳圖片（待逐張審批）',
      );
    };
    reader.readAsDataURL(file);
  };

  return (
    <article className="ggp-card ggp-article">
      <div className="ggp-article-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="ggp-article-title">{article.title}</h3>
          <div className="ggp-article-meta">
            <span>主題：{article.theme}</span>
            <span>更新：{fmtDateTime(article.updatedAt)}</span>
            <span>{article.createdByName ? `by ${article.createdByName}` : ''}</span>
          </div>
        </div>
        <button
          type="button"
          className="ggp-btn ggp-btn-ghost ggp-btn-sm"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
          {expanded ? '收埋' : '展開'}
        </button>
      </div>
      <div className="ggp-badges">
        <Badge label={statusMeta.label} tone={statusMeta.tone} />
        <Badge label={article.source === 'auto' ? '系統自動' : '手動'} tone="default" />
        {generating && <Badge label="生成中" tone="lavender" />}
        <Badge
          label={`圖 ${article.summary.imagesApproved}/${article.summary.images} 已批`}
          tone={article.summary.imagesApproved === article.summary.images && article.summary.images > 0 ? 'green' : 'gold'}
        />
        {article.summary.jobsFailed > 0 && <Badge label={`${article.summary.jobsFailed} 個 job 失敗`} tone="pink" />}
      </div>
      {article.status === 'rejected' && article.rejectionReason && (
        <p className="ggp-notice" role="note">
          拒絕原因：{article.rejectionReason}
        </p>
      )}
      {article.generationError && (
        <p className="ggp-error" role="alert">
          生成錯誤:{article.generationError}
        </p>
      )}

      {expanded && (
        <div className="ggp-detail">
          {article.status === 'published' && (
            <p className="ggp-notice" role="note">
              已上架文章唔可以直接改——要改請先由主管／管理員落架，改完再提交審批。
            </p>
          )}
          {generating && (
            <p className="ggp-notice" role="status">
              文章／配搭圖生成中，呢幾秒會自動刷新；完成前先唔好編輯。
            </p>
          )}

          {/* 文字編輯 */}
          <section aria-label="文字內容">
            <h4 className="ggp-section-title">文字內容</h4>
            <label className="ggp-label" htmlFor={`ggp-title-${article.id}`}>
              標題（4–80 字）
            </label>
            <input
              id={`ggp-title-${article.id}`}
              className="ggp-input"
              value={draft.title}
              maxLength={120}
              disabled={!editable || busy}
              onChange={(e) => {
                setDraft((d) => ({ ...d, title: e.target.value }));
                setDirty(true);
              }}
            />
            <label className="ggp-label" htmlFor={`ggp-theme-${article.id}`} style={{ marginTop: 10 }}>
              主題（2–80 字；唔可以撞最近 8 篇）
            </label>
            <input
              id={`ggp-theme-${article.id}`}
              className="ggp-input"
              value={draft.theme}
              maxLength={120}
              disabled={!editable || busy}
              onChange={(e) => {
                setDraft((d) => ({ ...d, theme: e.target.value }));
                setDirty(true);
              }}
            />
            <div style={{ marginTop: 10 }}>
              <BodyEditor
                value={draft.body}
                disabled={!editable || busy}
                onChange={(v) => {
                  setDraft((d) => ({ ...d, body: v }));
                  setDirty(true);
                }}
              />
            </div>
          </section>

          {/* 已揀商品（審批對照卡：原圖／價錢／庫存／直播場次／已批標籤＋原圖 drift 提示） */}
          <section aria-label="已揀商品">
            <h4 className="ggp-section-title">已揀商品（{article.products.length} 件）</h4>
            <div className="ggp-pick-grid">
              {article.products.map((p) => (
                <PickedProductCard key={p.productId} item={p} />
              ))}
            </div>
          </section>

          {/* 圖片：初次每件一張；同事可指定同一商品增加生成，逐張審批 */}
          <section aria-label="配搭圖">
            <h4 className="ggp-section-title">配搭圖（{liveImages.length} 張；每件商品最少一張，全部逐張批准）</h4>
            <p className="ggp-sub">初次生成會每件商品出一張；想多一個 pose 或版本，揀返同一件商品再撳「增加生成」。</p>
            {liveImages.length === 0 && !generating ? (
              <p className="ggp-empty">仲未有圖——揀商品撳「增加生成」或者手動上傳。</p>
            ) : (
              <div className="ggp-image-grid">
                {liveImages.map((img) => (
                  <ImageCard key={imageKey(img)} article={article} image={img} disabled={!editable || busy} canReview={canReview} toast={toast} />
                ))}
              </div>
            )}
            <div className="ggp-actions" style={{ marginTop: 10 }}>
              <select
                className="ggp-input"
                style={{ width: 'auto', minHeight: 44 }}
                aria-label="配搭圖所屬商品"
                value={pickedProductId ?? ''}
                disabled={!editable || busy || article.products.length === 0}
                onChange={(e) => setUploadProductId(Number(e.target.value))}
              >
                {article.products.map((p) => (
                  <option key={p.productId} value={p.productId}>
                    {p.current?.sku?.trim() ? `${p.current.sku}・` : ''}{p.current?.name ?? p.productNameSnapshot}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ggp-btn"
                disabled={!editable || busy || !pickedProductId}
                onClick={() => {
                  if (!pickedProductId) return;
                  void act(
                    () => imgGenMut.mutateAsync({ id: article.id, productId: pickedProductId }),
                    '已排程增加生成呢件商品嘅配搭圖',
                  );
                }}
              >
                <ImagePlus size={15} aria-hidden="true" /> 增加生成
              </button>
              <button
                type="button"
                className="ggp-btn"
                disabled={!editable || busy || !pickedProductId}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={15} aria-hidden="true" /> 上傳圖片
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUploadFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          </section>

          {/* 操作列 */}
          <div className="ggp-actions" style={{ borderTop: '1px solid var(--glass-border, rgba(255,255,255,0.1))', paddingTop: 14 }}>
            <button
              type="button"
              className="ggp-btn ggp-btn-primary"
              disabled={!editable || busy || !dirty}
              onClick={() => void save()}
            >
              儲存修改
            </button>
            <button
              type="button"
              className="ggp-btn"
              disabled={!editable || busy}
              onClick={() => {
                if (window.confirm('重新生成會重寫標題／主題／內文，圖片審批會重置。確定？')) {
                  void act(() => regenMut.mutateAsync({ id: article.id }), '已排程重新生成文章');
                }
              }}
            >
              <RefreshCw size={15} aria-hidden="true" /> 重新生成文章
            </button>
            {canSubmitArticle(article.status) && (
              <button
                type="button"
                className="ggp-btn"
                disabled={busy || generating}
                onClick={() => void act(() => submitMut.mutateAsync({ id: article.id }), '已提交審批')}
              >
                <Send size={15} aria-hidden="true" /> 提交審批
              </button>
            )}
            {canReview && canApproveArticle(article.status) && (
              <>
                <button
                  type="button"
                  className="ggp-btn ggp-btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void act(() => approveMut.mutateAsync({ id: article.id }), '已批准，文章即時上架')
                  }
                >
                  <Check size={15} aria-hidden="true" /> 批准上架
                </button>
                <button
                  type="button"
                  className="ggp-btn ggp-btn-danger"
                  disabled={busy}
                  onClick={() => setRejectOpen((v) => !v)}
                >
                  拒絕
                </button>
              </>
            )}
            {canReview && canArchiveArticle(article.status) && (
              <button
                type="button"
                className="ggp-btn ggp-btn-danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('落架後公開頁即時 404。確定落架？')) {
                    void act(() => archiveMut.mutateAsync({ id: article.id }), '已落架', 'info');
                  }
                }}
              >
                落架
              </button>
            )}
          </div>

          {rejectOpen && canReview && (
            <div className="ggp-inline-form">
              <label className="ggp-label" htmlFor={`ggp-reject-${article.id}`}>
                拒絕原因（必填，會留底俾同事跟進）
              </label>
              <textarea
                id={`ggp-reject-${article.id}`}
                className="ggp-textarea"
                style={{ minHeight: 80 }}
                value={rejectReason}
                maxLength={300}
                onChange={(e) => setRejectReason(e.target.value)}
              />
              <div className="ggp-actions">
                <button
                  type="button"
                  className="ggp-btn ggp-btn-danger"
                  disabled={busy || !rejectReason.trim()}
                  onClick={() =>
                    void act(async () => {
                      await rejectMut.mutateAsync({ id: article.id, reason: rejectReason.trim() });
                      setRejectOpen(false);
                      setRejectReason('');
                    }, '已拒絕', 'info')
                  }
                >
                  確認拒絕
                </button>
                <button type="button" className="ggp-btn ggp-btn-ghost" onClick={() => setRejectOpen(false)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function imageKey(img: GuideImage): string {
  return `${img.id}-v${img.version}-${img.status}-${img.reviewStatus}`;
}

// ──────────────────────────── 主面板 ────────────────────────────

const FILTERS: { value: GuideStatus | undefined; label: string }[] = [
  { value: undefined, label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'pending_review', label: '待審批' },
  { value: 'published', label: '已上架' },
  { value: 'rejected', label: '已拒絕' },
  { value: 'archived', label: '已落架' },
];

export default function GloGuidePanel({
  toast,
  canReview,
  isAdmin = false,
}: {
  toast: Toast;
  canReview: boolean;
  /** 管理員先見到「用量及估算成本」區（admin-only queries；非 admin 唔會發出） */
  isAdmin?: boolean;
}) {
  const [status, setStatus] = useState<GuideStatus | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showModels, setShowModels] = useState(false);

  const articlesQ = trpc.gloGuideAdmin.articles.useQuery(
    { status },
    {
      refetchOnWindowFocus: false,
      // 有生成中嘅文章／圖 job 就自動 poll，完成即停
      refetchInterval: (q) => {
        const items = q.state.data?.items ?? [];
        return items.some((a) => isGenerating(a) || a.summary.jobsActive > 0) ? 6000 : false;
      },
    },
  );
  const items = useMemo(() => articlesQ.data?.items ?? [], [articlesQ.data]);
  const pendingCount = useMemo(
    () => items.filter((a) => a.status === 'pending_review').length,
    [items],
  );

  return (
    <div className="ggp-root">
      <div className="ggp-head">
        <div>
          <h2 className="ggp-title">精選文章</h2>
          <p className="ggp-sub">
            Glo Glo 每週精選配搭：自動逐週揀貨，或者指定星期／日期／場次／直接商品；人手揀最少 2 件、唔設上限，產生文章＋相後提交審批；
            {canReview ? '你係主管／管理員，可以逐圖審批、批准上架、拒絕、落架。' : '主管／管理員逐圖審批＋批准後即時上架。'}
            {pendingCount > 0 ? `而家有 ${pendingCount} 篇待審批。` : ''}
          </p>
        </div>
        <div className="ggp-actions">
          <button
            type="button"
            className="ggp-btn"
            aria-expanded={showModels}
            onClick={() => setShowModels((v) => !v)}
          >
            {showModels ? '收埋模特兒原圖' : '模特兒原圖'}
          </button>
          <button
            type="button"
            className="ggp-btn ggp-btn-primary"
            aria-expanded={showCreate}
            onClick={() => setShowCreate((v) => !v)}
          >
            <Sparkles size={16} aria-hidden="true" />
            {showCreate ? '收埋新增' : '新增文章'}
          </button>
        </div>
      </div>

      {showModels && <ModelImagesCard toast={toast} />}

      {isAdmin && <GloGuideUsagePanel toast={toast} />}

      {showCreate && (
        <CreateArticleCard
          toast={toast}
          onCreated={(id) => {
            setExpandedId(id);
          }}
        />
      )}

      <div className="ggp-filters" role="group" aria-label="狀態篩選">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            className="ggp-chip"
            aria-pressed={status === f.value}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {articlesQ.isLoading ? (
        <p className="ggp-loading">載入文章中…</p>
      ) : articlesQ.isError ? (
        <div className="ggp-error" role="alert">
          <p style={{ margin: 0 }}>載入失敗：{articlesQ.error.message}</p>
          <button
            type="button"
            className="ggp-btn ggp-btn-ghost"
            style={{ marginTop: 12 }}
            onClick={() => void articlesQ.refetch()}
          >
            重試
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="ggp-empty">暫時冇文章——撳上面「新增文章」開始第一篇。</p>
      ) : (
        items.map((a) => (
          <ArticleCard
            key={a.id}
            article={a}
            canReview={canReview}
            toast={toast}
            expanded={expandedId === a.id}
            onToggle={() => setExpandedId((cur) => (cur === a.id ? null : a.id))}
          />
        ))
      )}
    </div>
  );
}
