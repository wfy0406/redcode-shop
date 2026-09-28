import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Copy, KeyRound, Save } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * Airwallex 設定卡（Glo 要求）—— 管理員專區直填 Client ID／API Key／Webhook Secret，
 * 儲存後網上付款即時生效。視覺風格跟足 PaymentMethodsCard。
 * - 已配置（綠）／未配置（灰）badge
 * - API Key／Webhook Secret 留空＝保留舊值；首次未配置要填齊
 * - 說明區講明去邊度攞鎖匙（Airwallex 後台 → Developers → API Keys）＋ webhook URL copy 掣
 * 後端 settings.getAirwallexConfig / setAirwallexConfig 係 adminProcedure，雙重把關。
 */

/** settings.getAirwallexConfig 回傳（同後端契約一致） */
type AirwallexConfig = {
  configured: boolean;
  clientId: string | null;
  apiKeyMasked: string | null;
  webhookSecretMasked: string | null;
  baseUrl: string;
};

const DEMO_URL = 'https://api-demo.airwallex.com';
const PROD_URL = 'https://api.airwallex.com';
const WEBHOOK_URL = 'https://redcode.red/api/airwallex/webhook';

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

export default function AirwallexConfigCard({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const query = trpc.settings.getAirwallexConfig.useQuery();
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEMO_URL);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const config = query.data as AirwallexConfig | undefined;
  const configured = config?.configured ?? false;

  // 載入現有設定：Base URL 直接預填；其餘用 placeholder 顯示而家值（留空＝保留舊值）
  useEffect(() => {
    if (config?.baseUrl) setBaseUrl(config.baseUrl);
  }, [config?.baseUrl]);

  const saveMutation = trpc.settings.setAirwallexConfig.useMutation();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    // 首次未配置：三條鎖匙要填齊；已配置：留空＝保留舊值
    if (!configured && (!clientId.trim() || !apiKey.trim() || !webhookSecret.trim())) {
      toast('首次設定要填齊 Client ID、API Key 同 Webhook Secret', 'error');
      return;
    }
    setSaving(true);
    try {
      await saveMutation.mutateAsync({
        clientId: clientId.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        webhookSecret: webhookSecret.trim() || undefined,
        baseUrl,
      });
      toast('已儲存 Airwallex 設定，網上付款即時生效', 'success');
      setClientId('');
      setApiKey('');
      setWebhookSecret('');
      void utils.settings.getAirwallexConfig.invalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : '儲存失敗，請再試', 'error');
    } finally {
      setSaving(false);
    }
  };

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = WEBHOOK_URL;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
          <KeyRound size={16} aria-hidden="true" className="text-gold" />
          Airwallex 設定
        </h3>
        <span
          className="rounded-full border px-2.5 py-0.5 text-[11px] font-bold"
          style={
            configured
              ? { borderColor: 'var(--success)', color: 'var(--success)' }
              : { borderColor: 'var(--space-line)', color: 'var(--text-3)' }
          }
        >
          {configured ? '已配置' : '未配置'}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] text-txt-3">
        填好 Airwallex 鎖匙，客人就可以即刻喺網站碌卡／用電子錢包畀錢。改完即時生效，唔使重新部署。
      </p>
      <form onSubmit={(e) => void save(e)} className="mt-4 flex flex-col gap-5">
        <fieldset className="rounded-xl border p-4" style={{ borderColor: 'var(--space-line)' }}>
          <legend className="px-1.5 text-[13px] font-bold text-txt-2">API 鎖匙</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="awx-client-id" className="mb-1.5 block text-[13px] text-txt-2">
                Client ID
                {configured && (
                  <span className="ml-1.5 text-[11px] text-txt-3">（留空＝保留而家嗰個）</span>
                )}
              </label>
              <input
                id="awx-client-id"
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                maxLength={128}
                placeholder={config?.clientId ?? '例如：xxxxxxxx-xxxx-xxxx'}
                autoComplete="off"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label htmlFor="awx-base-url" className="mb-1.5 block text-[13px] text-txt-2">
                Base URL
              </label>
              <select
                id="awx-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className={`${inputCls} font-mono`}
              >
                <option value={DEMO_URL}>{DEMO_URL}（試玩）</option>
                <option value={PROD_URL}>{PROD_URL}（正式）</option>
              </select>
            </div>
            <div>
              <label htmlFor="awx-api-key" className="mb-1.5 block text-[13px] text-txt-2">
                API Key
                {configured && (
                  <span className="ml-1.5 text-[11px] text-txt-3">（留空＝保留舊值）</span>
                )}
              </label>
              <input
                id="awx-api-key"
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                maxLength={256}
                placeholder={config?.apiKeyMasked ?? '例如：••••1234'}
                autoComplete="off"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label htmlFor="awx-webhook-secret" className="mb-1.5 block text-[13px] text-txt-2">
                Webhook Secret
                {configured && (
                  <span className="ml-1.5 text-[11px] text-txt-3">（留空＝保留舊值）</span>
                )}
              </label>
              <input
                id="awx-webhook-secret"
                type="text"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                maxLength={256}
                placeholder={config?.webhookSecretMasked ?? '例如：••••5678'}
                autoComplete="off"
                className={`${inputCls} font-mono`}
              />
            </div>
          </div>
        </fieldset>

        {/* 說明區 */}
        <div
          className="rounded-xl border p-4 text-[12px] leading-relaxed text-txt-3"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
        >
          <p>
            鎖匙喺邊度攞？登入 Airwallex 後台 → <span className="text-txt-2">Developers → API Keys</span>，
            嗰度會見到 Client ID 同 API Key；Webhook Secret 就喺 Developers → Webhooks 加完 webhook 之後會顯示。
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <span>Webhook URL（貼落 Airwallex 後台嘅 Webhooks 嗰頁）：</span>
            <code className="rounded-md border px-2 py-0.5 font-mono text-[12px] text-txt-1" style={{ borderColor: 'var(--space-line)' }}>
              {WEBHOOK_URL}
            </code>
            <button
              type="button"
              onClick={() => void copyWebhook()}
              className="btn btn-secondary !px-3 !py-1.5 text-[12px]"
            >
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              {copied ? '已複製' : '複製'}
            </button>
          </p>
          <p className="mt-2">
            放心：Airwallex 可以開多個 webhook，你內部系統嗰個唔會受影響。
          </p>
        </div>

        <div>
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary !px-6 !py-2.5 text-[14px] disabled:opacity-60"
          >
            {saving ? <WishingStar size={14} /> : <Save size={15} aria-hidden="true" />}
            儲存 Airwallex 設定
          </button>
        </div>
      </form>
    </section>
  );
}
