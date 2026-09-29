/**
 * v2.2.0 VIP 級別主題（全網級別格調統一入口）
 * 老闆指示：「vip銀，金同會員介面（全網介面，不論購物車，支付頁面等）要有d唔同，風格或格調」
 *
 * 用法：
 *   const t = vipTierTheme(me?.vipTier);
 *   <span className={t.chipClass}>…</span> ／ style={{ color: t.accent }}
 *
 * ⚠ Tailwind JIT 只掃字面量 — 本檔所有 class 係完整字串，唔准拆句拼接。
 * ⚠ 動畫只准 opacity/transform（老闆鐵律）。
 */

export type VipTierKey = "NONE" | "SILVER" | "GOLD";

export interface VipTierTheme {
  key: VipTierKey;
  /** 全名：普通會員 / VIP 銀會員 / VIP 金會員 */
  label: string;
  /** 短名：會員 / 銀・VIP / 金・VIP */
  shortLabel: string;
  isVip: boolean;
  /** 主 accent（hex）— 銀=鉑銀灰藍、金=香檳金、普通=品牌金 */
  accent: string;
  /** 深色 accent（hover/標題） */
  accentDeep: string;
  /** 柔和文字色（放奶油底上） */
  softText: string;
  /** hairline 邊框 class（完整字面量） */
  hairlineClass: string;
  /** 級別 chip（pill）完整 class */
  chipClass: string;
  /** 級別卡面漸變 class（底用） */
  washClass: string;
  /** 絲綢橫幅圖（普通會員冇） */
  ribbonImg: string | null;
  /** 印章符號 */
  seal: string;
}

const NONE_THEME: VipTierTheme = {
  key: "NONE",
  label: "普通會員",
  shortLabel: "會員",
  isVip: false,
  accent: "#ab8c52",
  accentDeep: "#8a6d1f",
  softText: "#6b5847",
  hairlineClass: "border border-[#ab8c52]/25",
  chipClass:
    "inline-flex items-center gap-1 rounded-full border border-[#ab8c52]/30 bg-[#fcfcf8] px-2.5 py-0.5 text-[11px] tracking-[0.18em] text-[#6b5847]",
  washClass: "bg-gradient-to-b from-[#fcfcf8] to-[#f7f3ea]",
  ribbonImg: null,
  seal: "✧",
};

const SILVER_THEME: VipTierTheme = {
  key: "SILVER",
  label: "VIP 銀會員",
  shortLabel: "銀・VIP",
  isVip: true,
  accent: "#7e8794",
  accentDeep: "#5d6673",
  softText: "#5d6673",
  hairlineClass: "border border-[#7e8794]/45",
  chipClass:
    "inline-flex items-center gap-1 rounded-full border border-[#7e8794]/50 bg-gradient-to-r from-[#f4f6f8] to-[#e8ebef] px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.18em] text-[#4d5661]",
  washClass: "bg-gradient-to-b from-[#f6f7f9] to-[#eceef2]",
  ribbonImg: "/vip/tier-silver.jpg",
  seal: "✦",
};

const GOLD_THEME: VipTierTheme = {
  key: "GOLD",
  label: "VIP 金會員",
  shortLabel: "金・VIP",
  isVip: true,
  accent: "#ab8c52",
  accentDeep: "#8a6d1f",
  softText: "#8a6d1f",
  hairlineClass: "border border-[#ab8c52]/55",
  chipClass:
    "inline-flex items-center gap-1 rounded-full border border-[#ab8c52]/60 bg-gradient-to-r from-[#faf3e3] to-[#f3e7c8] px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.18em] text-[#8a6d1f]",
  washClass: "bg-gradient-to-b from-[#fbf6ea] to-[#f5ecd7]",
  ribbonImg: "/vip/tier-gold.jpg",
  seal: "✦",
};

export function vipTierTheme(tier: string | null | undefined): VipTierTheme {
  if (tier === "GOLD") return GOLD_THEME;
  if (tier === "SILVER") return SILVER_THEME;
  return NONE_THEME;
}

/** 會員編號格式：RC-000128（全網統一，證書/驗證頁/會員中心都用佢） */
export function formatMemberNo(userId: number): string {
  return `RC-${String(userId).padStart(6, "0")}`;
}
