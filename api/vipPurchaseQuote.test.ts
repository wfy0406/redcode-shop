import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cartFindManyCount: 0,
  cart: [] as any[],
  user: {
    vipTier: "NONE",
    vipExpiresAt: null as Date | null,
  },
  station: null as any,
}));

const mocks = vi.hoisted(() => ({ promo: vi.fn() }));

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    query: {
      cartItems: {
        findMany: async () => {
          h.cartFindManyCount += 1;
          return h.cart;
        },
      },
      users: { findFirst: async () => h.user },
      siteSettings: { findFirst: async () => null },
      sfStations: { findFirst: async () => h.station },
    },
  }),
}));
vi.mock("./promoRouter", () => ({ resolvePromoDiscount: mocks.promo }));
vi.mock("./email", () => ({
  sendVipUpgradeEmail: vi.fn(async () => ({ ok: true })),
  siteUrl: vi.fn(() => "https://test.local"),
}));
vi.mock("./vipCert", () => ({ buildVipVerifyUrl: vi.fn(() => "https://test.local/verify") }));
vi.mock("./wmsMemberSync", () => ({ forwardMemberToWms: vi.fn(async () => undefined) }));

import {
  computeCheckoutQuote,
  resetShippingRulesCache,
  resetVipRulesCache,
} from "./vip";

function product(price: number, discountPrice: number | null = null) {
  return { price, discountPrice } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVipRulesCache();
  resetShippingRulesCache();
  h.cartFindManyCount = 0;
  h.cart = [];
  h.user = { vipTier: "NONE", vipExpiresAt: null };
  h.station = null;
});

describe("AI 試穿即買 checkout quote 商品口徑", () => {
  it("resolved direct lines 取代原 cart，小計只計今次兩件", async () => {
    h.cart = [{ quantity: 9, product: product(999) }];
    const direct = [
      { productId: 101, size: "M", quantity: 1, product: product(599, 499) },
      { productId: 202, size: null, quantity: 1, product: product(399) },
    ] as any;

    const quote = await computeCheckoutQuote(7, { region: "HK", deliveryMethod: "address" }, direct);

    expect(quote.subtotalCents).toBe(89800);
    expect(quote.totalCents).toBe(89800);
    expect(h.cartFindManyCount).toBe(0);
  });

  it("VIP、優惠碼基數及免運門檻全部用 direct subtotal，唔受原 cart 金額影響", async () => {
    h.cart = [{ quantity: 1, product: product(1000) }];
    h.user = { vipTier: "SILVER", vipExpiresAt: new Date(Date.now() + 60_000) };
    h.station = { id: "ST-1", active: true, region: "HK", name: "測試站" };
    mocks.promo.mockResolvedValue({ discountAmount: 50, promo: { code: "TEST" } });
    const direct = [
      { productId: 101, size: null, quantity: 1, product: product(400) },
    ] as any;

    const quote = await computeCheckoutQuote(7, {
      region: "HK",
      deliveryMethod: "sf_station",
      stationId: "ST-1",
      couponCode: "TEST",
    }, direct);

    expect(quote.subtotalCents).toBe(40000);
    expect(quote.vipDiscountCents).toBe(3200);
    expect(mocks.promo).toHaveBeenCalledTimes(1);
    expect(mocks.promo.mock.calls[0]?.[2]).toBe(368);
    expect(quote.couponDiscountCents).toBe(5000);
    expect(quote.totalCents).toBe(31800);
    expect(quote.shippingFree).toBe(true);
    expect(h.cartFindManyCount).toBe(0);
  });

  it("冇 direct lines 時保留原購物車報價行為", async () => {
    h.cart = [{ quantity: 2, product: product(50) }];
    const quote = await computeCheckoutQuote(7, { region: "HK", deliveryMethod: "address" });
    expect(quote.subtotalCents).toBe(10000);
    expect(h.cartFindManyCount).toBe(1);
  });
});
