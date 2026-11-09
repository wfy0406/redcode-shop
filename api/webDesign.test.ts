/**
 * 網站設計服務純函數測試（v2026.11.09）——唔連 DB、唔掂 filesystem。
 * 覆蓋：catalog 驗證／合併預設、方案依賴、server 計價、電話 normalize、
 * 狀態 mapping（review／shipment）、WMS remark payload、私隱查詢輸入、訂單圖 SVG 內容。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_DESIGN_CATALOG,
  LEGACY_SEO_ITEM_KEYS,
  WEB_DESIGN_CATALOG_SETTING_KEY,
  type WebDesignCatalogItem,
} from "@contracts/webDesign";
import {
  WEB_DESIGN_LOOKUP_FAIL_MESSAGE,
  buildWmsRemark,
  canMarkWebDesignPaid,
  generateWebDesignOrderNo,
  isWebDesignOrderNo,
  mapWmsReviewForWebDesign,
  mapWmsShipmentForWebDesign,
  mergeCatalogWithDefaults,
  normalizeWebDesignPhone,
  priceOrder,
  validateCatalog,
  validateLookupInput,
  verifyWebDesignPaymentIntent,
  isUniqueViolation,
  wmsServiceItemName,
} from "./webDesignCore";
import { ORDER_IMAGE_HEIGHT, ORDER_IMAGE_WIDTH, buildOrderImageSvg } from "./webDesignImage";

const CATALOG = DEFAULT_WEB_DESIGN_CATALOG;

/** 舊版逐項 SEO item（v2026.11.09 前嘅 DB 存量會係呢啲 key） */
function legacySeoItem(key: (typeof LEGACY_SEO_ITEM_KEYS)[number], sortOrder: number): WebDesignCatalogItem {
  return {
    key,
    name: `舊逐項 ${key}`,
    description: "舊版逐項 SEO",
    category: "seo",
    price: 180,
    marketPrice: 643,
    requiredPlan: "front_only",
    billing: "one_off",
    selectable: true,
    active: true,
    sortOrder,
    priceNote: "一次性",
  };
}

describe("catalog 預設內容（v2026.11.09 改價＋SEO 套票）", () => {
  it("六個舊 seo_* 合併做單一 seo_package 套票", () => {
    const seoItems = CATALOG.items.filter((i) => i.category === "seo");
    expect(seoItems).toHaveLength(1);
    const pkg = seoItems[0];
    expect(pkg).toMatchObject({
      key: "seo_package",
      name: "SEO 技術優化套票",
      price: 1240,
      marketPrice: 4429,
      requiredPlan: "front_only",
      billing: "one_off",
      selectable: true,
      active: true,
      sortOrder: 10,
      priceNote: "一次性｜完整套票",
    });
    for (const key of LEGACY_SEO_ITEM_KEYS) {
      expect(CATALOG.items.find((i) => i.key === key), key).toBeUndefined();
    }
    // 描述列齊套票內容同唔承諾排名
    for (const s of ["title", "description", "canonical", "robots", "sitemap", "Open Graph", "Service", "Organization", "H1–H3", "alt", "效能檢查", "驗證報告", "唔承諾搜尋排名"]) {
      expect(pkg.description, s).toContain(s);
    }
  });

  it("非 SEO 現價 +15% 四捨五入；marketPrice、domain_at_cost 全部不變", () => {
    expect(CATALOG.frontOnlyPrice).toBe(1668); // 1450×1.15＝1667.5
    expect(CATALOG.frontOnlyMarketPrice).toBe(5179);
    expect(CATALOG.fullStackPrice).toBe(4428); // 3850×1.15＝4427.5
    expect(CATALOG.fullStackMarketPrice).toBe(13750);
    const byKey = new Map(CATALOG.items.map((i) => [i.key, i]));
    expect(byKey.get("catalog_admin")).toMatchObject({ price: 1127, marketPrice: 3500 });
    expect(byKey.get("enquiry_admin")).toMatchObject({ price: 1012, marketPrice: 3143 });
    expect(byKey.get("staff_audit")).toMatchObject({ price: 1472, marketPrice: 4571 });
    expect(byKey.get("hosting_monthly")).toMatchObject({ price: 633, marketPrice: 1964 }); // 550×1.15＝632.5
    expect(byKey.get("domain_at_cost")).toMatchObject({ price: 0, marketPrice: 0, billing: "at_cost", selectable: false });
    // SEO 套票唔加 15%
    expect(byKey.get("seo_package")?.price).toBe(1240);
  });

  it("新增四個唔需代客申請 API 嘅項目", () => {
    const byKey = new Map(CATALOG.items.map((i) => [i.key, i]));
    expect(byKey.get("ecard")).toMatchObject({
      name: "電子名片 e-Card", price: 690, marketPrice: 3500,
      requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 140,
    });
    expect(byKey.get("multilingual")).toMatchObject({
      name: "全網多語言版本", price: 1840, marketPrice: 8000,
      requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 150,
    });
    expect(byKey.get("progress_lookup")).toMatchObject({
      name: "客戶進度查詢專區", price: 3450, marketPrice: 9000,
      requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 160,
    });
    expect(byKey.get("followup_reminders")).toMatchObject({
      name: "跟進提醒系統", price: 2760, marketPrice: 3500,
      requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 170,
    });
  });

  it("Facebook／Instagram 動態嵌入：HK$800、前台方案可選、唔用虛構市場價", () => {
    const item = CATALOG.items.find((i) => i.key === "social_embed");
    expect(item).toMatchObject({
      name: "Facebook／Instagram 動態嵌入", price: 800, marketPrice: 0,
      requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 155,
    });
    expect(item?.description).toContain("唔需要代你申請第三方 API");
  });
});

