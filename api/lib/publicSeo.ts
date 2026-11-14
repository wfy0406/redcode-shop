import {
  PUBLIC_DISPATCH_POLICY,
  PUBLIC_OFFER_POLICY_TEXT,
  PUBLIC_PAYMENT_POLICY,
} from "@contracts/publicPolicies";

export interface PublicSeoSection {
  heading: string;
  text: string;
}

export interface PublicSeoLink {
  href: string;
  label: string;
}

export interface PublicSeoPage {
  title: string;
  description: string;
  heading: string;
  summary: string;
  sections?: readonly PublicSeoSection[];
  links: readonly PublicSeoLink[];
  /** 相對網址會由首口 HTML 注入器轉成 redcode.red 絕對網址。 */
  image?: string;
  /** 只放同公開可見內容一致嘅結構化資料；唔放評分、假案例或會過期嘅硬編碼價錢。 */
  structuredData?: Record<string, unknown>;
}

/**
 * 公開頁嘅單一內容來源：server 首口 meta、無 JavaScript 內容及 sitemap 共用。
 * 呢啲係頁面本身嘅真實摘要，唔係關鍵字堆疊或 crawler 專用文案；
 * 開咗 JavaScript 後照舊顯示原 React 頁，唔改已批准設計。
 */
export const PUBLIC_PAGES: Record<string, PublicSeoPage> = {
  "/": {
    title: "RedCode Fashion Design｜香港女裝直播網店",
    description:
      "RedCode Fashion Design 官方購物網站 — 香港女裝直播，主播 Glo Glo 為你揀選星空下最閃嘅衫。AI 試穿：影張相即刻試穿，即刻睇到著上身效果。不定期優惠、直播重溫、順豐站自取，VIP 會員尊享禮遇。",
    heading: "RedCode Fashion Design｜香港女裝直播網店",
    summary:
      "RedCode Fashion Design（Red Code HK直播台，@redcodexhk）係香港女裝直播網店，提供直播精選女裝、直播重溫、AI 試穿、順豐自取及 VIP 會員禮遇。",
    sections: [
      {
        heading: "直播選購同 AI 試穿",
        text: "你可以瀏覽最新商品、睇直播重溫，或者登入會員上載全身相，生成 RedCode 商品嘅 AI 穿著效果預覽。",
      },
    ],
    links: [
      { href: "/products", label: "全部貨品" },
      { href: "/try-on", label: "AI 試穿" },
      { href: "/live", label: "直播重溫" },
      { href: "/faq", label: "常見問題" },
      { href: "/about", label: "關於我們" },
    ],
  },
  "/products": {
    title: "全部貨品｜RedCode Fashion Design",
    // 唔准無條件承諾「直播優惠價發售」——並非件件貨都有折扣，
    // 品名／價錢／庫存以各商品頁為準（同 productSeoDescription 口徑一致）。
    description:
      "RedCode 直播精選女裝全部貨品，品名、價錢同庫存以各商品頁為準，順豐站/自提點/智能櫃自取，香港女裝網購。",
    heading: "RedCode 全部貨品",
    summary:
      "瀏覽 RedCode 香港女裝直播精選，商品頁列出品名、貨號、價錢、庫存、尺寸、相片及購買入口。",
    links: [
      { href: "/try-on", label: "先試 AI 穿著效果" },
      { href: "/live", label: "睇直播重溫" },
      { href: "/faq", label: "購物常見問題" },
    ],
  },
  "/live": {
    title: "直播重溫｜RedCode Fashion Design",
    // 唔准無條件承諾「直播優惠繼續生效」或固定開播頻率；品名／價錢／庫存以商品頁為準。
    description:
      "RedCode 直播出單及收款，亦可重溫直播再揀商品；官網購物支援付款截圖人工審核或 Airwallex 即時支付。品名、價錢同庫存以商品頁為準。",
    heading: "RedCode 直播重溫",
    summary:
      "重溫 RedCode 香港女裝直播，了解主播示範嘅款式同上身效果，再前往公開商品頁選購；直播訂單由 RedCode 出單及收款。",
    sections: [
      {
        heading: "直播出單及收款",
        text: PUBLIC_PAYMENT_POLICY.liveText,
      },
      {
        heading: "官網購物兩種付款方式",
        text: `${PUBLIC_PAYMENT_POLICY.methodsText}${PUBLIC_PAYMENT_POLICY.timeLimitsText}`,
      },
      {
        heading: "直播重溫同商品資料",
        text: "錯過直播都可以重溫已發佈場次，再前往公開商品頁選購；品名、價錢同庫存以商品頁為準，開播時間以 Facebook 專頁公佈為準。",
      },
    ],
    links: [
      { href: "/products", label: "全部貨品" },
      { href: "/about", label: "認識 Glo Glo 同 RedCode" },
      { href: "/faq", label: "付款及開播通知常見問題" },
    ],
  },
  "/about": {
    title: "關於我們｜RedCode Fashion Design",
    description:
      "RedCode Fashion Design 係香港女裝直播網店，主播 Glo Glo 直播揀衫，為你帶嚟星空下最閃嘅款式。網站設 AI 試穿——影張相即刻試穿，即刻睇到著上身效果。",
    heading: "關於 RedCode Fashion Design",
    summary:
      "RedCode Fashion Design 係香港女裝直播網店。主播 Glo Glo 喺直播逐件示範質地、尺寸同上身效果，官方網站提供商品選購、直播重溫及 AI 試穿。",
    sections: [
      {
        heading: "品牌名稱同官方渠道",
        text: "RedCode Fashion Design 亦以 RedCode、Red Code HK直播台及 @redcodexhk 為人認識；官方網站係 redcode.red，官方 Facebook 專頁係 facebook.com/redcodexhk。",
      },
      {
        heading: "不定期優惠",
        text: PUBLIC_OFFER_POLICY_TEXT,
      },
    ],
    links: [
      { href: "/live", label: "直播重溫" },
      { href: "/products", label: "全部貨品" },
      { href: "/try-on", label: "AI 試穿" },
      { href: "/faq", label: "常見問題" },
    ],
  },
  "/web-design": {
    title: "香港網站設計｜前台、後台及 SEO 套票｜RedCode",
    description:
      "RedCode 網站設計：一頁式前台或前台＋後台，逐項列明香港市場對照價、折扣及 SEO 驗證項目；可網上落單、上載付款截圖及自助查詢進度。",
    heading: "你嘅生意，值得被看見。",
    summary:
      "RedCode 提供只要前台及前台＋後台兩種網站設計方案。你可以按需要逐項加入 SEO、內容管理、留言管理或員工權限功能，再喺同一頁確認價錢及落單。",
    sections: [
      {
        heading: "方案同價錢逐項睇清楚",
        text: "只要前台適合展示既定內容；前台＋後台就俾你自行修改資料。每個可選項目列明 RedCode 價、香港市場對照價、折扣同可慳金額，雲端託管、維護及網域費用亦分開說明。",
      },
      {
        heading: "SEO 做實事，唔承諾排名",
        text: "可選項目包括頁面標題及描述、canonical、robots、sitemap、分享預覽、結構化資料、語義標題、圖片替代文字，以及逐項驗證報告。驗證結果會照實記錄，唔會保證搜尋排名。",
      },
      {
        heading: "落單後有正式訂單圖同專屬查詢",
        text: "揀好方案同功能後，可填寫要求、風格及備註，建立正式訂單；之後用完整姓名同電話查詢網站設計訂單。呢類服務訂單同一般商品訂單分開保存及查詢。",
      },
    ],
    links: [
      { href: "/web-design#pricing", label: "睇方案同逐項價錢" },
      { href: "/web-design#contact", label: "查詢或建立訂單" },
      { href: "/", label: "返回 RedCode 首頁" },
    ],
    image: "/web-design/web-design-og.webp",
    structuredData: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Service",
          "@id": "https://redcode.red/web-design#service",
          name: "香港網站設計",
          serviceType: "網站設計、前台及後台建置、技術 SEO",
          description:
            "只要前台或前台＋後台方案，可逐項加入 SEO、內容管理、留言管理及員工權限功能，並提供驗證報告。",
          url: "https://redcode.red/web-design",
          provider: { "@id": "https://redcode.red/#org" },
          areaServed: { "@type": "Country", name: "Hong Kong" },
          inLanguage: "zh-Hant-HK",
        },
      ],
    },
  },
  "/vip": {
    title: "VIP 會員｜RedCode Fashion Design",
    description: "RedCode VIP 會員專享折扣同禮遇，消費累積升級，直播粉絲專屬福利。",
    heading: "RedCode VIP 會員制度",
    summary:
      "了解 RedCode 會員等級、消費累積升級、專屬折扣及禮遇；實際會員資格同優惠以帳戶資料為準。",
    links: [
      { href: "/products", label: "全部貨品" },
      { href: "/faq", label: "會員常見問題" },
      { href: "/terms", label: "服務條款" },
    ],
  },
  "/sf-stations": {
    title: "順豐自取點｜RedCode Fashion Design",
    description: "搜尋全港順豐站、自提點同智能櫃，落單揀最近嘅自取點，香港女裝網購取貨更方便。",
    heading: "香港順豐站、自提點同智能櫃查詢",
    summary:
      "按地址或位置搜尋香港順豐站、自提點同智能櫃，方便喺 RedCode 落單時選擇收貨地點。",
    links: [
      { href: "/products", label: "全部貨品" },
      { href: "/faq", label: "運費同自取常見問題" },
      { href: "/returns", label: "退換貨政策" },
    ],
  },
  "/privacy": {
    title: "私隱政策｜RedCode Fashion Design",
    description: "RedCode Fashion Design 私隱政策——我哋點樣收集、使用同保障你嘅個人資料。",
    heading: "RedCode 私隱政策",
    summary:
      "了解 RedCode 收集、使用、保存及保障個人資料嘅安排，以及你嘅私隱權利同聯絡方法。",
    links: [
      { href: "/terms", label: "服務條款" },
      { href: "/returns", label: "退換貨政策" },
      { href: "/faq", label: "常見問題" },
    ],
  },
  "/terms": {
    title: "服務條款｜RedCode Fashion Design",
    description: "RedCode Fashion Design 服務條款——購物、退換貨同會員制度嘅使用細則。",
    heading: "RedCode 服務條款",
    summary:
      "查閱 RedCode 網站使用、商品訂購、付款、會員制度、AI 試穿及退換貨嘅正式條款。",
    links: [
      { href: "/returns", label: "退換貨政策" },
      { href: "/privacy", label: "私隱政策" },
      { href: "/faq", label: "常見問題" },
    ],
  },
  "/returns": {
    title: "退換貨政策｜RedCode Fashion Design",
    description:
      "RedCode 寄出及退換貨政策——正常約 7–10 個工作天寄出，部分商品可能更久；收貨 7 天內可提出退換申請。",
    heading: "RedCode 退換貨政策",
    summary:
      "正常情況下，訂單確認後約 7–10 個工作天寄出，惟部分商品可能需要更久。收到貨 7 天內，貨品有破損或寄錯貨，經核實可更換或退款；尺寸不合，同款有存貨時原則上可安排換貨。",
    sections: [
      {
        heading: "寄出時間（與退換期限分開）",
        text: `${PUBLIC_DISPATCH_POLICY.visibleText}${PUBLIC_DISPATCH_POLICY.clarificationText}`,
      },
      {
        heading: "申請期限同貨品狀態",
        text: "退換申請須喺收到貨品當日起計 7 天內提出；貨品須未經穿著或使用、吊牌未剪、原包裝完整，唔影響二次銷售。",
      },
      {
        heading: "點樣申請",
        text: "先經政策頁列出嘅 WhatsApp、Facebook Messenger 或電郵聯絡客服，附上訂單編號同貨品相片，再按同事指示寄回；未經聯絡自行寄回嘅貨品未必可以處理。",
      },
    ],
    links: [
      { href: "/terms", label: "服務條款" },
      { href: "/faq", label: "常見問題" },
      { href: "/products", label: "全部貨品" },
    ],
  },
  "/faq": {
    title: "常見問題｜RedCode Fashion Design",
    description:
      "RedCode 常見問題——訪客結帳、付款、出貨、退換貨、順豐自取、AI 試穿、手機 APP 安裝及開播通知教學。",
    heading: "RedCode 常見問題",
    summary:
      "呢頁直接解答 RedCode 購物、付款、出貨、退換、順豐自取、AI 試穿、手機安裝及開播通知問題。",
    sections: [
      {
        heading: "唔開帳號買唔買到？",
        text: `買到！用訪客快速結帳，填稱呼、電話同 email 就落得單。${PUBLIC_PAYMENT_POLICY.guestMethodText}${PUBLIC_PAYMENT_POLICY.timeLimitsText}訪客訂單逾時會自動取消。之後喺「我的訂單」頁用訂單編號＋電話就查到進度。不過開個帳號更著數——有積分同 VIP 折扣。`,
      },
      {
        heading: "付款方便嗎？",
        text: `好方便！${PUBLIC_PAYMENT_POLICY.methodsText}請按結帳頁提供嘅方式完成付款。`,
      },
      {
        heading: "落單過程係點？",
        text: "整個流程好簡單，得四步：購買（揀貨落單）→ 付款（即時支付，或按付款資料轉帳／支付後上傳截圖）→ 審批（我哋同事核實）→ 確認訂單（審批通過後訂單正式成立，等出貨）。",
      },
      {
        heading: "出貨時間？",
        text: `${PUBLIC_DISPATCH_POLICY.visibleText}${PUBLIC_DISPATCH_POLICY.clarificationText}出咗貨會有通知話你知，記得留意。`,
      },
      {
        heading: "即時支付安全嗎？",
        text: "放心，我哋用 Airwallex 收款平台（國際認證、持牌機構），我哋全程接觸唔到你嘅信用卡資料，卡資料由平台直接處理。",
      },
      {
        heading: "有瑕疵點算？",
        text: "如果收到貨發現有瑕疵，收貨後 7 天內可以提出退換貨，我哋會盡快幫你跟進。",
      },
      {
        heading: "會員制度係點？",
        text: "消費會累積升級會員等級，等級愈高，享有嘅折扣同專屬優惠就愈多。詳情可以睇會員制度介紹。",
      },
      {
        heading: "順豐站點查詢點用？",
        text: "結帳或者帳戶頁可以用 GPS 一撳搵最近站點（順豐站／自提點／智能櫃分類清楚），搵到啱嘅可以即時預設做自己收貨站點；亦可以輸入詳細地址慢慢搵。",
      },
      {
        heading: "幾多錢包郵？",
        text: "揀順豐站／自提點／智能櫃自取，買滿 $350 就免運費，湊夠數就唔使畀。送貨上門就一律順豐到付，運費收貨時直接畀順豐。",
      },
      {
        heading: "訂閱通知會收到咩？",
        text: "只會收到開播通知，唔會收到會員購買嘅通知同動作，唔怕滋擾。",
      },
      {
        heading: "想取消接收通知喺邊到取消？",
        text: "到我嘅帳戶頁，撳熄「開播通知」開關就得，隨時開返都得。",
      },
      {
        heading: "網站可以裝落手機主畫面嗎？",
        text: "可以！我哋係 PWA 網頁應用，直接用瀏覽器安裝就得，唔係 App Store／Google Play 上架嘅 app，唔使去商店搵。詳細 iPhone／Android 步驟同真正安裝掣，請睇「安裝 APP 教學」。如果你喺其他 app 內置瀏覽器睇緊，請先用系統瀏覽器（Safari／Chrome）開返個網站再裝。",
      },
      {
        heading: "AI 試穿點玩？",
        text: "想跟住片做，可以先睇 70 秒 AI 試穿教學。成個流程好簡單：先登入會員，去 AI 試穿頁，準備一張全身相（前鏡自拍、後鏡拍攝或相簿揀相都得；前鏡可以將手機拎遠少少，後鏡可以請家人幫手）→ 揀想試嘅商品 → 提交之後系統會異步生成，唔使一直等，一陣返嚟就有得睇 → 睇前後對照，鍾意可以下載／分享，唔鍾意可以刪除。結果會幫你保留 24 小時，過咗就會自動清除。",
      },
      {
        heading: "試穿相係咪一定要好光、用後鏡？",
        text: "唔使。前鏡同後鏡都用得，亦可以直接由相簿上載；一般室內光線、唔算完美嘅相都可以先試，唔使專業打燈。如果張相完全非人像或者真係極暗，系統會先請你換相，避免浪費生成額度；呢種情況未送 AI 生成，亦未預留或扣除 credits。",
      },
      {
        heading: "Mix & Match 混搭係點計？",
        text: "Mix & Match 每件衫都係獨立生成、獨立扣額：每套最多 3 件，每件都要你確認咗先追加下一件；相同穿著部位唔可以重複（例如唔可以一套兩件上身）。如果中途生成失敗，唔會扣你個人每日額度，放心試。",
      },
      {
        heading: "AI 預覽可以當尺碼參考嗎？",
        text: "唔可以。AI 試穿只係視覺效果預覽，唔代表尺碼、鬆緊、合身程度或者著上身嘅舒適度。揀碼請以尺寸表同實物為準，有疑問隨時問我哋。",
      },
      {
        heading: "鏡頭權限被拒絕咗點算？",
        text: "有兩條路：一、喺試穿頁撳「重新檢查鏡頭權限」再試；二、唔使鏡頭，直接用相簿揀相上載。留意網頁冇辦法直接幫你開系統設定——如果之前拒絕過，要你自己去瀏覽器嘅網站設定或者系統設定度，將相機權限開返俾我哋個網站。如果你係喺其他 app 嘅內置瀏覽器（WebView）入面用，權限係由嗰個 app 同系統控制，我哋網頁改唔到，建議用系統瀏覽器開返。",
      },
      {
        heading: "上載相／生成失敗點算？",
        text: "常見原因有幾個：HEIC 格式（iPhone 預設）未必支援，可以先轉做 JPG／PNG；格式唔啱或者檔案太大都會食唔到，縮細啲再試；權限未開就開返相簿／鏡頭；網絡唔穩就換個好啲嘅訊號再提交。搞唔掂就 cap 圖搵我哋跟進。",
      },
      {
        heading: "用 WhatsApp 分享試穿結果安全嗎？",
        text: "WhatsApp 分享會帶你嘅 24 小時效果連結同公開商品資料；連結有效期內，收到連結嘅人可以睇到效果圖。主要分享按鈕會直接傳出 PNG 效果圖，唔會附上原相或會員資料。你可以喺結果區即時刪除網站分享存取，但已下載或已傳出嘅 PNG 無法撤回。",
      },
    ],
    links: [
      { href: "/products", label: "全部貨品" },
      { href: "/try-on", label: "AI 試穿" },
      { href: "/returns", label: "退換貨政策" },
      { href: "/sf-stations", label: "順豐自取點" },
    ],
  },
  "/try-on": {
    title: "AI 試穿｜RedCode Fashion Design",
    description:
      "RedCode AI 試穿——上載全身相，揀選 RedCode 商品，生成 AI 穿著效果預覽，支援前後對照、下載及分享；會員登入後使用。",
    heading: "RedCode AI 試穿",
    summary:
      "登入會員後，上載全身相並揀選 RedCode 商品，系統會生成 AI 穿著效果預覽，方便你對照、下載、分享，再前往商品頁選購。",
    sections: [
      {
        heading: "點樣開始",
        text: "準備一張全身相，可以用前鏡、後鏡或相簿相片；登入後揀想試嘅商品並提交，生成完成後就可以睇前後對照。常見問題頁另有 70 秒教學影片。",
      },
      {
        heading: "AI 預覽唔等於尺碼建議",
        text: "AI 試穿只係視覺效果預覽，唔代表實際尺碼、鬆緊、合身程度或舒適度；尺寸請以商品尺寸表及實物為準。",
      },
      {
        heading: "相片格式同私隱",
        text: "相片最少要 300 × 300 像素，支援 JPEG、PNG 或 WebP；HEIC／HEIF 請先輸出做 JPEG。私人原相及結果預設保留 24 小時，唔會公開喺商品圖庫，亦可以喺結果區即時刪除。",
      },
    ],
    links: [
      { href: "/products", label: "揀 RedCode 商品" },
      { href: "/faq#ai-tryon-tutorial", label: "睇 70 秒 AI 試穿教學" },
      { href: "/live", label: "睇直播上身示範" },
      { href: "/privacy", label: "私隱政策" },
    ],
  },
  "/lucky-results": {
    title: "中獎公告｜RedCode Fashion Design",
    description: "RedCode 直播抽獎中獎公告——即場抽出嘅真實幸運兒名單，下一個可能係你。",
    heading: "RedCode 直播抽獎中獎公告",
    summary:
      "查閱 RedCode 直播抽獎活動同公開中獎名單；頁面只展示公開活動資料、對外顯示名同獎品，唔公開電話、電郵、地址或會員編號。",
    links: [
      { href: "/live", label: "直播重溫" },
      { href: "/products", label: "全部貨品" },
      { href: "/try-on", label: "AI 試穿" },
    ],
  },
};

