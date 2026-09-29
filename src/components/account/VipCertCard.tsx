import { useState } from 'react';
import { Link } from 'react-router';
import { FileImage, FileText } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import { vipTierTheme, formatMemberNo } from '@/lib/vipTheme';

/**
 * v2.2.0 會員證書下載（英式 atelier 克制感）—— trpc.vip.myCertificate
 * ・顯示級別徽章（vipTierTheme chipClass/seal）、會員編號 RC-XXXXXX、生效／有效期
 * ・兩個底線文字掣：「下載證書 JPG」「下載證書 PDF」（base64 → Blob → a[download]）
 * ・歷史晉升都下載到：user.vipTier ∈ SILVER/GOLD（包括已過期）或 vipEffectiveAt 非空先顯示下載掣；
 *   否則低調提示「晉升 VIP 後可於此處下載專屬證書」＋去 /vip 入口
 * ・hairline 金線面板（唔係玻璃卡叠卡）；動畉淨 opacity；繁體中文唔准 italic
 */

type CertFormat = 'jpg' | 'pdf';

const CERT_MIME: Record<CertFormat, string> = {
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** base64 → Blob → URL.createObjectURL → a[download=filename].click() */
function downloadBase64File(base64: string, filename: string, mime: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Date/ISO → 2027年1月5日 */
function fmtDateTc(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export default function VipCertCard() {
  const { user } = useAuth();
  const [downloading, setDownloading] = useState<CertFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  // myCertificate 後端係 query procedure（never-throw，回 ok:false）——用 utils.fetch 手動觸發
  const utils = trpc.useUtils();

  if (!user) return null;

  // auth.me 回嘅係 DB 原始 vipTier（過期都仲係 SILVER/GOLD），啱晒「歷史晉升都下載到」
  const rawTier = user.vipTier ?? 'NONE';
  // vipEffectiveAt 喺 v2.2.0 auth.me 先補返；舊後端冇嘅話當 null（防禦式讀取）
  const vipEffectiveAt =
    (user as { vipEffectiveAt?: string | null }).vipEffectiveAt ?? null;
  const vipExpiresAt = user.vipExpiresAt ?? null;
  const t = vipTierTheme(rawTier);
  const eligible = rawTier === 'SILVER' || rawTier === 'GOLD' || !!vipEffectiveAt;
  const expired = !!vipExpiresAt && new Date(vipExpiresAt).getTime() <= Date.now();

  const handleDownload = async (format: CertFormat) => {
    if (downloading) return;
    setError(null);
    setDownloading(format);
    try {
      const res = await utils.vip.myCertificate.fetch({ format });
      if (res.ok) {
        downloadBase64File(res.base64, res.filename, CERT_MIME[format]);
      } else {
        setError(res.error || '證書暫時未能下載，請稍後再試。');
      }
    } catch {
      setError('證書暫時未能下載，請稍後再試。');
    } finally {
      setDownloading(null);
    }
  };

  // 未晉升過 VIP：低調提示＋ /vip 入口
  if (!eligible) {
    return (
      <section
        aria-label="會員證書"
        className="border border-dashed px-6 py-10 text-center md:px-10"
        style={{ borderColor: 'var(--space-line)' }}
      >
        <p className="font-serif-tc text-[15px] text-txt-2">
          晉升 VIP 後可於此處下載專屬證書
        </p>
        <Link
          to="/vip"
          className="mt-3 inline-block border-b pb-0.5 text-[13px] font-medium text-gold-soft transition-opacity hover:opacity-70"
          style={{ borderColor: 'var(--gold)' }}
        >
          了解會員制度 →
        </Link>
      </section>
    );
  }

  return (
    <section
      aria-label="會員證書下載"
      className={`${t.hairlineClass} ${t.washClass} px-6 py-8 md:px-10 md:py-10`}
    >
      {/* 頂行：級別徽章（chipClass＋seal）＋會員編號 */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <span className={t.chipClass}>
          {t.seal} {t.label}
        </span>
        <p className="font-mono text-[12px] tracking-[0.18em]" style={{ color: t.softText }}>
          會員編號 {formatMemberNo(user.id)}
        </p>
      </div>

      {/* editorial serif 標題 */}
      <h3
        className="mt-5 font-serif-tc text-xl font-semibold leading-[1.35] md:text-2xl"
        style={{ color: t.accentDeep }}
      >
        專屬會員證書
      </h3>
      <p className="mt-2 max-w-xl text-[14px] leading-[1.75]" style={{ color: t.softText }}>
        多謝你一路同行。你嘅 {t.label}
        證書已備妥，可隨時下載珍藏或分享；歷年晉升紀錄同樣適用。
      </p>

      {/* 生效／有效期（hairline 分隔） */}
      <dl
        className="mt-6 flex flex-wrap gap-x-10 gap-y-3 border-t pt-5 text-[13px]"
        style={{ borderColor: t.accent, color: t.softText }}
      >
        <div className="flex items-baseline gap-2">
          <dt>生效日期</dt>
          <dd className="font-mono">{fmtDateTc(vipEffectiveAt)}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt>有效期至</dt>
          <dd className="font-mono">
            {fmtDateTc(vipExpiresAt)}
            {expired && <span className="ml-2 text-[12px]">（已到期，證書仍可下載留念）</span>}
          </dd>
        </div>
      </dl>

      {/* 底線文字掣（唔係大色塊） */}
      <div className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-3">
        <button
          type="button"
          onClick={() => handleDownload('jpg')}
          disabled={downloading !== null}
          className="inline-flex items-center gap-2 border-b pb-1 text-[14px] font-semibold transition-opacity hover:opacity-70 disabled:cursor-wait disabled:opacity-50"
          style={{ color: t.accentDeep, borderColor: t.accent }}
        >
          <FileImage size={15} aria-hidden="true" />
          {downloading === 'jpg' ? 'JPG 下載中…' : '下載證書 JPG'}
        </button>
        <button
          type="button"
          onClick={() => handleDownload('pdf')}
          disabled={downloading !== null}
          className="inline-flex items-center gap-2 border-b pb-1 text-[14px] font-semibold transition-opacity hover:opacity-70 disabled:cursor-wait disabled:opacity-50"
          style={{ color: t.accentDeep, borderColor: t.accent }}
        >
          <FileText size={15} aria-hidden="true" />
          {downloading === 'pdf' ? 'PDF 下載中…' : '下載證書 PDF'}
        </button>
      </div>

      {/* 失敗態 */}
      {error && (
        <p role="alert" className="mt-4 text-[13px]" style={{ color: t.accentDeep }}>
          {error}
        </p>
      )}
    </section>
  );
}