describe("catalog 合併預設（getCatalog 口徑）", () => {
  it("setting key 係 web_design_catalog", () => {
    expect(WEB_DESIGN_CATALOG_SETTING_KEY).toBe("web_design_catalog");
  });

  it("null／壞 JSON 對象 → 完整預設 catalog", () => {
    expect(mergeCatalogWithDefaults(null)).toEqual(CATALOG);
    expect(mergeCatalogWithDefaults("junk")).toEqual(CATALOG);
    expect(mergeCatalogWithDefaults(42)).toEqual(CATALOG);
  });

  it("缺方案價 → 該欄落預設；合法欄保留", () => {
    const merged = mergeCatalogWithDefaults({ frontOnlyPrice: 1990, items: CATALOG.items });
    expect(merged.frontOnlyPrice).toBe(1990);
    expect(merged.fullStackPrice).toBe(CATALOG.fullStackPrice);
    expect(merged.items.length).toBe(CATALOG.items.length);
  });

  it("壞 item 被 drop（唔會成個 catalog 報廢）；key 重複留第一個", () => {
    const merged = mergeCatalogWithDefaults({
      ...CATALOG,
      items: [
        ...CATALOG.items,
        { key: "broken" }, // 缺欄
        { ...CATALOG.items[0], name: "改名版" }, // 重複 key
      ],
    });
    expect(merged.items.find((i) => i.key === "broken")).toBeUndefined();
    expect(merged.items.filter((i) => i.key === CATALOG.items[0].key).length).toBe(1);
  });

  it("舊 catalog 自動補 social_embed；已存在嘅後台自訂價唔會被冚", () => {
    const upgraded = mergeCatalogWithDefaults({
      ...CATALOG,
      items: CATALOG.items.filter((i) => i.key !== "social_embed"),
    });
    expect(upgraded.items.find((i) => i.key === "social_embed")?.price).toBe(800);

    const customized = mergeCatalogWithDefaults({
      ...CATALOG,
      items: CATALOG.items.map((i) => i.key === "social_embed" ? { ...i, price: 888 } : i),
    });
    expect(customized.items.filter((i) => i.key === "social_embed")).toHaveLength(1);
    expect(customized.items.find((i) => i.key === "social_embed")?.price).toBe(888);
  });

  it("items 按 sortOrder 排", () => {
    const merged = mergeCatalogWithDefaults({
      ...CATALOG,
      items: [CATALOG.items[9], CATALOG.items[0]],
    });
    expect(merged.items[0].sortOrder).toBeLessThanOrEqual(merged.items[1].sortOrder);
  });

  it("legacy DB 正規化：舊六項 seo_* → 單一 seo_package（用官方預設套票定義）", () => {
    const merged = mergeCatalogWithDefaults({
      frontOnlyPrice: 1450, // 舊價照保留（後台自訂欄唔郁）
      items: [
        ...LEGACY_SEO_ITEM_KEYS.map((k, i) => legacySeoItem(k, (i + 1) * 10)),
        CATALOG.items.find((i) => i.key === "hosting_monthly")!,
      ],
    });
    expect(merged.frontOnlyPrice).toBe(1450);
    expect(merged.items.some((i) => LEGACY_SEO_ITEM_KEYS.includes(i.key as never))).toBe(false);
    const pkgs = merged.items.filter((i) => i.key === "seo_package");
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ name: "SEO 技術優化套票", price: 1240, marketPrice: 4429 });
    expect(merged.items.some((i) => i.key === "hosting_monthly")).toBe(true);
  });

  it("已有 seo_package（後台自訂內容／價錢）→ 保留佢，唔用預設冚；舊 key 照 drop", () => {
    const customPkg: WebDesignCatalogItem = {
      ...CATALOG.items.find((i) => i.key === "seo_package")!,
      name: "老闆自訂 SEO 套票",
      price: 999,
      description: "後台改過嘅描述",
    };
    const merged = mergeCatalogWithDefaults({
      items: [customPkg, legacySeoItem("seo_meta", 10), legacySeoItem("seo_report", 60)],
    });
    const pkgs = merged.items.filter((i) => i.key === "seo_package");
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ name: "老闆自訂 SEO 套票", price: 999, description: "後台改過嘅描述" });
    expect(merged.items.some((i) => LEGACY_SEO_ITEM_KEYS.includes(i.key as never))).toBe(false);
  });

  it("淨係舊 key 其中一兩項都觸發正規化，同時補新社交嵌入服務", () => {
    const merged = mergeCatalogWithDefaults({ items: [legacySeoItem("seo_schema", 40)] });
    expect(merged.items.map((i) => i.key)).toEqual(["seo_package", "social_embed"]);
  });
});