/**
 * FAQPage 由同一份可見 Q&A 即時生成，避免結構化資料同頁面答案漂移。
 * 只描述 /faq 真正公開嘅問題同答案；唔代表 Google 一定展示 FAQ rich result。
 */
export function faqPageStructuredData(): Record<string, unknown> {
  const page = PUBLIC_PAGES["/faq"];
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: "https://redcode.red/faq",
    inLanguage: "zh-Hant-HK",
    mainEntity: (page.sections ?? []).map((section) => ({
      "@type": "Question",
      name: section.heading,
      acceptedAnswer: {
        "@type": "Answer",
        text: section.text,
      },
    })),
  };
}

export const LUCKY_EVENT_SEO = {
  title: "中獎名單｜RedCode Fashion Design",
  description: "RedCode 直播抽獎中獎公告——即場抽出嘅真實幸運兒名單，下一個可能係你。",
};

/** 對外公告總開關關閉時嘅首口 SEO；同 client 關閉頁用字一致，唔再公開舊公告摘要。 */
export const LUCKY_ANNOUNCEMENT_CLOSED_SEO = {
  title: "中獎公告已關閉｜RedCode Fashion Design",
  description:
    "RedCode 對外抽獎公告功能暫時關閉；持有抽獎劵嘅客人可繼續用店家提供嘅專屬查劵連結自助查詢。",
} as const;

