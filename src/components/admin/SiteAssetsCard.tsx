import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, Image as ImageIcon, RefreshCw, Upload } from 'lucide-react';
import { getToken } from '@/lib/auth';
import type { ToastKind } from './useToasts';

/**
 * 網站資產卡 —— 畀管理員直接喺後台上傳兩個 binary 資產（唔使掂 GitHub）：
 *   1. empty-cart.png   → 購物車空狀態插圖（上傳後即時生效）
 *   2. ops-template.xlsx → 每日數據導出 Excel 模板
 * 檔案寫入伺服器持久碟（重新部署唔會散），runtime 優先讀上傳版。
 * 掛喺業務分析（AnalyticsManager）底部。
 */

type AssetStatus = {
  key: 'empty-cart' | 'ops-template';
  label: string;
  status: 'uploaded' | 'repo' | 'missing';
  size: number;
  updatedAt: string | null;
};

const ASSET_UI: Record<AssetStatus['key'], { accept: string; hint: string; icon: typeof ImageIcon }> = {
  'empty-cart': { accept: 'image/png,.png', hint: 'PNG 圖片，上限 2MB', icon: ImageIcon },
  'ops-template': { accept: '.xlsx', hint: 'Excel .xlsx，上限 5MB', icon: FileSpreadsheet },
};

const STATUS_META: Record<AssetStatus['status'], { text: string; color: string }> = {
  uploaded: { text: '已上傳（自訂版）', color: 'var(--success, #4ade80)' },
  repo: { text: '內建版', color: 'var(--text-3)' },
  missing: { text: '未上傳', color: 'var(--danger, #f87171)' },
};

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export default function SiteAssetsCard({ toast }: { toast: (text: string, kind?: ToastKind) => void }) {
  const [assets, setAssets] = useState<AssetStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/site-assets', {
        headers: { authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { assets: AssetStatus[] };
      setAssets(data.assets);
    } catch {
      toast('讀取資產狀態失敗', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (key: AssetStatus['key'], file: File) => {
    setBusy(key);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/admin/upload-asset?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getToken() ?? ''}` },
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast('上傳成功，已即時生效', 'success');
      await load();
    } catch (e) {
      toast(`上傳失敗：${e instanceof Error ? e.message : '未知錯誤'}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Upload size={16} aria-hidden="true" className="text-lavender" />
        網站資產
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        直接上傳網站用嘅檔案，即時生效，唔使經 GitHub。重新部署網站都唔會散。
      </p>

      <div className="mt-4 space-y-3">
        {loading && assets.length === 0 ? (
          <p className="text-[13px] text-txt-3">載入中…</p>
        ) : (
          assets.map((a) => {
            const ui = ASSET_UI[a.key];
            const meta = STATUS_META[a.status];
            const Icon = ui.icon;
            return (
              <div
                key={a.key}
                className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <Icon size={18} aria-hidden="true" className="shrink-0 text-txt-3" />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-txt-1">{a.label}</p>
                  <p className="mt-0.5 text-[12px] text-txt-3">
                    <span style={{ color: meta.color }}>{meta.text}</span>
                    {a.size > 0 && ` · ${fmtSize(a.size)}`}
                    {a.updatedAt && ` · ${new Date(a.updatedAt).toLocaleString('zh-HK')}`}
                    {'　'}{ui.hint}
                  </p>
                </div>
                <input
                  ref={(el) => {
                    inputRefs.current[a.key] = el;
                  }}
                  type="file"
                  accept={ui.accept}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(a.key, f);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => inputRefs.current[a.key]?.click()}
                  className="btn btn-primary !px-5 !py-2 text-[13px] disabled:opacity-60"
                >
                  <Upload size={14} aria-hidden="true" />
                  {busy === a.key ? '上傳中…' : a.status === 'missing' ? '上傳' : '重新上傳'}
                </button>
              </div>
            );
          })
        )}
      </div>

      <button
        type="button"
        onClick={() => void load()}
        disabled={loading}
        className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-txt-3 hover:text-txt-1 disabled:opacity-50"
      >
        <RefreshCw size={12} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
        重新整理狀態
      </button>
    </section>
  );
}
