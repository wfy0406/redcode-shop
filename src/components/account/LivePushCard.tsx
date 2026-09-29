import { useCallback, useEffect, useState } from 'react';
import { BellRing, Smartphone } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { isPushSupported, unsubscribeLivePush } from '@/lib/pushClient';
import PushPermissionGuide from '@/components/push/PushPermissionGuide';

/**
 * 直播開播通知設定卡（v2.2.0，2026-09-30 老闆指令；其後加「多裝置管理」）—— 會員中心用
 * - 狀態：trpc.push.myPushStatus →「已開啟（N 部裝置）✓」或「未開啟」
 * - 裝置清單：trpc.push.listMyDevices（帶本機 endpoint 俾 server 計「呢部裝置」標記；
 *   endpoint 永遠唔會完整返落前端）——每行顯示裝置描述（userAgent 簡parse）、
 *   綁定日期 DD/MM/YYYY、最近推送 DD/MM、逐部「移除」底線掣
 * - 「綁定呢部裝置」：當前裝置未訂閱先顯示 → PushPermissionGuide 講解 → subscribe
 * - 「全部取消綁定（拒絕接收）」→ confirm → unsubscribe（後端全撤所有裝置＋關 optIn）
 * - 唔支援嘅瀏覽器（舊機/iPhone 未加至主畫面）：顯示說明，唔顯示綁定掣
 */

