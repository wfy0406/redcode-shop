import { useEffect, useState } from 'react';
import { BarChart3, ChevronDown, ChevronUp, Loader2, RefreshCw, Save } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';
import { trpc } from '@/providers/trpc';
import { fmtDateTime } from './format';
import type { ToastKind } from './useToasts';
import './GloGuideUsagePanel.css';

/**
 * 精選文章「用量及估算成本」原位摺疊區（**只限管理員**——由 GloGuidePanel 按 isAdmin 先至掛載，
 * 後端三個 procedure 都係 adminProcedure，非 admin 根本 call 唔到）。
 *
 * ─ 數據嚟自 trpc.gloGuideAdmin.usageStats：gloGuideJobs.createdAt 按香港時間（UTC+8）分
 *   今日／今月／今年三桶；成本全部係 job 建立當刻嘅 snapshot，改單價唔影響歷史。
 * ─ 配搭圖「成功」係歷史生成工作數：圖之後刪除都照計，**唔等於而家現存圖數**。
 * ─ 全部金額係**估算成本**，唔係供應商實收；實際收費以供應商帳單為準。
 * ─ 成本單價表單：HK$ 字串 → 整數仙；留空＝未知（null）；0＝管理員明確設定免費。
 * ─ mobile-first，全部 control ≥44px；唔用全屏彈窗。
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type UsageStats = RouterOutputs['gloGuideAdmin']['usageStats'];
export type UsagePeriodBucket = UsageStats['today'];
export type UsageKindBucket = UsagePeriodBucket['article'];

type Toast = (text: string, kind?: ToastKind) => void;

/* eslint-disable react-refresh/only-export-components -- 純邏輯 export 俾單元測試抽（同 GloGuidePanel 做法一致） */

/** 單價上限（HK$）——同後端 GLO_GUIDE_USAGE_MAX_CENTS（100000 仙）對齊 */
export const USAGE_COST_MAX_HKD = 1000;

/**
 * HK$ 字串 → 整數仙：
 * ─ 空字串／全空白 → { ok: true, cents: null }（管理員明確留空＝成本未知）；
 * ─ 非負數、≤ 上限 → { ok: true, cents }（0＝明確免費）；
 * ─ 其他 → { ok: false }（表單要擋，唔准亂估）。
 */
export function parseHkdCostField(
  s: string,
): { ok: true; cents: number | null } | { ok: false } {
  const t = s.trim();
  if (t === '') return { ok: true, cents: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > USAGE_COST_MAX_HKD) return { ok: false };
  return { ok: true, cents: Math.round(n * 100) };
}

