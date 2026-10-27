/**
 * policyPages 源碼級測試（2026-10-26 政策審核）
 * --------------------------------
 * 唔行 React render，直接讀 Privacy.tsx／Terms.tsx 源碼做字串斷言，
 * 鎖死今次審核加入嘅重要披露，同埋禁止喺對外頁面披露 AI 供應商名、
 * 模型／prompt／生成參數／成本／API key／伺服器配置等技術或商業機密。
 * 純 fs 讀檔，唔連 DB、唔郁網絡。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const privacySrc = readFileSync(path.join(import.meta.dirname, "Privacy.tsx"), "utf8");
const termsSrc = readFileSync(path.join(import.meta.dirname, "Terms.tsx"), "utf8");

/** 兩頁都唔准出現嘅供應商／模型／技術配置／商業機密字眼 */
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/fashn/i, "AI 供應商名（FASHN）"],
  [/app[_-]?secret/i, "伺服器 secret 配置名"],
  [/api[_ ]?key/i, "API key 字眼"],
  [/prompt/i, "prompt／提示詞"],
  [/hmac|sha256|0o600|0o700/i, "簽名演算法或檔案權限等技術細節"],
  [/tryon_/i, "內部變數／env 名"],
  [/生成參數/, "生成參數"],
  [/seedream|midjourney|stable\s*diffusion|dall[- ]?e|gpt|gemini|claude/i, "AI 模型名"],
  [/已獲律師|律師審批|法律意見書/, "聲稱已獲律師審批"],
  [/保證完全符合|完全符合.{0,4}(條例|法例)/, "聲稱保證完全符合某法例"],
];

describe("政策頁更新日期", () => {
  it("兩頁都註明 2026 年 10 月 28 日", () => {
    expect(privacySrc).toContain("最近更新：2026 年 10 月 28 日");
    expect(termsSrc).toContain("最近更新：2026 年 10 月 28 日");
  });
});

describe("私隱政策：AI 試穿披露（第 2.6 節及相關節）", () => {
  it("有 2.6 AI 試穿相片、2.7 公開抽獎公告兩個新小節", () => {
    expect(privacySrc).toContain('2.6 AI 試穿相片');
    expect(privacySrc).toContain('2.7 公開抽獎公告');
  });

  it("寫明要客人主動拍攝／上載全身相，相機／相簿權限可撤回", () => {
    expect(privacySrc).toContain("主動提供一張全身相");
    expect(privacySrc).toContain("用裝置相機拍攝");
    expect(privacySrc).toContain("由相簿上載");
    expect(privacySrc).toContain("撤回權限");
  });

  it("寫明私人儲存、短期加密簽名連結、no-store、24 小時存取有效期、可即時刪除", () => {
    expect(privacySrc).toContain("私人儲存空間");
    expect(privacySrc).toContain("加密簽名連結");
    expect(privacySrc).toContain("no-store");
    expect(privacySrc).toContain("24 小時");
    expect(privacySrc).toContain("即時刪除");
  });

  it("保留表述準確：前台／分享 24h，到期後定期清理，唔過度承諾實體即時刪除", () => {
    expect(privacySrc).toContain("你嘅前台及分享存取（24 小時）");
    expect(privacySrc).toContain("到期後唔可以再經呢啲客戶頁面或分享連結開啟");
    expect(privacySrc).toContain("定期清理");
    expect(privacySrc).toContain("實際刪除完成時間稍為延後");
    // 唔准再寫「到期即自動刪除」式嘅過度承諾
    expect(privacySrc).not.toContain("之後系統自動刪除");
    expect(privacySrc).not.toContain("之後自動刪除");
    expect(privacySrc).not.toContain("最長保留 24 小時");
    expect(privacySrc).not.toContain("最多保留 24 小時");
  });

  it("分清後台 30 日圖片副本同較長期無圖業務紀錄；前台刪圖唔會即時刪走副本", () => {
    expect(privacySrc).toContain("主管／管理員後台副本（最多 30 日）");
    expect(privacySrc).toContain("只限獲授權嘅主管及管理員查閱");
    expect(privacySrc).toContain("唔會令呢個後台副本即時消失");
    expect(privacySrc).toContain("刪圖唔等於刪晒所有紀錄");
    expect(privacySrc).toContain("除上述最多 30 日");
    expect(privacySrc).toContain("邊位會員、邊件商品、狀態、時間");
    expect(privacySrc).toContain("唔包括你嘅圖片");
  });

  it("寫明主要分享直接傳 PNG、由客人主動發送；離開系統後無法撤回", () => {
    expect(privacySrc).toContain("PNG 相檔");
    expect(privacySrc).toContain("經裝置分享面板傳出");
    expect(privacySrc).toContain("唔會自動發佈");
    expect(privacySrc).toContain("唔會自動代你發佈");
    expect(privacySrc).toContain("無法經本網站撤回");
  });

  it("披露對象有第三方 AI 圖像處理服務商類別（唔點名），後續處理受其安排管限", () => {
    expect(privacySrc).toContain("第三方 AI 圖像處理服務商");
    expect(privacySrc).toContain("受其服務安排及私隱政策管限");
    // 程式無法證明第三方即時刪除或不保留，唔准咁寫
    expect(privacySrc).not.toContain("只作即時生成");
    expect(privacySrc).not.toContain("作即時處理");
  });
});

