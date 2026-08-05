/**
 * 會員推廣同意三態 badge（後台會員管理用）。
 *
 * 三態推導同 src/components/MarketingConsentModal.tsx 一致：
 * - 接受：marketingOptIn = true
 * - 未選：marketingOptIn = false ＋ marketingPromptedAt IS NULL ＋
 *   2026-08-05 或之前註冊（香港時間 2026-08-06 00:00 前，即 < 2026-08-05T16:00:00Z）
 * - 唔接受：其他 marketingOptIn = false 嘅情況
 */

// 香港時間 2026-08-06 00:00 ＝ UTC 2026-08-05T16:00:00Z
const CONSENT_CUTOFF = new Date("2026-08-05T16:00:00.000Z");

type ConsentState = "opted_in" | "undecided" | "opted_out";

function deriveState(
  optIn: boolean | null | undefined,
  promptedAt: string | Date | null | undefined,
  createdAt: string | Date | null | undefined,
): ConsentState {
  if (optIn) return "opted_in";
  if (!promptedAt && createdAt && new Date(createdAt) < CONSENT_CUTOFF) return "undecided";
  return "opted_out";
}

const STATE_META: Record<ConsentState, { label: string; className: string }> = {
  opted_in: { label: "接受", className: "bg-green-100 text-green-700" },
  undecided: { label: "未選", className: "bg-amber-100 text-amber-700" },
  opted_out: { label: "唔接受", className: "bg-stone-200 text-stone-500" },
};

export default function MarketingOptInBadge({
  optIn,
  promptedAt,
  createdAt,
}: {
  optIn: boolean | null | undefined;
  promptedAt: string | Date | null | undefined;
  createdAt: string | Date | null | undefined;
}) {
  const meta = STATE_META[deriveState(optIn, promptedAt, createdAt)];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${meta.className}`}>
      {meta.label}
    </span>
  );
}
