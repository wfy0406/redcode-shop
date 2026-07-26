import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Save, Settings2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 商品頁介紹設定卡（F-C）—— siteSettings key-value CMS
 * 兩欄：商品頁標題 products_intro_title、副題 products_intro_sub；儲存 → settings.upsert → toast。
 * 前台 Products.tsx 會讀呢兩個 key（冇設定就用返 hardcode 預設文案）。
 * 後端 settingsRouter 未 merge 前 tsc 會報 does not exist（預期），本地型別同 spec §B2 契約一致。
 */

/** settingsRouter 未 merge 前嘅本地型別（同 spec §B2 契約一致） */
type SettingEntry = { key: string; value: string };

const TITLE_KEY = 'products_intro_title';
const SUB_KEY = 'products_intro_sub';

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

export default function SettingsCard({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const titleQuery = trpc.settings.get.useQuery({ key: TITLE_KEY });
  const subQuery = trpc.settings.get.useQuery({ key: SUB_KEY });
  const [title, setTitle] = useState('');
  const [sub, setSub] = useState('');
  const [saving, setSaving] = useState(false);

  // 載入現有設定做預填（冇設定就留空，placeholder 顯示前台預設文案）
  useEffect(() => {
    const entry = titleQuery.data as SettingEntry | null | undefined;
    if (entry?.value != null) setTitle(entry.value);
  }, [titleQuery.data]);
  useEffect(() => {
    const entry = subQuery.data as SettingEntry | null | undefined;
    if (entry?.value != null) setSub(entry.value);
  }, [subQuery.data]);

  const upsert = trpc.settings.upsert.useMutation();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await upsert.mutateAsync({ key: TITLE_KEY, value: title.trim() });
      await upsert.mutateAsync({ key: SUB_KEY, value: sub.trim() });
      toast('已儲存商品頁介紹', 'success');
      void utils.settings.get.invalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : '儲存失敗，請再試', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Settings2 size={16} aria-hidden="true" className="text-gold" />
        商品頁介紹
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        設定 /products 頁首嘅標題同花體副題；留空會用返預設文案。
      </p>
      <form onSubmit={(e) => void save(e)} className="mt-4 flex flex-col gap-3">
        <div>
          <label htmlFor="settings-intro-title" className="mb-1.5 block text-[13px] text-txt-2">
            商品頁標題
          </label>
          <input
            id="settings-intro-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="全部商品"
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="settings-intro-sub" className="mb-1.5 block text-[13px] text-txt-2">
            副題（花體字）
          </label>
          <input
            id="settings-intro-sub"
            type="text"
            value={sub}
            onChange={(e) => setSub(e.target.value)}
            maxLength={200}
            placeholder="pick your star ✦"
            className={inputCls}
          />
        </div>
        <div>
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary !px-6 !py-2.5 text-[14px] disabled:opacity-60"
          >
            {saving ? <WishingStar size={14} /> : <Save size={15} aria-hidden="true" />}
            儲存
          </button>
        </div>
      </form>
    </section>
  );
}
