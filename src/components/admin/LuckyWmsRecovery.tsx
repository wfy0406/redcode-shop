import { useState } from 'react';
import { trpc } from '@/providers/trpc';

type RecoveryResult = {
  status: 'pending' | 'sent' | 'partial' | 'failed' | 'disabled';
  lineCount: number;
  okCount: number;
  lastError: string | null;
};

type RecoveryPreview = {
  dryRun: boolean;
  canApply: boolean;
  reason: string | null;
  orderId: number;
  orderNo: string;
  drawId: number;
  sync: null | {
    status: string;
    lineCount: number | null;
    okCount: number | null;
    attempts: number | null;
    lastError: string | null;
    webhookOrderIds: number[];
    updatedAt: Date | string | null;
  };
  result?: RecoveryResult;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '核查失敗，請稍後再試';
}

/** 舊中獎單原位乾跑＋確認補送；後端再次核實身份、狀態同成功 ID。 */
export default function LuckyWmsRecovery({ orderId, onRecovered }: { orderId: number; onRecovered: () => void }) {
  const recover = trpc.luckyDraw.adminRecoverWms.useMutation();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecoveryResult | null>(null);

  const dryRun = async () => {
    setError(null);
    setResult(null);
    setPreview(null); // 重新核查失敗時唔可以繼續沿用舊結果補送
    setConfirmed(false);
    try {
      const row = await recover.mutateAsync({ orderId, apply: false, confirmWmsAbsent: false });
      setPreview(row as RecoveryPreview);
      setOpen(true);
    } catch (e) {
      setError(errorMessage(e));
      setOpen(true);
    }
  };

  const apply = async () => {
    if (!preview?.canApply || !confirmed) return;
    setError(null);
    try {
      const row = await recover.mutateAsync({ orderId, apply: true, confirmWmsAbsent: true });
      setPreview(row as RecoveryPreview);
      setResult(row.result ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      onRecovered();
    }
  };

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => void dryRun()}
          disabled={recover.isPending}
          className="min-h-11 shrink-0 rounded-full border px-3 py-1 text-[12px] text-gold-soft transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-40"
          style={{ borderColor: 'rgba(245,197,24,0.45)' }}
        >
          {recover.isPending ? '核查中…' : '核查 WMS'}
        </button>
        {error && <span role="alert" className="basis-full text-[12px] text-pink-soft">{error}</span>}
      </>
    );
  }

  return (
    <div className="basis-full border-t pt-3 text-[12px] leading-relaxed" style={{ borderColor: 'var(--space-line)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-txt-1">WMS 補送核查（乾跑唔會改資料）</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 px-2 text-txt-3 underline underline-offset-2 hover:text-txt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
        >
          收合
        </button>
      </div>

      {recover.isPending && <p className="mt-2 text-txt-3">正在讀取最新同步狀態…</p>}
      {error && <p role="alert" className="mt-2 text-pink-soft">{error}</p>}

      {preview && (
        <div className="mt-2 space-y-2">
          <p className="font-mono text-txt-2">官網單號：{preview.orderNo}・訂單 #{preview.orderId}</p>
          {preview.sync ? (
            <div className="space-y-1 text-txt-2">
              <p>
                同步狀態：<span className="font-mono text-gold-soft">{preview.sync.status}</span>
                {' '}・成功 {preview.sync.okCount ?? 0}/{preview.sync.lineCount ?? 0} 件
                {' '}・嘗試 {preview.sync.attempts ?? 0} 次
              </p>
              <p className="break-words">最近訊息：{preview.sync.lastError ?? '冇'}</p>
              <p className="break-words font-mono">
                WMS 收單 ID：{preview.sync.webhookOrderIds.length > 0 ? preview.sync.webhookOrderIds.join('、') : '冇'}
              </p>
            </div>
          ) : (
            <p className="text-gold-soft">冇同步紀錄：符合「背景任務消失而未留下 log」嘅情況。</p>
          )}

          {!preview.canApply && <p className="text-pink-soft">{preview.reason}</p>}

          {preview.canApply && !result && (
            <div className="space-y-3 pt-1">
              <p className="text-txt-2">
                下一步會補送呢張單。請先去 WMS 用上方官網單號搜尋所有狀態；如見到待批、已批准或已拒絕紀錄，唔好補送。
              </p>
              <label className="flex min-h-11 cursor-pointer items-start gap-2 text-txt-1">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-[#f5c518]"
                />
                <span>我已核對 WMS，確認呢個官網單號冇待批、已批准或已拒絕紀錄。</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={!confirmed || recover.isPending}
                  className="min-h-11 rounded-full border px-4 py-2 font-semibold text-gold transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: '#17131f', borderColor: 'var(--gold)' }}
                >
                  {recover.isPending ? '補送中…' : '確認補送呢張單'}
                </button>
                <button
                  type="button"
                  onClick={() => void dryRun()}
                  disabled={recover.isPending}
                  className="min-h-11 px-3 text-txt-3 underline underline-offset-2 hover:text-txt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-40"
                >
                  重新乾跑
                </button>
              </div>
            </div>
          )}

          {result && (
            <p role="status" className={result.status === 'sent' ? 'text-success' : 'text-gold-soft'}>
              補送結果：{result.status}（{result.okCount}/{result.lineCount} 件）
              {result.lastError ? `・${result.lastError}` : '・WMS 已確認收單'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