describe("validateCatalog（setCatalog 嚴格驗證）", () => {
  it("預設 catalog 合法", () => {
    expect(validateCatalog(CATALOG)).not.toBeNull();
  });

  it("負價／缺 items／壞 item／重複 key 全部拒收", () => {
    expect(validateCatalog({ ...CATALOG, frontOnlyPrice: -1 })).toBeNull();
    expect(validateCatalog({ ...CATALOG, items: "no" })).toBeNull();
    expect(validateCatalog({ ...CATALOG, items: [{ key: "x" }] })).toBeNull();
    expect(
      validateCatalog({ ...CATALOG, items: [CATALOG.items[0], CATALOG.items[0]] }),
    ).toBeNull();
  });

  it("舊六項 seo_* key 一律拒收（就算結構合法）：要用 seo_package 套票", () => {
    for (const key of LEGACY_SEO_ITEM_KEYS) {
      expect(
        validateCatalog({ ...CATALOG, items: [...CATALOG.items, legacySeoItem(key, 10)] }),
        key,
      ).toBeNull();
    }
    // 純舊 key catalog 都拒
    expect(
      validateCatalog({
        frontOnlyPrice: 1450,
        frontOnlyMarketPrice: 5179,
        fullStackPrice: 3850,
        fullStackMarketPrice: 13750,
        items: LEGACY_SEO_ITEM_KEYS.map((k, i) => legacySeoItem(k, (i + 1) * 10)),
      }),
    ).toBeNull();
  });
});

