import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { ImagePlus, Save, Trash2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { getToken } from '@/lib/auth';
import { fmtDate } from './format';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 客戶打卡牆（Star Girls）管理 —— praise.adminList / create / update / remove
 * 圖片上傳行現有 POST /api/upload（Bearer JWT + FormData file 欄位，回 {path}）。
 * 每行：圖片預覽 + caption 輸入 + 排序數字 + 上架 toggle + 刪除（兩步確認）。
 */

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type PraiseEntry = {
  id: number;
  image: string;
  caption: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
};

/** 上傳圖片去 /api/upload，回傳伺服器 path */
async function uploadImage(file: File): Promise<string> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? '上傳失敗，請稍後再試');
  }
  const { path } = (await res.json()) as { path: string };
  return path;
}

/* ---------- 單行管理（caption / 排序行內編輯 + 上架 toggle + 刪除） ---------- */
function PraiseRow({
  entry,
  toast,
}: {
  entry: PraiseEntry;
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const [caption, setCaption] = useState(entry.caption ?? '');
  const [sortOrder, setSortOrder] = useState(String(entry.sortOrder));
  const [confirmRemove, setConfirmRemove] = useState(false);

  const updateMutation = trpc.praise.update.useMutation({
    onSuccess: () => {
      toast('已儲存打卡相', 'success');
      void utils.praise.adminList.invalidate();
    },
    onError: (err) => toast(err.message || '儲存失敗', 'error'),
  });

  const removeMutation = trpc.praise.remove.useMutation({
    onSuccess: () => {
      toast('已刪除打卡相', 'info');
      void utils.praise.adminList.invalidate();
    },
    onError: (err) => {
      setConfirmRemove(false);
      toast(err.message || '刪除失敗', 'error');
    },
  });

  const dirty =
    caption.trim() !== (entry.caption ?? '') || sortOrder !== String(entry.sortOrder);

  const save = () => {
    const order = Number.parseInt(sortOrder, 10);
    if (!Number.isInteger(order)) {
      toast('排序要係整數', 'error');
      return;
    }
    updateMutation.mutate({ id: entry.id, caption: caption.trim() || null, sortOrder: order });
  };

  const removing = removeMutation.isPending && confirmRemove;

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border px-4 py-3.5"
      style={{
        borderColor: 'var(--space-line)',
        background: 'var(--space-2)',
        opacity: entry.isActive ? 1 : 0.55,
      }}
    >
      <img
        src={entry.image}
        alt={entry.caption ?? '客戶打卡相'}
        className="h-16 w-16 shrink-0 rounded-lg border object-cover"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--space-0)' }}
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <label className="sr-only" htmlFor={`praise-caption-${entry.id}`}>
          說明文字
        </label>
        <input
          id={`praise-caption-${entry.id}`}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="說明文字（選填，例如：寶寶著身分享 ♡）"
          maxLength={255}
          className={`${inputCls} !h-10`}
        />
        <p className="mt-1 font-mono text-[11px] text-txt-3">
          #{entry.id} · 上傳於 {fmtDate(entry.createdAt)}
        </p>
      </div>
      <div className="w-24 shrink-0">
        <label className="mb-1 block text-[12px] text-txt-3" htmlFor={`praise-order-${entry.id}`}>
          排序
        </label>
        <input
          id={`praise-order-${entry.id}`}
          inputMode="numeric"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          className={`${inputCls} !h-10 font-mono`}
        />
      </div>
      {/* 儲存（有改動先著色） */}
      <button
        type="button"
        disabled={!dirty || updateMutation.isPending}
        onClick={save}
        className="btn btn-secondary shrink-0 !h-10 !w-10 !rounded-full !p-0 disabled:opacity-40"
        aria-label="儲存更改"
      >
        {updateMutation.isPending ? (
          <WishingStar size={14} />
        ) : (
          <Save size={15} aria-hidden="true" />
        )}
      </button>
      {/* 上架 toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={entry.isActive}
        aria-label={`打卡相 #${entry.id} 上架狀態`}
        disabled={updateMutation.isPending}
        onClick={() => updateMutation.mutate({ id: entry.id, isActive: !entry.isActive })}
        className="relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60"
        style={{
          background: entry.isActive ? 'var(--success)' : 'var(--space-4)',
          borderColor: entry.isActive ? 'var(--success)' : 'var(--space-line)',
        }}
      >
        <span
          className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
          style={{
            background: entry.isActive ? 'var(--space-1)' : 'var(--text-3)',
            transform: entry.isActive ? 'translateX(22px)' : 'translateX(2px)',
          }}
          aria-hidden="true"
        />
      </button>
      {/* 刪除（兩步確認） */}
      {confirmRemove ? (
        <button
          type="button"
          disabled={removing}
          onClick={() => removeMutation.mutate({ id: entry.id })}
          className="btn btn-primary shrink-0 !px-4 !py-2 text-[12px] disabled:opacity-60"
        >
          {removing ? <WishingStar size={13} /> : null}
          確認刪除？
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmRemove(true)}
          aria-label={`刪除打卡相 #${entry.id}`}
          className="btn btn-secondary shrink-0 !h-10 !w-10 !rounded-full !p-0"
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/* ---------- 主元件 ---------- */
export default function PraiseManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const listQuery = trpc.praise.adminList.useQuery(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState('');
  const [caption, setCaption] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [uploading, setUploading] = useState(false);

  const createMutation = trpc.praise.create.useMutation({
    onSuccess: () => {
      toast('已加入打卡牆 ♡', 'success');
      setImage('');
      setCaption('');
      setSortOrder('0');
      if (fileRef.current) fileRef.current.value = '';
      void utils.praise.adminList.invalidate();
    },
    onError: (err) => toast(err.message || '新增失敗', 'error'),
  });

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || uploading) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast('只支援 JPG / PNG / WEBP 圖片', 'error');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_SIZE) {
      toast('圖片大過 10MB，請壓縮後再試', 'error');
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const path = await uploadImage(file);
      setImage(path);
      toast('圖片上傳成功', 'success');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : '上傳失敗，請稍後再試', 'error');
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!image) {
      toast('請先上傳圖片', 'error');
      return;
    }
    const order = Number.parseInt(sortOrder, 10);
    createMutation.mutate({
      image,
      caption: caption.trim() || undefined,
      sortOrder: Number.isInteger(order) ? order : 0,
    });
  };

  const entries = (listQuery.data ?? []) as PraiseEntry[];

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
      {/* 左：新增打卡相（5） */}
      <form
        onSubmit={submit}
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6 xl:col-span-5"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
          <ImagePlus size={16} className="text-gold" aria-hidden="true" />
          新增打卡相
        </h3>
        <div className="mt-5 flex flex-col gap-4">
          {/* 圖片上傳 */}
          <div>
            <span className="mb-1.5 block text-[14px] text-txt-2">圖片 *</span>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="flex min-h-[120px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed border-purple-text px-4 py-5 transition-colors duration-200 hover:border-pink disabled:cursor-wait"
            >
              {uploading ? (
                <>
                  <WishingStar size={24} />
                  <span className="text-sm text-txt-2">上傳緊，許願中…</span>
                </>
              ) : image ? (
                <>
                  <img
                    src={image}
                    alt="打卡相預覽"
                    className="h-24 w-24 rounded-xl border border-space-line object-cover"
                  />
                  <span className="text-[13px] text-purple-text">撳呢度換另一張</span>
                </>
              ) : (
                <>
                  <ImagePlus size={24} className="text-purple-text" aria-hidden="true" />
                  <span className="text-sm text-txt-1">撳呢度上傳圖片</span>
                  <span className="text-[12px] text-txt-3">JPG / PNG / WEBP，最大 10MB</span>
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => void onFileChange(e)}
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
          <div>
            <label htmlFor="np-praise-caption" className="mb-1.5 block text-[14px] text-txt-2">
              說明文字（選填）
            </label>
            <input
              id="np-praise-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={255}
              className={inputCls}
              placeholder="例如：寶寶著身分享 ♡"
            />
          </div>
          <div>
            <label htmlFor="np-praise-order" className="mb-1.5 block text-[14px] text-txt-2">
              排序（細數排先）
            </label>
            <input
              id="np-praise-order"
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="0"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={createMutation.isPending || uploading}
          className="btn btn-primary mt-5 w-full disabled:opacity-60"
        >
          {createMutation.isPending ? (
            <WishingStar size={16} />
          ) : (
            <ImagePlus size={16} aria-hidden="true" />
          )}
          加入打卡牆
        </button>
      </form>

      {/* 右：現有打卡相列表（7） */}
      <div className="xl:col-span-7">
        <h3 className="text-[16px] font-bold text-txt-1">
          打卡牆相片
          <span className="ml-2 font-mono text-[13px] font-normal text-txt-3">
            {entries.length} 張
          </span>
        </h3>
        {listQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊相…" />
        ) : entries.length === 0 ? (
          <p className="py-14 text-center text-[14px] text-txt-3">
            未有打卡相，左手邊上傳第一張啦。（前台會暫時顯示預設相）
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {entries.map((entry) => (
              <PraiseRow key={entry.id} entry={entry} toast={toast} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