/**
 * 總開關關閉時嘅無 JS 首口內容：唔注入任何活動名、場次資料或中獎者；
 * 有合法 eventId 就先保留該場獨立查劵入口，查劵功能唔受公告開關影響。
 */
export function injectLuckyAnnouncementClosedContent(html: string, eventId?: number): string {
  try {
    if (html.includes('id="redcode-public-seo"')) return html;
    const validEventId = Number.isSafeInteger(eventId) && Number(eventId) > 0 ? Number(eventId) : null;
    const ticketLink = validEventId
      ? `<p><a href="/lucky-tickets/${validEventId}">查自己有幾多張抽獎劵</a></p>`
      : "";
    const block =
      `<main id="redcode-public-seo" data-redcode-prerender style="max-width:56rem;margin:0 auto;padding:4rem 1.5rem;color:#fff;background:#0a0614;line-height:1.8">` +
      `<h1>對外中獎公告已關閉</h1>` +
      `<p>${esc(LUCKY_ANNOUNCEMENT_CLOSED_SEO.description)}</p>${ticketLink}` +
      `<nav aria-label="相關公開頁面"><ul><li><a href="/">返回 RedCode 首頁</a></li></ul></nav></main>`;
    return html.replace("</body>", `    ${block}\n  </body>`);
  } catch {
    return html;
  }
}