describe("server 計價（priceOrder）", () => {
  it("front_only 基本價＋SEO 套票＋月費 hosting：total＝一次性＋首月＝3541", () => {
    const r = priceOrder(CATALOG, "front_only", ["seo_package", "hosting_monthly"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oneOffTotal).toBe(1668 + 1240);
    expect(r.monthlyTotal).toBe(633);
    expect(r.total).toBe(3541);
    // 第一行係方案基本價快照行
    expect(r.items[0].itemKey).toBe("plan_front_only");
    expect(r.items[0].price).toBe(1668);
  });

  it("方案依賴：front_only 揀 full_stack 功能 → 擋", () => {
    const r = priceOrder(CATALOG, "front_only", ["catalog_admin"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("前台＋後台");
  });

  it("full_stack 可以揀任何功能", () => {
    const r = priceOrder(CATALOG, "full_stack", ["catalog_admin", "seo_package", "hosting_monthly"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oneOffTotal).toBe(4428 + 1127 + 1240);
    expect(r.monthlyTotal).toBe(633);
  });

  it("新落單用舊 seo_* key → 擋（就算傳入嘅 catalog 係舊版未正規化都擋）", () => {
    expect(priceOrder(CATALOG, "front_only", ["seo_meta"]).ok).toBe(false);
    const staleCatalog = {
      ...CATALOG,
      items: [...CATALOG.items, legacySeoItem("seo_meta", 10)],
    };
    const r = priceOrder(staleCatalog, "front_only", ["seo_meta"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("seo_package");
  });

  it("新增四項 server 計價：full_stack 全揀；front_only 只揀到 multilingual", () => {
    const r = priceOrder(CATALOG, "full_stack", ["ecard", "multilingual", "progress_lookup", "followup_reminders"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oneOffTotal).toBe(4428 + 690 + 1840 + 3450 + 2760);
    expect(r.monthlyTotal).toBe(0);
    // multilingual 同 social_embed 係 front_only 可揀
    const r2 = priceOrder(CATALOG, "front_only", ["multilingual", "social_embed"]);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.total).toBe(1668 + 1840 + 800);
    const socialOnly = priceOrder(CATALOG, "front_only", ["social_embed"]);
    expect(socialOnly.ok).toBe(true);
    if (socialOnly.ok) expect(socialOnly.total).toBe(1668 + 800);
    // 其餘三項要 full_stack
    for (const key of ["ecard", "progress_lookup", "followup_reminders"]) {
      expect(priceOrder(CATALOG, "front_only", [key]).ok, key).toBe(false);
    }
  });

  it("未知 key／唔揀得（at_cost 展示項）／下架項 → 擋", () => {
    expect(priceOrder(CATALOG, "front_only", ["no_such_key"]).ok).toBe(false);
    const r2 = priceOrder(CATALOG, "front_only", ["domain_at_cost"]);
    expect(r2.ok).toBe(false); // selectable:false
    const disabledCatalog = {
      ...CATALOG,
      items: CATALOG.items.map((i) => (i.key === "seo_package" ? { ...i, active: false } : i)),
    };
    expect(priceOrder(disabledCatalog, "front_only", ["seo_package"]).ok).toBe(false);
  });

  it("重複 key 當一次；空 itemKeys ＝ 淨方案基本價", () => {
    const r = priceOrder(CATALOG, "front_only", ["seo_package", "seo_package"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oneOffTotal).toBe(1668 + 1240);
    const bare = priceOrder(CATALOG, "full_stack", []);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.total).toBe(4428);
    expect(bare.monthlyTotal).toBe(0);
  });

  it("非法 plan → 擋", () => {
    expect(priceOrder(CATALOG, "gold" as never, []).ok).toBe(false);
  });
});

describe("電話 normalize＋私隱查詢輸入", () => {
  it("8 位／+852／852 前綴／空格 dash 全部 normalize 做純 8 位", () => {
    expect(normalizeWebDesignPhone("91234567")).toBe("91234567");
    expect(normalizeWebDesignPhone("+852 9123 4567")).toBe("91234567");
    expect(normalizeWebDesignPhone("852-9123-4567")).toBe("91234567");
  });

  it("7 位／9 位／字母 → null", () => {
    expect(normalizeWebDesignPhone("9123456")).toBeNull();
    expect(normalizeWebDesignPhone("912345678")).toBeNull();
    expect(normalizeWebDesignPhone("abcd")).toBeNull();
  });

  it("lookup 輸入：姓名 trim 非空＋合法電話先過；統一錯誤訊息存在", () => {
    expect(validateLookupInput(" 陳大文 ", "+852 9123 4567")).toEqual({
      name: "陳大文",
      phone: "91234567",
    });
    expect(validateLookupInput("", "91234567")).toBeNull();
    expect(validateLookupInput("陳大文", "123")).toBeNull();
    expect(validateLookupInput(123, "91234567")).toBeNull();
    expect(WEB_DESIGN_LOOKUP_FAIL_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("訂單號", () => {
  it("WD 前綴＋日期＋4 位；isWebDesignOrderNo 分流", () => {
    const no = generateWebDesignOrderNo(new Date(2026, 10, 9), () => 483);
    expect(no).toBe("WD202611090483");
    expect(isWebDesignOrderNo(no)).toBe(true);
    expect(isWebDesignOrderNo("RC202611090483")).toBe(false);
    expect(isWebDesignOrderNo("WT202611090483")).toBe(false);
  });
});

describe("WMS callback 狀態 mapping", () => {
  it("review approved → in_production＋paid", () => {
    expect(mapWmsReviewForWebDesign("approved", "cancel")).toMatchObject({
      status: "in_production",
      paymentStatus: "paid",
    });
  });

  it("review rejected＋reupload → payment rejected（訂單狀態唔郁）", () => {
    const m = mapWmsReviewForWebDesign("rejected", "reupload");
    expect(m.status).toBeUndefined();
    expect(m.paymentStatus).toBe("rejected");
  });

  it("review rejected（cancel／舊格式）→ cancelled", () => {
    expect(mapWmsReviewForWebDesign("rejected", "cancel").status).toBe("cancelled");
  });

  it("shipment shipped → completed（寫 completedAt）；unshipped → in_production（清 completedAt）", () => {
    expect(mapWmsShipmentForWebDesign("shipped")).toEqual({ status: "completed", setCompletedAt: true });
    expect(mapWmsShipmentForWebDesign("unshipped")).toEqual({ status: "in_production", setCompletedAt: false });
  });

  it("其他 shipment action（item_*）唔適用 → null", () => {
    expect(mapWmsShipmentForWebDesign("item_cancelled")).toBeNull();
    expect(mapWmsShipmentForWebDesign("sf_updated")).toBeNull();
  });
});

describe("WMS forward payload 組裝", () => {
  it("服務項名：方案對應「網頁設計（前台／前台＋後台）」", () => {
    expect(wmsServiceItemName("front_only")).toBe("網頁設計（前台）");
    expect(wmsServiceItemName("full_stack")).toBe("網頁設計（前台＋後台）");
  });

  it("remark 包含要求／風格／全部功能／月費／單號", () => {
    const remark = buildWmsRemark({
      orderNo: "WD202611090001",
      plan: "full_stack",
      itemNames: ["服務／產品內容管理", "網站架設、雲端託管及維護（每月 HK$550）"],
      requirements: "要購物車同會員系統",
      styleNotes: "深色簡約",
      monthlyTotal: 550,
      paymentNote: "Airwallex 網上收款已確認",
    });
    expect(remark).toContain("WD202611090001");
    expect(remark).toContain("前台＋後台");
    expect(remark).toContain("服務／產品內容管理");
    expect(remark).toContain("要購物車同會員系統");
    expect(remark).toContain("深色簡約");
    expect(remark).toContain("HK$550／月");
    expect(remark).toContain("Airwallex");
  });

  it("remark 極長要求會截斷（唔會炸 WMS 欄位）", () => {
    const remark = buildWmsRemark({
      orderNo: "WD202611090001",
      plan: "front_only",
      itemNames: [],
      requirements: "長".repeat(1000),
      styleNotes: "",
      monthlyTotal: 0,
    });
    expect(remark.length).toBeLessThan(600);
  });
});

describe("Airwallex 收款核對（verifyWebDesignPaymentIntent）", () => {
  const base = {
    orderNo: "WD202611090001",
    orderTotal: 4400,
    storedIntentId: "int_abc123",
    intent: {
      id: "int_abc123",
      merchantOrderId: "WD202611090001",
      amount: 4400,
      currency: "HKD",
    },
  };

  it("四項齊中 → ok", () => {
    expect(verifyWebDesignPaymentIntent(base)).toEqual({ ok: true });
  });

  it("merchant_order_id 對錯單 → 拒", () => {
    const r = verifyWebDesignPaymentIntent({
      ...base,
      intent: { ...base.intent, merchantOrderId: "WD202611090002" },
    });
    expect(r.ok).toBe(false);
  });

  it("stored intentId 有記錄而嚟嘅係第個 intent → 拒；缺 id 都拒", () => {
    expect(
      verifyWebDesignPaymentIntent({
        ...base,
        intent: { ...base.intent, id: "int_other" },
      }).ok,
    ).toBe(false);
    expect(
      verifyWebDesignPaymentIntent({
        ...base,
        intent: { ...base.intent, id: null },
      }).ok,
    ).toBe(false);
  });

  it("金額少付／多付／缺 → 全部拒", () => {
    for (const amount of [4399, 4401, null]) {
      expect(
        verifyWebDesignPaymentIntent({ ...base, intent: { ...base.intent, amount } }).ok,
      ).toBe(false);
    }
  });

  it("幣種唔係 HKD／缺 → 拒", () => {
    expect(
      verifyWebDesignPaymentIntent({ ...base, intent: { ...base.intent, currency: "USD" } }).ok,
    ).toBe(false);
    expect(
      verifyWebDesignPaymentIntent({ ...base, intent: { ...base.intent, currency: null } }).ok,
    ).toBe(false);
  });

  it("intent.id 無條件必填：就算訂單未記 intentId，缺 id 都唔准放行", () => {
    expect(
      verifyWebDesignPaymentIntent({ ...base, intent: { ...base.intent, id: null } }).ok,
    ).toBe(false);
    expect(
      verifyWebDesignPaymentIntent({
        ...base,
        storedIntentId: null,
        intent: { ...base.intent, id: null },
      }).ok,
    ).toBe(false);
  });

  it("訂單未記 intentId（舊流程）→ 有合法 intent.id 就照過，其餘照核", () => {
    expect(
      verifyWebDesignPaymentIntent({ ...base, storedIntentId: null }),
    ).toEqual({ ok: true });
  });
});

describe("網上收款來源狀態閘（canMarkWebDesignPaid）", () => {
  it("pending｜review 先可轉 paid（review＝截圖待核實但網上 intent 已成功）", () => {
    expect(canMarkWebDesignPaid("pending")).toBe(true);
    expect(canMarkWebDesignPaid("review")).toBe(true);
  });

  it("rejected／paid／cancelled／其他 → 唔郁", () => {
    for (const s of ["rejected", "paid", "cancelled", "received", ""]) {
      expect(canMarkWebDesignPaid(s)).toBe(false);
    }
    expect(canMarkWebDesignPaid("pending", "cancelled")).toBe(false);
    expect(canMarkWebDesignPaid("review", "cancelled")).toBe(false);
    expect(canMarkWebDesignPaid("review", "in_production")).toBe(true);
  });
});

describe("orderNo 撞號 retry 判定（isUniqueViolation）", () => {
  it("pg 23505（直接／cause 包層）／duplicate key 訊息 → true", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("x"), )).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(
      isUniqueViolation(new Error('duplicate key value violates unique constraint "webDesignOrders_orderNo_unique"')),
    ).toBe(true);
  });

  it("其他 DB 錯誤 → false（唔准當撞號 retry）", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation({ code: "42P01" })).toBe(false);
    expect(isUniqueViolation(new Error("connection terminated"))).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("訂單圖 SVG（buildOrderImageSvg）", () => {
  const svg = buildOrderImageSvg({
    orderNo: "WD202611090001",
    plan: "full_stack",
    name: "陳大文",
    phone: "91234567",
    email: "chan@example.com",
    requirements: "要購物車同會員系統",
    styleNotes: "深色簡約",
    items: [
      {
        itemKey: "plan_full_stack",
        name: "網站設計服務（前台＋後台）",
        category: "service",
        plan: "full_stack",
        billing: "one_off",
        price: 3850,
        marketPrice: 13750,
        priceNote: "一次性｜方案基本價",
        sortOrder: 0,
      },
      {
        itemKey: "hosting_monthly",
        name: "網站架設、雲端託管及維護",
        category: "service",
        plan: "front_only",
        billing: "monthly",
        price: 550,
        marketPrice: 1964,
        priceNote: "每月",
        sortOrder: 200,
      },
    ],
    oneOffTotal: 3850,
    monthlyTotal: 550,
    total: 4400,
    createdAt: new Date("2026-11-09T07:00:00Z"),
  });

  it("畫布 1200×1600，字型栈有 Noto CJK", () => {
    expect(svg).toContain(`width="${ORDER_IMAGE_WIDTH}"`);
    expect(svg).toContain(`height="${ORDER_IMAGE_HEIGHT}"`);
    expect(ORDER_IMAGE_WIDTH).toBe(1200);
    expect(ORDER_IMAGE_HEIGHT).toBe(1600);
    expect(svg).toContain("Noto Sans CJK TC");
  });

  it("內容齊：方案／全部功能／要求／風格／一次性／首月／其後月費／總額／客名／電話", () => {
    for (const s of [
      "WD202611090001",
      "陳大文",
      "91234567",
      "前台＋後台",
      "網站架設、雲端託管及維護",
      "要購物車同會員系統",
      "深色簡約",
      "一次性費用",
      "首月月費",
      "其後月費",
      "今次應付總額",
      "HK$3,850",
      "HK$550",
      "HK$4,400",
    ]) {
      expect(svg).toContain(s);
    }
  });

  it("功能同長備註多會加高畫布，最尾項目同句子都唔准截走", () => {
    const long = buildOrderImageSvg({
      orderNo: "WD202611099999",
      plan: "front_only",
      name: "陳大文",
      phone: "91234567",
      requirements: `${"需要詳細記錄。".repeat(180)}備註最尾呢句要保留`,
      styleNotes: "深色簡約",
      items: Array.from({ length: 40 }, (_, i) => ({
        itemKey: `feature_${i}`,
        name: i === 39 ? "最尾一項功能要保留" : `自選功能 ${i + 1}`,
        category: "seo" as const,
        plan: "front_only" as const,
        billing: "one_off" as const,
        price: 100,
        marketPrice: 300,
        priceNote: "",
        sortOrder: i,
      })),
      oneOffTotal: 5450,
      monthlyTotal: 0,
      total: 5450,
      createdAt: new Date("2026-11-09T07:00:00Z"),
    });
    const height = Number(long.match(/height="(\d+)"/)?.[1]);
    expect(height).toBeGreaterThan(ORDER_IMAGE_HEIGHT);
    expect(long).toContain("最尾一項功能要保留");
    expect(long).toContain("備註最尾呢句要保留");
  });

  it("XML escape：客名入面嘅 <>& 唔會爆 SVG", () => {
    const evil = buildOrderImageSvg({
      orderNo: "WD202611090001",
      plan: "front_only",
      name: "<script>alert(1)</script>",
      phone: "91234567",
      requirements: "a & b <c>",
      styleNotes: "",
      items: [],
      oneOffTotal: 1450,
      monthlyTotal: 0,
      total: 1450,
      createdAt: new Date(),
    });
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;script&gt;");
    expect(evil).toContain("a &amp; b &lt;c&gt;");
  });
});
