import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trpc } from "../../trpc";
import { useAuth } from "../../hooks/useAuth";

const MAX_PHOTOS = 10;

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

export default function PraiseManager({ toast }: { toast: (msg: string) => void }) {
  const { user } = useAuth();
  const listQ = trpc.praise.adminList.useQuery();
  const utils = trpc.useUtils();

  const [image, setImage] = useState("");
  const [caption, setCaption] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [uploading, setUploading] = useState(false);
  const [viewImage, setViewImage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const createMut = trpc.praise.create.useMutation({
    onSuccess: (r) => {
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 會收到 pendingApproval＋requestId
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("已新增");
      }
      setImage("");
      setCaption("");
      setSortOrder("0");
      if (fileRef.current) fileRef.current.value = "";
      void utils.praise.adminList.invalidate();
    },
    onError: (e) => toast(`新增失敗：${e.message}`),
  });

  const updateMut = trpc.praise.update.useMutation({
    onSuccess: (r) => {
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("已更新");
      }
      void utils.praise.adminList.invalidate();
    },
    onError: (e) => toast(`更新失敗：${e.message}`),
  });

  const removeMut = trpc.praise.remove.useMutation({
    onSuccess: (r) => {
      if ("pendingApproval" in r && r.pendingApproval) {
        toast(`已提交審批（#${r.requestId}），等主管/管理員批准`);
      } else {
        toast("已刪除");
      }
      void utils.praise.adminList.invalidate();
    },
    onError: (e) => toast(`刪除失敗：${e.message}`),
  });

  async function uploadFile(file: File): Promise<string> {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("rc_token") ?? ""}`,
        "x-filename": encodeURIComponent(file.name),
        "content-type": "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) throw new Error(`上傳失敗 (${res.status})`);
    const data = (await res.json()) as { path: string };
    return data.path;
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-stone-800">客戶打卡牆</h2>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!image) {
            toast("請上傳相片");
            return;
          }
          createMut.mutate({
            image,
            caption: caption || undefined,
            sortOrder: Number(sortOrder) || 0,
          });
        }}
        className="mb-6 space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setUploading(true);
              try {
                const path = await uploadFile(f);
                setImage(path);
                toast("相片已上傳");
              } catch (err) {
                toast(err instanceof Error ? err.message : "上傳失敗");
              } finally {
                setUploading(false);
              }
            }}
            className="text-sm"
          />
          {uploading && <span className="text-sm text-stone-400">上傳中…</span>}
          {image && (
            <img
              src={image}
              alt=""
              className="h-16 w-16 cursor-zoom-in rounded-lg object-cover"
              onClick={() => setViewImage(image)}
            />
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="說明（選填）"
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="排序（細數排先）"
            type="number"
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={createMut.isPending || uploading}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {createMut.isPending ? "新增中…" : "新增打卡相"}
          </button>
        </div>
      </form>

      {listQ.isLoading ? (
        <div className="py-20 text-center text-stone-400">載入中…</div>
      ) : (listQ.data ?? []).length === 0 ? (
        <div className="py-20 text-center text-stone-400">暫時冇打卡相</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(listQ.data ?? []).map((p) => (
            <div
              key={p.id}
              className={`rounded-xl border p-3 ${p.isActive ? "border-stone-200" : "border-stone-200 bg-stone-50 opacity-60"}`}
            >
              <img
                src={p.image}
                alt=""
                className="mb-2 h-40 w-full cursor-zoom-in rounded-lg object-cover"
                onClick={() => setViewImage(p.image)}
              />
              <div className="mb-2 text-sm text-stone-700">
                {p.caption || <span className="text-stone-400">（冇說明）</span>}
              </div>
              <div className="mb-2 text-xs text-stone-400">
                排序 {p.sortOrder} · {p.isActive ? "上架中" : "已下架"}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => updateMut.mutate({ id: p.id, isActive: !p.isActive })}
                  className="rounded-lg border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-100"
                >
                  {p.isActive ? "下架" : "上架"}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm("確定刪除呢張打卡相？")) {
                      removeMut.mutate({ id: p.id });
                    }
                  }}
                  className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-500 hover:bg-red-50"
                >
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewImage && <Lightbox src={viewImage} onClose={() => setViewImage(null)} />}
    </div>
  );
}
