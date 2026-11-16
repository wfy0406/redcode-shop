/**
 * 客人可見政策嘅單一來源：React 頁、server 首口 HTML 及 Product JSON-LD 共用。
 * 只放已確認業務事實；寄出時間、送達時間同退換期限係三個唔同概念，唔准溝埋。
 */
export const PUBLIC_DISPATCH_POLICY = {
  minBusinessDays: 7,
  maxBusinessDays: 10,
  visibleText: "正常情況下，訂單確認後約 7–10 個工作天寄出，惟部分商品可能需要更久。",
  shortText: "正常情況下約 7–10 個工作天寄出，惟部分商品可能需要更久。",
  emailText: "一般約 7–10 個工作天寄出，部分商品或需更久；寄出時間唔等於送達保證。",
  clarificationText: "呢個係寄出時間，唔係保證送達時間，亦唔係收貨後 7 天嘅退換申請期限。",
} as const;

export const PUBLIC_RETURN_POLICY = {
  applicationDays: 7,
  /** 申請期限＋貨品狀態＋先聯絡客服（同 Returns.tsx 第 01/06 節、Terms 第 12 節一致）。 */
  conditionsText:
    "收到貨品當日起計 7 天內可提出退換申請；貨品須未經穿著或使用、吊牌未剪、原包裝完整，唔影響二次銷售，並請先聯絡客服確認。",
  /** 運費承擔（同 Returns.tsx 2.3／3.3 一致）：破損／寄錯貨店方包來回；尺寸換貨客人到付。 */
  feesText:
    "貨品破損或寄錯貨嘅退換，來回運費由我哋承擔；尺寸更換嘅來回運費由客人承擔（順豐到付）。",
} as const;

// 順豐運費政策單一來源（同 Terms.tsx 11.2 及 FAQ「幾多錢包郵」一致）：
// 自取滿 HK$350 免運；未滿門檻嘅自取同所有送貨上門一律順豐到付，運費以順豐官方收費為準。
const SHIPPING_PICKUP_FREE_TEXT = "順豐站／自提點／智能櫃自取滿 HK$350 免運";
const SHIPPING_FREIGHT_COLLECT_TEXT =
  "未滿免運門檻嘅自取訂單同送貨上門，一律順豐到付，運費以順豐官方收費為準";

export const PUBLIC_SHIPPING_POLICY = {
  /** 自取免運門檻（港元整數）；實際門檻以結帳頁不時公布為準。 */
  freePickupThresholdHKD: 350,
  pickupFreeText: SHIPPING_PICKUP_FREE_TEXT,
  freightCollectText: SHIPPING_FREIGHT_COLLECT_TEXT,
  visibleText: `${SHIPPING_PICKUP_FREE_TEXT}；${SHIPPING_FREIGHT_COLLECT_TEXT}。`,
} as const;

export const PUBLIC_PAYMENT_POLICY = {
  guestMinutes: 30,
  memberHours: 48,
  liveText: "直播訂單由 RedCode 出單及收款，請按直播訂單指示完成付款。",
  methodsText:
    "官網購物有兩種付款方式：按官網付款資料轉帳或支付，再上傳截圖供人工審核；或者使用 Airwallex 即時支付工具直接付款。實際可用方式以訂單類型同結帳頁顯示為準。",
  guestMethodText:
    "訪客快速結帳只使用 Airwallex 即時支付，唔接受手動過數或上傳付款截圖。",
  timeLimitsText:
    "30 分鐘付款時限只適用於官網訪客訂單；會員可於 48 小時內支付，以完成下單流程。",
} as const;

export const PUBLIC_OFFER_POLICY_TEXT =
  "RedCode 會不定期推出優惠，實際內容、適用商品及期限以當次直播或官網公佈為準。";
