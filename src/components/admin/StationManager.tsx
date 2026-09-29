import { useMemo, useState } from 'react';
import { MapPin, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 順豐站點管理面板（v2.1.0，2026-09-29，admin 專用）—— trpc.vip.adminListStations / upsertStation / deleteStation / reseedDefaultStations
 * 表格列全部站點（連停用），可按地區（香港/澳門）同類型（順豐站/智能櫃/服務點）篩＋搜尋；
 * 新增/編輯同一個 inline form；停用＝upsert active:false（保留資料）；刪除直接刪 row（歷史訂單有站名快照，唔受影響）；
 * 「重新導入預設清單」將後端內置清單逐個 upsert（唔會清走自加嘅站），要 confirm 先執行。
 */

type StationRow = {
  id: string;
  region: string; // 'HK' | 'MO'
  type: string; // 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT'
  name: string;
  district: string | null;
  address: string | null;
  active: boolean;
  sortOrder: number;
};

const REGION_LABEL: Record<string, string> = { HK: '香港', MO: '澳門' };
const TYPE_LABEL: Record<string, string> = {
  SF_STATION: '順豐站',
  SF_LOCKER: '智能櫃',
  SERVICE_POINT: '服務點',
};

const inputCls =
  'h-10 w-full rounded-lg border border-space-line bg-space-1 px-3 text-[13px] text-txt-1 placeholder:text-txt-3 focus:border-pink focus:outline-none';
const labelCls = 'mb-1 block text-[11px] text-txt-3';
const selectCls = inputCls;

/** 新增／編輯站點 inline form（編輯時 id 唯讀） */
function StationForm({
  editing,
  busy,
  onCancel,
  onSave,
}: {
  editing: StationRow | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: {
    id: string;
    region: 'HK' | 'MO';
    type: 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT';
    name: string;
    district: string | null;
    address: string | null;
    active: boolean;
  }) => void;
}) {
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [district, setDistrict] = useState(editing?.district ?? '');
  const [address, setAddress] = useState(editing?.address ?? '');
  const [region, setRegion] = useState<'HK' | 'MO'>((editing?.region as 'HK' | 'MO') ?? 'HK');
  const [type, setType] = useState<'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT'>(
    (editing?.type as 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT') ?? 'SF_STATION',
  );
  const [active, setActive] = useState(editing?.active ?? true);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = () => {
    if (!editing && !id.trim()) return setFormError('站點 ID 必填（例如 HK-KLM-001）');
    if (!name.trim()) return setFormError('站點名稱必填');
    setFormError(null);
    onSave({
      id: (editing?.id ?? id).trim(),
      region,
      type,
      name: name.trim(),
      district: district.trim() || null,
      address: address.trim() || null,
      active,
    });
  };

  return (
    <div
      className="mt-3 rounded-xl border p-3"
      style={{ borderColor: 'var(--gold)', background: 'var(--space-2)' }}
    >
      <p className="mb-2.5 text-[12px] font-bold text-txt-2">
        {editing ? `編輯站點「${editing.name}」` : '新增站點'}
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="st-id">
            站點 ID{editing ? '（唔改得）' : '（例如 HK-KLM-001）'}
          </label>
          <input
            id="st-id"
            className={inputCls}
            value={id}
            disabled={!!editing}
            onChange={(e) => setId(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="st-name">
            站點名稱
          </label>
          <input
            id="st-name"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="st-region">
            地區
          </label>
          <select
            id="st-region"
            className={selectCls}
            value={region}
            onChange={(e) => setRegion(e.target.value as 'HK' | 'MO')}
          >
            <option value="HK">香港</option>
            <option value="MO">澳門</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="st-type">
            類型
          </label>
          <select
            id="st-type"
            className={selectCls}
            value={type}
            onChange={(e) => setType(e.target.value as 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT')}
          >
            <option value="SF_STATION">順豐站</option>
            <option value="SF_LOCKER">智能櫃</option>
            <option value="SERVICE_POINT">服務點</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="st-district">
            分區（下拉分組用，例如 觀塘區）
          </label>
          <input
            id="st-district"
            className={inputCls}
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="st-active">
            狀態
          </label>
          <label className="flex h-10 items-center gap-2 text-[13px] text-txt-2">
            <input
              id="st-active"
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-[#F5C518]"
            />
            啟用中（唔剔＝停用，前台下拉唔會顯示）
          </label>
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="st-address">
            地址
          </label>
          <textarea
            id="st-address"
            rows={2}
            className="w-full rounded-lg border border-space-line bg-space-1 px-3 py-2 text-[13px] leading-relaxed text-txt-1 placeholder:text-txt-3 focus:border-pink focus:outline-none"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
      </div>
      {formError && <p className="mt-2 text-[12px] text-pink-soft">{formError}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="btn btn-primary !px-4 !py-2 text-[13px] disabled:opacity-50"
        >
          {busy ? '儲存緊…' : '儲存'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn btn-secondary !px-4 !py-2 text-[13px]"
        >
          取消
        </button>
      </div>
    </div>
  );
}

export default function StationManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const [regionFilter, setRegionFilter] = useState<'ALL' | 'HK' | 'MO'>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT'>('ALL');
  const [q, setQ] = useState('');
  // formOpen：null＝收埋；'new'＝新增；StationRow＝編輯緊嗰個
  const [editing, setEditing] = useState<StationRow | 'new' | null>(null);

  const listQuery = trpc.vip.adminListStations.useQuery();
  const stations = useMemo(() => (listQuery.data ?? []) as StationRow[], [listQuery.data]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return stations.filter(
      (s) =>
        (regionFilter === 'ALL' || s.region === regionFilter) &&
        (typeFilter === 'ALL' || s.type === typeFilter) &&
        (!term ||
          s.name.toLowerCase().includes(term) ||
          s.id.toLowerCase().includes(term) ||
          (s.district ?? '').toLowerCase().includes(term) ||
          (s.address ?? '').toLowerCase().includes(term)),
    );
  }, [stations, regionFilter, typeFilter, q]);

  const upsert = trpc.vip.upsertStation.useMutation({
    onSuccess: (r) => {
      toast(r?.created ? '已新增站點 ✓' : '已更新站點 ✓', 'success');
      setEditing(null);
      void utils.vip.adminListStations.invalidate();
      void utils.vip.listStations.invalidate();
    },
    onError: (err) => toast(err.message || '儲存站點失敗', 'error'),
  });
  const remove = trpc.vip.deleteStation.useMutation({
    onSuccess: () => {
      toast('已刪除站點', 'info');
      void utils.vip.adminListStations.invalidate();
      void utils.vip.listStations.invalidate();
    },
    onError: (err) => toast(err.message || '刪除站點失敗', 'error'),
  });
  const reseed = trpc.vip.reseedDefaultStations.useMutation({
    onSuccess: (r) => {
      toast(`已重新導入預設清單（${r?.count ?? ''} 個站）✓`, 'success');
      void utils.vip.adminListStations.invalidate();
      void utils.vip.listStations.invalidate();
    },
    onError: (err) => toast(err.message || '導入失敗，請再試', 'error'),
  });
  // v2.1.1（Wave 2）：立即同步順豐官網全量站點清單（每日排程之外嘅手動版）
  const syncNow = trpc.vip.adminSyncStationsNow.useMutation({
    onSuccess: (r) => {
      const s = r?.stats;
      toast(
        `官方站點同步完成 ✓ 新增 ${s?.added ?? 0}・更新 ${s?.updated ?? 0}・停用 ${s?.deactivated ?? 0}` +
          (s?.perTypeFailed?.length ? `（失敗類別：${s.perTypeFailed.join('、')}）` : '') +
          (r?.lastSyncAt ? `・${new Date(r.lastSyncAt).toLocaleString('zh-HK')}` : ''),
        s?.perTypeFailed?.length ? 'info' : 'success',
      );
      void utils.vip.adminListStations.invalidate();
      void utils.vip.listStations.invalidate();
    },
    onError: (err) => toast(err.message || '同步失敗，請再試', 'error'),
  });

  const askDelete = (s: StationRow) => {
    if (!window.confirm(`確定刪除站點「${s.name}」（${s.id}）？\n歷史訂單嘅站名快照唔受影響。`)) return;
    remove.mutate({ id: s.id });
  };

  const askReseed = () => {
    if (
      !window.confirm(
        '重新導入預設站點清單？\n同 ID 嘅站會被預設資料覆蓋（停用狀態會保留），後台自加嘅站唔會被清走。',
      )
    )
      return;
    reseed.mutate();
  };

  const askSyncNow = () => {
    if (
      !window.confirm(
        '立即由順豐官網同步最新站點清單？\n會更新現有站、加入新站；官網已下架嘅站會自動停用（後台手加嘅站唔會郁）。同步需時約 1 分鐘。',
      )
    )
      return;
    syncNow.mutate();
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <MapPin size={16} aria-hidden="true" className="text-gold" />
        順豐站點管理
        {!listQuery.isLoading && !listQuery.isError && (
          <span className="font-mono text-[13px] font-normal text-txt-3">
            （{filtered.length}/{stations.length} 個站）
          </span>
        )}
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        前台註冊／會員中心／結帳嘅站點下拉都係用呢度嘅清單；停用嘅站唔會喺前台出現。
      </p>

      {/* 操作行：新增 ＋ 重新導入預設清單 */}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setEditing(editing ? null : 'new')}
          className="btn btn-secondary !px-4 !py-2 text-[13px]"
        >
          {editing ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          {editing ? '收起表單' : '新增站點'}
        </button>
        <button
          type="button"
          onClick={askReseed}
          disabled={reseed.isPending}
          className="btn btn-secondary !px-4 !py-2 text-[13px] disabled:opacity-50"
        >
          <RefreshCw size={14} aria-hidden="true" />
          {reseed.isPending ? '導入緊…' : '重新導入預設清單'}
        </button>
        <button
          type="button"
          onClick={askSyncNow}
          disabled={syncNow.isPending}
          className="btn btn-secondary !px-4 !py-2 text-[13px] disabled:opacity-50"
        >
          <RefreshCw size={14} aria-hidden="true" className={syncNow.isPending ? 'animate-spin' : ''} />
          {syncNow.isPending ? '同步緊（約 1 分鐘）…' : '立即同步官方站點'}
        </button>
      </div>

      {/* 新增／編輯表單 */}
      {editing && (
        <StationForm
          key={editing === 'new' ? 'new' : editing.id}
          editing={editing === 'new' ? null : editing}
          busy={upsert.isPending}
          onCancel={() => setEditing(null)}
          onSave={(input) => upsert.mutate(input)}
        />
      )}

      {/* 篩選：地區 ＋ 類型 ＋ 搜尋 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          aria-label="按地區篩選"
          className={selectCls}
          style={{ width: 'auto' }}
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value as 'ALL' | 'HK' | 'MO')}
        >
          <option value="ALL">全部地區</option>
          <option value="HK">香港</option>
          <option value="MO">澳門</option>
        </select>
        <select
          aria-label="按類型篩選"
          className={selectCls}
          style={{ width: 'auto' }}
          value={typeFilter}
          onChange={(e) =>
            setTypeFilter(e.target.value as 'ALL' | 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT')
          }
        >
          <option value="ALL">全部類型</option>
          <option value="SF_STATION">順豐站</option>
          <option value="SF_LOCKER">智能櫃</option>
          <option value="SERVICE_POINT">服務點</option>
        </select>
        <div className="relative min-w-[200px] flex-1">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-3"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋名稱／ID／分區／地址…"
            aria-label="搜尋站點"
            className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-[13px] text-txt-1 outline-none transition-colors placeholder:text-txt-3 focus:border-lavender"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </div>
      </div>

      {/* 站點表格 */}
      {listQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊站點清單…" />
      ) : listQuery.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft">
          載入站點失敗：{listQuery.error.message}
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">
          {stations.length === 0 ? '暫時冇站點，撳「重新導入預設清單」倒入。' : '冇站點符合篩選條件。'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr
                className="border-b text-left text-[12px] text-txt-3"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <th className="py-2 pr-3 font-normal">名稱</th>
                <th className="py-2 pr-3 font-normal">地區</th>
                <th className="py-2 pr-3 font-normal">類型</th>
                <th className="py-2 pr-3 font-normal">分區</th>
                <th className="py-2 pr-3 font-normal">地址</th>
                <th className="py-2 pr-3 font-normal">狀態</th>
                <th className="py-2 text-right font-normal">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr
                  key={s.id}
                  className="border-b transition-colors last:border-0 hover:bg-white/5"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <td className="py-2.5 pr-3">
                    <p className="font-medium text-txt-1">{s.name}</p>
                    <p className="font-mono text-[11px] text-txt-3">{s.id}</p>
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-txt-2">
                    {REGION_LABEL[s.region] ?? s.region}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-txt-2">
                    {TYPE_LABEL[s.type] ?? s.type}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-txt-3">{s.district || '—'}</td>
                  <td className="max-w-[220px] truncate py-2.5 pr-3 text-txt-3">
                    {s.address || '—'}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                      style={
                        s.active
                          ? {
                              borderColor: 'var(--success)',
                              color: 'var(--success)',
                              background: 'rgba(94, 224, 160, 0.12)',
                            }
                          : { borderColor: 'var(--space-line)', color: 'var(--text-3)' }
                      }
                    >
                      {s.active ? '啟用中' : '已停用'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(s)}
                      aria-label={`編輯站點 ${s.name}`}
                      className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-txt-3 transition-colors hover:text-txt-1"
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={upsert.isPending}
                      onClick={() =>
                        upsert.mutate({
                          id: s.id,
                          region: s.region as 'HK' | 'MO',
                          type: s.type as 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT',
                          name: s.name,
                          active: !s.active,
                        })
                      }
                      className="ml-1 inline-flex items-center rounded-lg border px-2 py-1 text-[11px] text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-60"
                      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                    >
                      {s.active ? '停用' : '啟用'}
                    </button>
                    <button
                      type="button"
                      onClick={() => askDelete(s)}
                      disabled={remove.isPending}
                      aria-label={`刪除站點 ${s.name}`}
                      className="ml-1 inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-50"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