/** userAgent → 簡短裝置描述（「iPhone・Safari」款）；認唔出就「其他裝置」 */
function describeDevice(ua: string | null): string {
  if (!ua) return '其他裝置';
  let platform: string | null = null;
  if (/iPhone/i.test(ua)) platform = 'iPhone';
  else if (/iPad/i.test(ua)) platform = 'iPad';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) platform = 'Mac';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  let browser: string | null = null;
  // 注意次序：Edge／Chrome 嘅 UA 都包含 Safari，要由專到泛咁認
  if (/Edg(e|A|iOS)?\//i.test(ua)) browser = 'Edge';
  else if (/CriOS|Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  if (platform && browser) return `${platform}・${browser}`;
  return platform ?? browser ?? '其他裝置';
}

/** DD/MM/YYYY（綁定日期用） */
function fmtDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** DD/MM（最近推送用） */
function fmtDateShort(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

type DeviceRow = {
  id: number;
  userAgent: string | null;
  createdAt: Date | string;
  lastSentAt: Date | string | null;
  isCurrent: boolean;
};

export default function LivePushCard({
  pushToast,
}: {
  pushToast: (text: string) => void;
}) {
  const utils = trpc.useUtils();
  const [showGuide, setShowGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 本機 service worker 嘅 subscription endpoint（攞唔到就唔傳俾 listMyDevices）
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);

  const statusQuery = trpc.push.myPushStatus.useQuery(undefined, { retry: false });
  const status = statusQuery.data;
  const supported = isPushSupported();
  const activeDevices = status?.activeDevices ?? 0;
  const optedIn = !!status?.optIn && activeDevices > 0;

  /** 讀本機 subscription endpoint（best effort；權限未開/冇 subscription 就 null） */
  const loadCurrentEndpoint = useCallback(async () => {
    if (!isPushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = await reg?.pushManager.getSubscription();
      setCurrentEndpoint(subscription?.endpoint ?? null);
    } catch {
      // 攞唔到就唔傳——server 會當冇一部係「呢部裝置」
    }
  }, []);

  useEffect(() => {
    void loadCurrentEndpoint();
  }, [loadCurrentEndpoint]);

  // 裝置清單（input 帶本機 endpoint；server 對比完只回 isCurrent，endpoint 唔落前端）
  const devicesQuery = trpc.push.listMyDevices.useQuery(
    { currentEndpoint: currentEndpoint ?? undefined },
    { retry: false, enabled: optedIn },
  );
  const devices: DeviceRow[] = devicesQuery.data?.devices ?? [];
  const currentBound = devices.some((d) => d.isCurrent);

  const removeDevice = trpc.push.removeMyDevice.useMutation();

  /** 逐部移除：當前裝置要先彈確認；唔係自己嘅裝置後端會回 ok:false */
  const handleRemove = async (device: DeviceRow) => {
    if (busy || removingId !== null) return;
    if (device.isCurrent) {
      const sure = window.confirm('移除後呢部機收唔到通知（其他裝置唔受影響）。確定移除？');
      if (!sure) return;
    }
    setRemovingId(device.id);
    setError(null);
    try {
      const res = await removeDevice.mutateAsync({ id: device.id });
      if (res.ok) {
        if (device.isCurrent) {
          // 本機 service worker 一併撤銷（best effort，失敗都唔阻塞）
          try {
            const reg = await navigator.serviceWorker.getRegistration('/sw.js');
            const subscription = await reg?.pushManager.getSubscription();
            await subscription?.unsubscribe();
          } catch {
            // ignore
          }
          setCurrentEndpoint(null);
        }
        pushToast('已移除 1 部裝置');
        await utils.push.listMyDevices.invalidate();
        await utils.push.myPushStatus.invalidate();
        await utils.auth.me.invalidate();
      } else {
        setError('移除失敗，請刷新後再試。');
      }
    } catch {
      setError('移除失敗，請稍後再試。');
    }
    setRemovingId(null);
  };

  /** 全部取消綁定（拒絕接收）：全撤所有裝置 */
  const handleUnsubscribe = async () => {
    if (busy) return;
    const sure = window.confirm(
      '確定取消綁定？之後所有裝置都唔會再收到直播開播通知（隨時可以再綁定返）。',
    );
    if (!sure) return;
    setBusy(true);
    setError(null);
    const res = await unsubscribeLivePush({ all: true });
    setBusy(false);
    if (res.ok) {
      pushToast('已取消直播開播通知，唔會再收到推送');
      await utils.push.listMyDevices.invalidate();
      await utils.push.myPushStatus.invalidate();
      await utils.auth.me.invalidate();
    } else {
      setError(res.message);
    }
  };

  return (
    <div
      className="rounded-2xl border p-6 md:p-8"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
          style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
        >
          <BellRing size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-serif-tc text-lg font-bold text-txt-1">直播開播通知</h2>
          <p className="text-sm text-txt-3">Glo Glo 一開播，部機即刻收到通知</p>
        </div>
      </div>

      <div className="mt-4 border-t border-space-line pt-4">
        <p className="text-[15px] text-txt-1">
          狀態：{' '}
          {statusQuery.isLoading ? (
            <span className="text-txt-3">載入中…</span>
          ) : optedIn ? (
            <span className="font-medium text-gold-soft">
              已開啟（{activeDevices} 部裝置）✓
            </span>
          ) : (
            <span className="text-txt-3">未開啟</span>
          )}
        </p>
        <p className="mt-1.5 text-[13px] leading-[1.7] text-txt-3">
          綁定之後，每次直播開播都會經瀏覽器推送通知呢部裝置；通知只用嚟話你知開播，
          唔會用嚟做其他推廣。可以隨時喺度逐部移除，或者全部取消綁定。
        </p>

        {!supported && (
          <p
            className="mt-3 rounded-xl border px-4 py-3 text-[13px] leading-[1.7] text-txt-2"
            style={{ borderColor: 'rgba(245, 197, 24, 0.4)', background: 'rgba(245, 197, 24, 0.07)' }}
          >
            你而家嘅瀏覽器暫時唔支援推送通知。iPhone 請先喺 Safari 將 RedCode
            「加至主畫面」，再喺主畫面圖示開返網站，就可以綁定。
          </p>
        )}

        {/* 裝置清單：逐部描述＋綁定日期＋最近推送＋移除掣 */}
        {optedIn && devices.length > 0 && (
          <ul className="mt-4 border-t border-space-line">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex items-start justify-between gap-4 border-b border-space-line py-3"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <Smartphone
                    size={16}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-txt-3"
                  />
                  <div className="min-w-0">
                    <p className="text-[14px] text-txt-1">
                      {describeDevice(device.userAgent)}
                      {device.isCurrent && (
                        <span className="ml-2 font-medium text-gold-soft">呢部裝置 ✦</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-[1.6] text-txt-3">
                      綁定 {fmtDate(device.createdAt)}
                      {device.lastSentAt ? `　最近推送 ${fmtDateShort(device.lastSentAt)}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemove(device)}
                  disabled={busy || removingId !== null}
                  className="shrink-0 text-[13px] text-txt-3 underline underline-offset-4 transition-opacity hover:opacity-70 disabled:opacity-50"
                >
                  {removingId === device.id ? '移除緊…' : '移除'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          {supported && !currentBound && (
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              disabled={busy}
              className="inline-flex items-center gap-2 border-b pb-1 text-[14px] font-semibold text-gold-soft transition-opacity hover:opacity-70 disabled:opacity-50"
              style={{ borderColor: 'var(--gold)' }}
            >
              綁定呢部裝置
            </button>
          )}
          {optedIn && (
            <button
              type="button"
              onClick={() => void handleUnsubscribe()}
              disabled={busy}
              className="text-[13px] text-txt-3 underline underline-offset-4 transition-opacity hover:opacity-70 disabled:opacity-50"
            >
              {busy ? '取消緊…' : '全部取消綁定（拒絕接收）'}
            </button>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[13px] text-pink-soft">
            {error}
          </p>
        )}
      </div>

      {/* 權限講解 modal（確認先觸發真正 requestPermission） */}
      <PushPermissionGuide
        open={showGuide}
        onClose={(ok) => {
          setShowGuide(false);
          if (ok) {
            pushToast('已開啟直播開播通知 ✓');
            void loadCurrentEndpoint();
            void utils.push.listMyDevices.invalidate();
            void utils.push.myPushStatus.invalidate();
            void utils.auth.me.invalidate();
          }
        }}
      />
    </div>
  );
}