/** 仙 → 港元顯示；null 顯示「未知」（唔准當 0） */
export function fmtCents(cents: number | null): string {
  if (cents === null) return '未知';
  return `HK$${(cents / 100).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** job kind → 中文標籤 */
export const JOB_KIND_LABEL: Record<string, string> = {
  full: '完整文章',
  scheduled: '排程文章',
  article: '文字重生',
  image: '配搭圖',
};

export const JOB_STATUS_META: Record<string, { label: string; tone: string }> = {
  queued: { label: '排隊中', tone: 'gold' },
  submitted: { label: '已提交', tone: 'gold' },
  processing: { label: '生成中', tone: 'lavender' },
  completed: { label: '完成', tone: 'green' },
  failed: { label: '失敗', tone: 'pink' },
};

const CATEGORY_LABEL: { key: keyof UsagePeriodBucket; label: string }[] = [
  { key: 'article', label: '完整文章' },
  { key: 'regenerate', label: '文字重生' },
  { key: 'image', label: '配搭圖' },
];

/* eslint-enable react-refresh/only-export-components */

/** 單類工作嘅統計行（總數／成功／失敗／生成中＋已結束／預留估算成本＋未知數） */
function KindStats({ label, bucket }: { label: string; bucket: UsageKindBucket }) {
  const rows: { label: string; value: string; warn?: boolean }[] = [
    { label: '總數', value: String(bucket.total) },
    { label: '成功', value: String(bucket.completed) },
    { label: '失敗', value: String(bucket.failed) },
    { label: '生成中', value: String(bucket.active) },
    { label: '已結束估算成本', value: fmtCents(bucket.finishedCostCents) },
    { label: '預留中估算成本', value: fmtCents(bucket.reservedCostCents) },
    { label: '成本未知工作', value: String(bucket.unknownCostJobs), warn: bucket.unknownCostJobs > 0 },
  ];
  return (
    <div className="ggu-kind">
      <p className="ggu-kind-name">{label}</p>
      <dl className="ggu-kind-grid">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd className={r.warn ? 'ggu-warn' : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PeriodCard({ title, sub, bucket }: { title: string; sub: string; bucket: UsagePeriodBucket }) {
  return (
    <div className="ggu-period">
      <p className="ggu-period-title">{title}</p>
      <p className="ggu-period-sub">{sub}</p>
      {CATEGORY_LABEL.map((c) => (
        <KindStats key={c.key} label={c.label} bucket={bucket[c.key]} />
      ))}
    </div>
  );
}

export default function GloGuideUsagePanel({ toast }: { toast: Toast }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const settingsQ = trpc.gloGuideAdmin.usageSettings.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const statsQ = trpc.gloGuideAdmin.usageStats.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const setSettings = trpc.gloGuideAdmin.setUsageSettings.useMutation();

  // 表單狀態（HK$ 字串；空＝未知）
  const [imageCost, setImageCost] = useState('');
  const [textCost, setTextCost] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 單價全部由 API 帶入（仙 ÷100 轉港元）；null＝未知→留空，絕對唔會預填估價
  useEffect(() => {
    const s = settingsQ.data;
    if (!s) return;
    setImageCost(s.imageCostCents === null ? '' : String(s.imageCostCents / 100));
    setTextCost(s.textCostCents === null ? '' : String(s.textCostCents / 100));
  }, [settingsQ.data]);

  const save = async () => {
    const img = parseHkdCostField(imageCost);
    const txt = parseHkdCostField(textCost);
    if (!img.ok || !txt.ok) {
      setFormError(`成本單價要係 0–${USAGE_COST_MAX_HKD} 嘅金額（HK$），或者留空代表未知`);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await setSettings.mutateAsync({ imageCostCents: img.cents, textCostCents: txt.cents });
      toast('已儲存估算成本單價 ✓ 只影響之後新建嘅工作，歷史紀錄唔變', 'success');
      void utils.gloGuideAdmin.usageSettings.invalidate();
      void utils.gloGuideAdmin.usageStats.invalidate();
    } catch (e) {
      toast(e instanceof Error ? e.message : '儲存失敗，請再試', 'error');
    } finally {
      setSaving(false);
    }
  };

  const refresh = () => {
    void statsQ.refetch();
    void settingsQ.refetch();
  };

  const loading = settingsQ.isLoading || statsQ.isLoading;
  const loadError = settingsQ.isError ? settingsQ.error : statsQ.isError ? statsQ.error : null;

  return (
    <section className="ggu-card" aria-label="用量及估算成本">
      <button
        type="button"
        className="ggu-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BarChart3 size={16} aria-hidden="true" />
        <span>用量及估算成本（香港時間）</span>
        {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>

      {!open ? null : loading ? (
        <p className="ggu-loading">
          <Loader2 size={16} className="ggu-spin" aria-hidden="true" /> 載入用量中…
        </p>
      ) : loadError ? (
        <div className="ggu-error" role="alert">
          <p style={{ margin: 0 }}>載入用量失敗：{loadError.message}</p>
          <button type="button" className="ggu-btn" onClick={refresh}>
            重試
          </button>
        </div>
      ) : statsQ.data ? (
        <div className="ggu-body">
          <p className="ggu-note">
            以下係按下面設定單價、以工作建立當刻快照計嘅<strong>估算成本</strong>，唔係供應商實收——實際收費以供應商帳單為準。
            配搭圖「成功」係歷史生成工作數：圖之後刪除都照計，唔等於而家現存圖數。
            未有單價或舊工作會列入「成本未知」；改單價只影響之後新建嘅工作。
          </p>

          <div className="ggu-periods">
            <PeriodCard title="今日" sub={statsQ.data.periods.date} bucket={statsQ.data.today} />
            <PeriodCard title="今月" sub={statsQ.data.periods.month} bucket={statsQ.data.month} />
            <PeriodCard title="今年" sub={statsQ.data.periods.year} bucket={statsQ.data.year} />
          </div>

          <div className="ggu-toolbar">
            <button
              type="button"
              className="ggu-btn"
              onClick={refresh}
              disabled={statsQ.isFetching || settingsQ.isFetching}
            >
              <RefreshCw
                size={14}
                aria-hidden="true"
                className={statsQ.isFetching || settingsQ.isFetching ? 'ggu-spin' : undefined}
              />
              重新整理
            </button>
          </div>

          {/* ── 成本單價表單（管理員明確輸入；留空＝未知，0＝明確免費）── */}
          <form
            className="ggu-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h4 className="ggu-form-title">估算成本單價（每次工作）</h4>
            <div className="ggu-form-grid">
              <div>
                <label className="ggu-label" htmlFor="ggu-image-cost">
                  每張配搭圖（HK$）
                </label>
                <input
                  id="ggu-image-cost"
                  className="ggu-input"
                  type="number"
                  min="0"
                  max={USAGE_COST_MAX_HKD}
                  step="0.01"
                  inputMode="decimal"
                  value={imageCost}
                  onChange={(e) => setImageCost(e.target.value)}
                  placeholder="留空＝未知"
                  disabled={saving}
                />
              </div>
              <div>
                <label className="ggu-label" htmlFor="ggu-text-cost">
                  每次完整文章／文字生成（HK$）
                </label>
                <input
                  id="ggu-text-cost"
                  className="ggu-input"
                  type="number"
                  min="0"
                  max={USAGE_COST_MAX_HKD}
                  step="0.01"
                  inputMode="decimal"
                  value={textCost}
                  onChange={(e) => setTextCost(e.target.value)}
                  placeholder="留空＝未知"
                  disabled={saving}
                />
              </div>
            </div>
            <p className="ggu-note">
              留空代表成本未知；填 0 代表你明確設定呢類工作免費。未開始生成嘅排程失敗永遠當 HK$0。
            </p>
            {formError && (
              <p className="ggu-form-error" role="alert">
                {formError}
              </p>
            )}
            <button type="submit" className="ggu-btn ggu-btn-primary" disabled={saving}>
              {saving ? <Loader2 size={15} className="ggu-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
              儲存成本單價
            </button>
          </form>

          {/* ── 最近工作（唔顯示 payload／原圖／任何秘密）── */}
          <h4 className="ggu-form-title">最近工作（最新 20 個）</h4>
          {statsQ.data.recentJobs.length === 0 ? (
            <p className="ggu-empty">暫時未有生成工作紀錄。</p>
          ) : (
            <div className="ggu-table-wrap">
              <table className="ggu-table">
                <thead>
                  <tr>
                    <th>建立時間</th>
                    <th>類型</th>
                    <th>狀態</th>
                    <th>文章</th>
                    <th>估算成本</th>
                    <th>錯誤</th>
                  </tr>
                </thead>
                <tbody>
                  {statsQ.data.recentJobs.map((j) => {
                    const meta = JOB_STATUS_META[j.status] ?? { label: j.status, tone: 'default' };
                    return (
                      <tr key={j.publicId}>
                        <td className="ggu-mono">{fmtDateTime(j.createdAt)}</td>
                        <td>{JOB_KIND_LABEL[j.kind] ?? j.kind}</td>
                        <td>
                          <span className="ggu-status" data-tone={meta.tone}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="ggu-title-cell">{j.articleTitle ?? '—'}</td>
                        <td className="ggu-mono">{fmtCents(j.estimatedCostCents)}</td>
                        <td className="ggu-error-cell">{j.error ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
