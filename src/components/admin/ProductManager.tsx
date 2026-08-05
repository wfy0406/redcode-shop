import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";
import { CATEGORY_OPTIONS } from "../../lib/categories";

const MAX_PHOTOS = 10;

type ProductForm = {
  sku: string;
  name: string;
  description: string;
  price: string;
  discountPrice: string;
  sizes: string;
  sizeEnabled: boolean;
  delistEnabled: boolean;
  delistAt: string;
  note: string;
  category: string;
  stock: string;
};

const EMPTY_FORM: ProductForm = {
  sku: "",
  name: "",
  description: "",
  price: "",
  discountPrice: "",
  sizes: "",
  sizeEnabled: true,
  delistEnabled: false,
  delistAt: "",
  note: "",
  category: "other",
  stock: "",
};

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

/** 睇相 lightbox：點相全屏放大（ESC／撳背景閂） */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <img
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }}
      />
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          background: "rgba(255,255,255,0.15)",
          color: "#fff",
          border: "none",
          borderRadius: 999,
          width: 36,
          height: 36,
          fontSize: 18,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>,
    document.body,
  );
}

/** 相簿編輯器：多張相上傳＋拖放排序＋設封面＋刪相（2026-07-28） */
function PhotoAlbumEditor({
  photos,
  onChange,
  uploading,
  setUploading,
  toast,
  onView,
}: {
  photos: string[];
  onChange: (photos: string[]) => void;
  uploading: boolean;
  setUploading: (v: boolean) => void;
  toast: (msg: string) => void;
  onView: (src: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dragIndex = useRef<number | null>(null);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (photos.length + list.length > MAX_PHOTOS) {
      toast(`最多 ${MAX_PHOTOS} 張相`);
      return;
    }
    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const f of list) {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("rc_token") ?? ""}`,
            "x-filename": encodeURIComponent(f.name),
            "content-type": "application/octet-stream",
          },
          body: f,
        });
        if (!res.ok) throw new Error(`上傳失敗 (${res.status})`);
        const data = (await res.json()) as { path: string };
        uploaded.push(data.path);
      }
      onChange([...photos, ...uploaded]);
      toast(`已上傳 ${uploaded.length} 張相`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "上傳失敗");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= photos.length) return;
    const next = [...photos];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2">
        {photos.map((p, i) => (
          <div
            key={p}
            draggable
            onDragStart={() => {
              dragIndex.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex.current !== null && dragIndex.current !== i) {
                move(dragIndex.current, i);
              }
              dragIndex.current = null;
            }}
            className={`relative rounded-lg border-2 ${i === 0 ? "border-pink-400" : "border-stone-200"}`}
          >
            <img
              src={p}
              alt=""
              className="h-20 w-20 cursor-zoom-in rounded-lg object-cover"
              onClick={() => onView(p)}
            />
            {i === 0 && (
              <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-pink-500 px-1.5 text-[10px] text-white">
                封面
              </span>
            )}
            <div className="absolute bottom-0 left-0 right-0 flex justify-center gap-1 rounded-b-lg bg-black/40 py-0.5">
              {i !== 0 && (
                <button
                  type="button"
                  title="設做封面"
                  onClick={() => move(i, 0)}
                  className="text-[10px] text-white hover:text-pink-300"
                >
                  封面
                </button>
              )}
              <button
                type="button"
                title="刪相"
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
                className="text-[10px] text-white hover:text-red-300"
              >
                刪除
              </button>
            </div>
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex h-20 w-20 items-center justify-center rounded-lg border-2 border-dashed border-stone-300 text-2xl text-stone-400 hover:border-stone-400 disabled:opacity-50"
          >
            {uploading ? "…" : "＋"}
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
        }}
      />
      <div className="text-xs text-stone-400">
        最多 {MAX_PHOTOS} 張，第一張做封面；拖放可以排順序
      </div>
    </div>
  );
}

/** 商品表單彈窗（新增／編輯共用；員工提交會轉審批 2026-08-06 Glo 要求） */
function ProductFormModal({
  initial,
  productId,
  initialPhotos,
  onClose,
  toast,
}: {
  initial: ProductForm;
  productId: number | null;
  initialPhotos: string[];
  onClose: () => void;
  toast: (msg: string) => void;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<ProductForm>(initial);
  const [photos, setPhotos] = useState<string[]>(initialPhotos);
  const [uploading, setUploading] = useState(false);
  const [viewImage, setViewImage] = useState<string | null>(null);
  const [error, setError] = useState("");

  const createMut = trpc.products.create.useMutation({
    onSuccess: (r) => {
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 會收到 pendingApproval＋requestId
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("商品已新增");
      }
      void utils.products.adminList.invalidate();
      void utils.products.list.invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const updateMut = trpc.products.update.useMutation({
    onSuccess: (r) => {
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("商品已更新");
      }
      void utils.products.adminList.invalidate();
      void utils.products.list.invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const pending = createMut.isPending || updateMut.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-lg font-bold text-stone-800">
          {productId === null ? "新增商品" : "編輯商品"}
        </h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            if (photos.length === 0) {
              setError("請至少上傳一張相");
              return;
            }
            const base = {
              sku: form.sku.trim(),
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              image: photos[0],
              photos,
              price: Math.round(Number(form.price) * 100),
              discountPrice: form.discountPrice.trim()
                ? Math.round(Number(form.discountPrice) * 100)
                : null,
              sizes: form.sizes.trim() || null,
              sizeEnabled: form.sizeEnabled,
              delistEnabled: form.delistEnabled,
              delistAt: form.delistEnabled && form.delistAt ? new Date(form.delistAt) : null,
              note: form.note.trim() || null,
              category: form.category,
              stock: Number(form.stock) || 0,
            };
            if (productId === null) {
              createMut.mutate(base);
            } else {
              updateMut.mutate({ id: productId, ...base });
            }
          }}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">
              商品相片（{photos.length}/{MAX_PHOTOS}）
            </label>
            <PhotoAlbumEditor
              photos={photos}
              onChange={setPhotos}
              uploading={uploading}
              setUploading={setUploading}
              toast={toast}
              onView={setViewImage}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">SKU</label>
              <input
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                required
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">名稱</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">價錢（$）</label>
              <input
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                type="number"
                min="0"
                step="0.01"
                required
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">
                優惠價（$，選填）
              </label>
              <input
                value={form.discountPrice}
                onChange={(e) => setForm({ ...form, discountPrice: e.target.value })}
                type="number"
                min="0"
                step="0.01"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">
                尺寸（逗號分隔，例如 S,M,L）
              </label>
              <input
                value={form.sizes}
                onChange={(e) => setForm({ ...form, sizes: e.target.value })}
                disabled={!form.sizeEnabled}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">分類</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">庫存</label>
              <input
                value={form.stock}
                onChange={(e) => setForm({ ...form, stock: e.target.value })}
                type="number"
                min="0"
                required
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-600">
                備註（選填，只限後台睇）
              </label>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">描述（選填）</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={form.sizeEnabled}
                onChange={(e) => setForm({ ...form, sizeEnabled: e.target.checked })}
              />
              有尺寸揀
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={form.delistEnabled}
                onChange={(e) => setForm({ ...form, delistEnabled: e.target.checked })}
              />
              定時自動下架
            </label>
            {form.delistEnabled && (
              <input
                value={form.delistAt}
                onChange={(e) => setForm({ ...form, delistAt: e.target.value })}
                type="datetime-local"
                className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
              />
            )}
          </div>

          {error && <div className="text-sm text-red-500">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-stone-200 px-4 py-2 text-sm text-stone-600 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={pending || uploading}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
            >
              {pending ? "儲存中…" : productId === null ? "新增商品" : "儲存更改"}
            </button>
          </div>
        </form>
        {viewImage && <Lightbox src={viewImage} onClose={() => setViewImage(null)} />}
      </div>
    </div>
  );
}

/**
 * 商品管理（員工＋管理員）
 * 列表＋新增/編輯彈窗＋上/下架＋刪除＋補貨；定時下架中嘅貨會標住「已定時下架」
 */
export default function ProductManager({ toast }: { toast: (msg: string) => void }) {
  const listQ = trpc.products.adminList.useQuery();
  const utils = trpc.useUtils();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [viewImage, setViewImage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const updateMut = trpc.products.update.useMutation({
    onSuccess: (r) => {
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 會收到 pendingApproval＋requestId
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("已更新");
      }
      void utils.products.adminList.invalidate();
      void utils.products.list.invalidate();
    },
    onError: (e) => toast(`更新失敗：${e.message}`),
  });

  const removeMut = trpc.products.remove.useMutation({
    onSuccess: (r) => {
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("已刪除");
      }
      setConfirmRemove(null);
      void utils.products.adminList.invalidate();
      void utils.products.list.invalidate();
    },
    onError: (e) => toast(`刪除失敗：${e.message}`),
  });

  const restockMut = trpc.products.restock.useMutation({
    onSuccess: () => {
      toast("庫存已更新");
      void utils.products.adminList.invalidate();
    },
    onError: (e) => toast(`補貨失敗：${e.message}`),
  });

  const editingProduct = (listQ.data ?? []).find((p) => p.id === editing);
  const now = new Date();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-stone-800">商品</h2>
        <button
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700"
        >
          ＋ 新增商品
        </button>
      </div>

      {listQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : (listQ.data ?? []).length === 0 ? (
        <div className="py-20 text-center text-stone-400">暫時冇商品</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">圖片</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">名稱</th>
                <th className="px-3 py-2 font-medium">價錢</th>
                <th className="px-3 py-2 font-medium">庫存</th>
                <th className="px-3 py-2 font-medium">狀態</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(listQ.data ?? []).map((p) => {
                const delisted = p.delistEnabled && p.delistAt && new Date(p.delistAt) <= now;
                return (
                  <tr key={p.id} className="hover:bg-stone-50">
                    <td className="px-3 py-2">
                      <img
                        src={p.image}
                        alt=""
                        className="h-12 w-12 cursor-zoom-in rounded-lg object-cover"
                        onClick={() => setViewImage(p.image)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-stone-600">{p.sku}</td>
                    <td className="px-3 py-2 text-stone-800">
                      {p.name}
                      {p.note && (
                        <div className="text-xs text-stone-400">備註：{p.note}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-stone-600">
                      {p.discountPrice != null ? (
                        <>
                          <span className="mr-1 text-stone-400 line-through">
                            {formatMoney(p.price)}
                          </span>
                          <span className="text-pink-600">{formatMoney(p.discountPrice)}</span>
                        </>
                      ) : (
                        formatMoney(p.price)
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={p.stock <= 5 ? "font-medium text-red-600" : "text-stone-700"}>
                        {p.stock}
                      </span>
                      <button
                        onClick={() => {
                          const input = window.prompt(
                            `「${p.name}」補貨（輸入要加嘅件數，負數＝扣減）：`,
                          );
                          if (input === null) return;
                          const delta = Number(input);
                          if (!Number.isInteger(delta) || delta === 0) {
                            toast("請輸入整數");
                            return;
                          }
                          restockMut.mutate({ id: p.id, delta });
                        }}
                        className="ml-2 text-xs text-stone-400 hover:text-stone-700 hover:underline"
                      >
                        補貨
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      {delisted ? (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-600">
                          已定時下架
                        </span>
                      ) : p.isActive ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                          上架中
                        </span>
                      ) : (
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
                          已下架
                        </span>
                      )}
                      {p.delistEnabled && p.delistAt && !delisted && (
                        <div className="mt-0.5 text-[10px] text-stone-400">
                          {new Date(p.delistAt).toLocaleString()} 落架
                        </div>
                      )}
                    </td>
                    <td className="space-x-2 whitespace-nowrap px-3 py-2">
                      <button
                        onClick={() => {
                          setEditing(p.id);
                          setShowForm(true);
                        }}
                        className="text-xs text-stone-500 hover:underline"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => updateMut.mutate({ id: p.id, isActive: !p.isActive })}
                        className="text-xs text-stone-500 hover:underline"
                      >
                        {p.isActive ? "下架" : "上架"}
                      </button>
                      {confirmRemove === p.id ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            onClick={() => removeMut.mutate({ id: p.id })}
                            className="text-xs font-medium text-red-600 hover:underline"
                          >
                            確定刪除
                          </button>
                          <button
                            onClick={() => setConfirmRemove(null)}
                            className="text-xs text-stone-400 hover:underline"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmRemove(p.id)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          刪除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <ProductFormModal
          initial={
            editingProduct
              ? {
                  sku: editingProduct.sku,
                  name: editingProduct.name,
                  description: editingProduct.description ?? "",
                  price: (editingProduct.price / 100).toFixed(2),
                  discountPrice:
                    editingProduct.discountPrice != null
                      ? (editingProduct.discountPrice / 100).toFixed(2)
                      : "",
                  sizes: editingProduct.sizes ?? "",
                  sizeEnabled: editingProduct.sizeEnabled,
                  delistEnabled: editingProduct.delistEnabled,
                  delistAt: editingProduct.delistAt
                    ? new Date(editingProduct.delistAt).toISOString().slice(0, 16)
                    : "",
                  note: editingProduct.note ?? "",
                  category: editingProduct.category,
                  stock: String(editingProduct.stock),
                }
              : EMPTY_FORM
          }
          productId={editing}
          initialPhotos={
            editingProduct
              ? editingProduct.photos && editingProduct.photos.length > 0
                ? editingProduct.photos
                : [editingProduct.image]
              : []
          }
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          toast={toast}
        />
      )}

      {viewImage && <Lightbox src={viewImage} onClose={() => setViewImage(null)} />}
    </div>
  );
}