/** 總開關／活動資料讀取失敗：中性暫時不可用，唔虛構成已關閉，亦唔 fallback 出公告宣傳。 */
export const LUCKY_ANNOUNCEMENT_UNAVAILABLE_SEO = {
  title: "中獎公告暫時未能顯示｜RedCode Fashion Design",
  description:
    "RedCode 中獎公告暫時未能顯示，請稍後再試；持有抽獎劵嘅客人可繼續用店家提供嘅專屬查劵連結自助查詢。",
} as const;

/** 讀取失敗時嘅無 JS 首口內容：零活動名、零中獎者；查劵入口照常保留。 */
export function injectLuckyAnnouncementUnavailableContent(html: string, eventId?: number): string {
  try {
    if (html.includes('id="redcode-public-seo"')) return html;
    const validEventId = Number.isSafeInteger(eventId) && Number(eventId) > 0 ? Number(eventId) : null;
    const ticketLink = validEventId
      ? `<p><a href="/lucky-tickets/${validEventId}">查自己有幾多張抽獎劵</a></p>`
      : "";
    const block =
      `<main id="redcode-public-seo" data-redcode-prerender style="max-width:56rem;margin:0 auto;padding:4rem 1.5rem;color:#fff;background:#0a0614;line-height:1.8">` +
      `<h1>對外中獎公告暫時未能顯示</h1>` +
      `<p>${esc(LUCKY_ANNOUNCEMENT_UNAVAILABLE_SEO.description)}</p>${ticketLink}` +
      `<nav aria-label="相關公開頁面"><ul><li><a href="/">返回 RedCode 首頁</a></li></ul></nav></main>`;
    return html.replace("</body>", `    ${block}\n  </body>`);
  } catch {
    return html;
  }
}