describe("私隱政策：公開抽獎公告（第 2.7 節）", () => {
  it("公開內容只限活動名、抽獎日期時間、中獎者展示名及獎品名", () => {
    expect(privacySrc).toContain("公開中獎公告頁");
    expect(privacySrc).toContain("活動名稱");
    expect(privacySrc).toContain("抽獎日期及時間");
    expect(privacySrc).toContain("中獎者嘅展示名稱及獎品名稱");
  });

  it("寫明唔會公開電話、電郵、會員編號、地址、內部備註", () => {
    expect(privacySrc).toContain("電話號碼、電郵地址、會員編號、地址或任何內部備註");
  });
});

describe("私隱政策：託管／交易電郵服務商披露（第 06 節，只寫類別唔點名）", () => {
  // 只抽第 06 節「資料披露及轉移對象」入面、公開頁實際顯示嘅託管及電郵段落做斷言，
  // 唔掃成個源碼檔，避免註解或其他章節嘅字詞（例如 React render）誤中。
  const disclosureParagraph = (() => {
    const m = privacySrc.match(/雲端託管及系統服務商[\s\S]*?用於營運本網站及發送電郵/);
    return m ? m[0] : "";
  })();

  it("公開政策有託管及電郵服務商披露段落", () => {
    expect(disclosureParagraph).not.toBe("");
  });

  it("仍以第三方服務類別披露：雲端託管／資料庫 及 交易電郵傳送，並保留用途", () => {
    expect(disclosureParagraph).toContain("第三方雲端託管及資料庫服務商");
    expect(disclosureParagraph).toContain("第三方交易電郵傳送服務商");
    // 用途及實際資料流保留：網站及資料庫託管、交易電郵寄出
    expect(disclosureParagraph).toContain("網站及資料庫託管");
    expect(disclosureParagraph).toContain("交易電郵寄出服務");
    expect(disclosureParagraph).toContain("用於營運本網站及發送電郵");
  });

  it("公開披露段落唔再點名 Render／Resend", () => {
    expect(disclosureParagraph).not.toMatch(/render/i);
    expect(disclosureParagraph).not.toMatch(/resend/i);
  });
});

describe("私隱政策：sessionStorage 草稿（第 8 節）", () => {
  it("寫明試穿結帳草稿及小精靈偏好只存裝置，唔係帳戶雲端保存", () => {
    expect(privacySrc).toContain("分頁工作階段儲存（sessionStorage）");
    expect(privacySrc).toContain("唔會儲存圖片或價錢");
    expect(privacySrc).toContain("唔會當成帳戶資料雲端保存");
    expect(privacySrc).toContain("「今次唔使」偏好");
  });

  it("草稿清除以網站確認落單成功為準；回應遺失時留底作恢復", () => {
    expect(privacySrc).toContain("當網站確認落單成功後，草稿會即時清除");
    expect(privacySrc).toContain("作恢復用途");
    expect(privacySrc).not.toContain("正式落單成功後草稿會即時清除");
  });
});