/** Sitemap 只放 canonical、公開、可收錄嘅靜態頁；商品網址由現有 DB 查詢加入。 */
export const SITEMAP_STATIC_PATHS = [
  "/products",
  "/live",
  "/about",
  "/web-design",
  "/vip",
  "/sf-stations",
  "/privacy",
  "/terms",
  "/returns",
  "/faq",
  "/try-on",
  "/lucky-results",
] as const;

/** Sitemap 只加入後台已確認公開嘅單場公告；唔用抽獎日期冒充內容修改日期。 */
export function publicLuckyEventSitemapPaths(eventIds: readonly number[]): string[] {
  const validIds = eventIds.filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(validIds)].map((id) => `/lucky-results/${id}`);
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 首口 HTML 嘅真內容，唔再只收埋喺 noscript：無 JavaScript 嘅訪客同 crawler 都直接讀到。
 * React 成功 mount 後會移除 data-redcode-prerender 區塊；#root 保持空，唔破壞白屏自救。
 */
export function renderPublicContent(pathname: string): string {
  const page = PUBLIC_PAGES[pathname];
  if (!page) return "";
  const sections = (page.sections ?? [])
    .map(
      (section) =>
        `<section><h2>${esc(section.heading)}</h2><p>${esc(section.text)}</p></section>`,
    )
    .join("");
  const links = page.links
    .map((link) => `<li><a href="${esc(link.href)}">${esc(link.label)}</a></li>`)
    .join("");
  return (
    `<main id="redcode-public-seo" data-redcode-prerender style="max-width:56rem;margin:0 auto;padding:4rem 1.5rem;color:#fff;background:#0a0614;line-height:1.8"><h1>${esc(page.heading)}</h1>` +
    `<p>${esc(page.summary)}</p>${sections}` +
    `<nav aria-label="相關公開頁面"><ul>${links}</ul></nav></main>`
  );
}

/** SPA fallback 開頭先移除首頁預設內容，再按實際路由注入，避免私人頁／商品頁帶錯摘要。 */
export function stripPublicSeoContent(html: string): string {
  return html.replace(/[ \t]*<main id="redcode-public-seo"[^>]*>[\s\S]*?<\/main>\s*/g, "");
}

/** 注入失敗只係回原 HTML，唔阻正常出頁；同一頁唔會重複注入。 */
export function injectPublicSeoContent(html: string, pathname: string): string {
  try {
    if (html.includes('id="redcode-public-seo"')) return html;
    const block = renderPublicContent(pathname);
    if (!block) return html;
    return html.replace("</body>", `    ${block}\n  </body>`);
  } catch {
    return html;
  }
}