describe("服務條款：AI 試穿（第 4 節）", () => {
  it("有第 04 節 AI 試穿服務", () => {
    expect(termsSrc).toContain('num="04" title="AI 試穿服務（視覺預覽）"');
  });

  it("寫明只係視覺預覽，唔代表尺碼、合身或實際穿著效果", () => {
    expect(termsSrc).toContain("AI 試穿只係視覺預覽");
    expect(termsSrc).toContain("唔代表貨品嘅實際尺碼、合身程度或實際穿著效果");
  });

  it("寫明購買以結帳時顯示同訂單確認為準；生成失敗唔扣額", () => {
    expect(termsSrc).toContain("結帳時本網站顯示");
    expect(termsSrc).toContain("訂單確認");
    expect(termsSrc).toContain("生成失敗唔會扣你嘅個人額度");
  });

  it("第 4.4 條同私隱一致：前台／分享 24h；後台副本最多 30 日，到期拒絕存取並定期清除", () => {
    expect(termsSrc).toContain("前台原相、結果及分享連結存取有效期最長 24 小時");
    expect(termsSrc).toContain("後台副本，由工作建立時間起最多保留 30 日");
    expect(termsSrc).toContain("唔會因前台刪除即時消失");
    expect(termsSrc).toContain("到期會拒絕存取並定期清除");
    expect(termsSrc).not.toContain("預設最多保留 24 小時");
    expect(termsSrc).not.toContain("最長保留 24 小時");
  });
});

describe("服務條款：會員購物金（第 8 節）", () => {
  it("有第 08 節會員購物金", () => {
    expect(termsSrc).toContain('num="08" title="會員購物金"');
  });

  it("寫明唔可以兌換現金、不設退款、30 分鐘付款期、訂單取消自動退回", () => {
    expect(termsSrc).toContain("唔可以兌換現金、唔可以轉讓，除本條款訂明嘅情況外不設退款");
    expect(termsSrc).toContain("30 分鐘");
    expect(termsSrc).toContain("自動退回");
  });
});

describe("服務條款：結帳重算及外部連結", () => {
  it("優惠碼／購物金／運費以結帳時系統重新計算為準", () => {
    expect(termsSrc).toContain("優惠碼折扣、購物金抵銷同運費（包括免運門檻）");
    expect(termsSrc).toContain("結帳時系統重新計算");
  });

  it("第三方連結及主動分享跳轉嘅責任分界", () => {
    expect(termsSrc).toContain("主動");
    expect(termsSrc).toContain("第三方嘅內容、服務同條款由第三方負責");
  });
});

describe("服務條款：重編號後交叉引用一致", () => {
  it("舊引用（第 8.3／7.3／14.5／15.7／5.2 條）已全部更新", () => {
    for (const stale of ["第 8.3", "第 7.3", "第 14.5", "第 15.7", "見第 5.2", "（第 10.2 條嘅瑕疵"]) {
      expect(termsSrc).not.toContain(stale);
    }
  });

  it("新引用目標存在（10.3 退款、17.7 聯絡、6.2 付款期限、9.3 標價錯誤、12.2 法定權利、16.5 不可抗力）", () => {
    for (const anchor of ["10.3", "17.7", "6.2", "9.3", "12.2", "16.5"]) {
      expect(termsSrc).toContain(anchor);
    }
  });

  it("章節編號連續 01–17", () => {
    const nums = [...termsSrc.matchAll(/<Section num="(\d{2})"/g)].map((m) => m[1]);
    expect(nums).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08", "09",
      "10", "11", "12", "13", "14", "15", "16", "17",
    ]);
  });
});

describe("兩頁都唔准披露供應商／模型／技術配置／商業機密", () => {
  for (const [name, src] of [
    ["私隱政策", privacySrc],
    ["服務條款", termsSrc],
  ] as const) {
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      it(`${name}唔含 ${label}`, () => {
        expect(src).not.toMatch(pattern);
      });
    }
  }
});
