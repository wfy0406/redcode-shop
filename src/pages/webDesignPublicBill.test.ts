// ===== v2026.11.13.1 redcode.red 公開單據頁 — 純邏輯測試（node 環境，無 DOM、無網絡）=====
// 覆蓋：normalize（kind/notes/publicToken/onlineUrl、剥操作員）、標題、
// onlineUrl／QR payload／畫面顯示三者一致、狀態／合計／付款 CTA 口徑同 WMS 版一致。
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_BILL_TOKEN_RE,
  billTitles,
  canPay,
  fmtHKD,
  fmtPeriod,
  isPartialRefund,
  normalizeWebDesignPublicBill,
  qrPayloadForBill,
  resolveBillOnlineUrl,
  statusInfo,
  surchargeNote,
  totalsPlan,
  SURCHARGE_DISCLAIMER,
  SURCHARGE_OFF_NOTE,
  type WebDesignPublicBillView,
} from './webDesignPublicBill';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const CANONICAL = `https://redcode.red/web-design-bill/${TOKEN}`;

const RAW_MONTHLY = {
  billNo: 'WDB-2026-11-0001',
  period: '2026-11',
  projectTitle: '陳記網站',
  customerName: '陳大文',
  items: [
    { name: '網站月費', qty: 1, unitPriceCents: 98000, amountCents: 98000 },
    { name: '減免｜首月優惠', qty: 1, unitPriceCents: -20000, amountCents: -20000 },
  ],
  subtotalCents: 98000,
  adjustCents: 0,
  adjustLog: [],
  finalCents: 78000,
  status: 'issued',
  mode: 'live',
  orderDate: '2026-11-01',
  sessionNo: null,
  remark: '11 月帳單',
  createdAt: '2026-11-01T03:00:00.000Z',
  paidAt: null,
  paymentMethod: null,
  customerPaidCents: null,
  refundedAt: null,
  refundedCents: 0,
  refundStatus: null,
  companyName: 'RedCode HK直播台',
  surchargeOn: true,
  publicToken: TOKEN,
  onlineUrl: CANONICAL,
};

describe('normalizeWebDesignPublicBill', () => {
  it('月費單：全欄位 normalize；kind 缺欄當 monthly', () => {
    const b = normalizeWebDesignPublicBill({ ...RAW_MONTHLY, kind: undefined })!;
    expect(b).not.toBeNull();
    expect(b.billNo).toBe('WDB-2026-11-0001');
    expect(b.kind).toBe('monthly');
    expect(b.finalCents).toBe(78000);
    expect(b.period).toBe('2026-11');
    expect(b.publicToken).toBe(TOKEN);
    expect(b.onlineUrl).toBe(CANONICAL);
    expect(b.notes).toEqual([]);
  });

  it('專案單：kind=project、period null、notes snapshot（只留 text/updatedAt，剥 updatedBy）', () => {
    const b = normalizeWebDesignPublicBill({
      ...RAW_MONTHLY,
      kind: 'project',
      period: null,
      notes: [
        { id: 'n1', text: '加整會員系統', updatedAt: '2026-11-01T08:00:00Z', updatedBy: 'staffA' },
        { text: '', updatedBy: 'staffB' }, // 空 text 唔顯示
      ],
    })!;
    expect(b.kind).toBe('project');
    expect(b.period).toBeNull();
    expect(b.notes).toEqual([{ id: 'n1', text: '加整會員系統', updatedAt: '2026-11-01T08:00:00Z' }]);
    expect(JSON.stringify(b.notes)).not.toContain('staffA');
    expect(billTitles(b.kind)).toEqual({ zh: '專案服務單據', en: 'PROJECT SERVICE STATEMENT' });
  });

  it('adjustLog 剥 `by`／`updatedBy`（就算上游漏出操作員都唔會入 view）', () => {
    const b = normalizeWebDesignPublicBill({
      ...RAW_MONTHLY,
      adjustLog: [{ deltaCents: -5000, reason: 'goodwill', by: 'staffA', at: '2026-11-02T00:00:00Z' }],
    })!;
    expect(b.adjustLog).toEqual([{ deltaCents: -5000, reason: 'goodwill', at: '2026-11-02T00:00:00Z' }]);
    expect(JSON.stringify(b.adjustLog)).not.toContain('staffA');
  });

  it('舊後端未返 onlineUrl：用 token 本地補 canonical（舊 token 兼容）', () => {
    const b = normalizeWebDesignPublicBill({ ...RAW_MONTHLY, onlineUrl: undefined })!;
    expect(b.onlineUrl).toBe(CANONICAL);
  });

  it('上游 onlineUrl 指向 evil.example／WMS 內部域名 → 唔信，重砌官方 canonical', () => {
    for (const bad of [
      `https://evil.example/web-design-bill/${TOKEN}`,
      `https://red-code-wms.onrender.com/web-design-bill/${TOKEN}`,
      `http://redcode.red/web-design-bill/${TOKEN}`,
      `https://redcode.red/web-design-bill/${TOKEN}?x=1`,
      `https://redcode.red/other/${TOKEN}`,
    ]) {
      const b = normalizeWebDesignPublicBill({ ...RAW_MONTHLY, onlineUrl: bad })!;
      expect(b.onlineUrl).toBe(CANONICAL);
      expect(JSON.stringify(b)).not.toContain('evil.example');
      expect(JSON.stringify(b)).not.toContain('red-code-wms.onrender.com');
    }
  });

  it('無有效 publicToken：onlineUrl 係 null（頁面 loud 顯示，唔出假 QR）', () => {
    const b = normalizeWebDesignPublicBill({ ...RAW_MONTHLY, publicToken: 'bad', onlineUrl: undefined })!;
    expect(b.publicToken).toBeNull();
    expect(b.onlineUrl).toBeNull();
    expect(qrPayloadForBill(b)).toBeNull();
  });

  it('錯形 payload → null（頁面顯示「單據不存在或已失效」）', () => {
    expect(normalizeWebDesignPublicBill(null)).toBeNull();
    expect(normalizeWebDesignPublicBill({})).toBeNull();
    expect(normalizeWebDesignPublicBill({ billNo: 'X' })).toBeNull(); // 缺 finalCents
  });
});

describe('SPEC §9 驗收：onlineUrl／QR payload／畫面顯示三者完全相同', () => {
  it('qrPayloadForBill === view.onlineUrl（頁面 <a> 顯示同一字串）', () => {
    const b = normalizeWebDesignPublicBill(RAW_MONTHLY)!;
    expect(qrPayloadForBill(b)).toBe(b.onlineUrl);
    expect(b.onlineUrl).toBe(CANONICAL);
    expect(new URL(b.onlineUrl!).host).toBe('redcode.red');
    expect(b.onlineUrl!.endsWith(`/web-design-bill/${TOKEN}`)).toBe(true);
  });

  it('resolveBillOnlineUrl：只准官方 canonical；任何其他 origin 一律重砌', () => {
    expect(resolveBillOnlineUrl(CANONICAL, TOKEN)).toBe(CANONICAL);
    expect(resolveBillOnlineUrl(`https://evil.example/web-design-bill/${TOKEN}`, TOKEN)).toBe(CANONICAL);
    expect(resolveBillOnlineUrl(undefined, TOKEN)).toBe(CANONICAL);
    expect(resolveBillOnlineUrl(CANONICAL, 'bad')).toBeNull();
  });
});

describe('顯示口徑同 WMS 公開單據一致', () => {
  const bill = normalizeWebDesignPublicBill(RAW_MONTHLY)!;

  it('標題：monthly 保留原標題', () => {
    expect(billTitles('monthly')).toEqual({ zh: '月費服務單據', en: 'MONTHLY SERVICE STATEMENT' });
  });

  it('狀態 mapping 同 WMS 一致', () => {
    expect(statusInfo('issued')).toMatchObject({ zh: '待付款', en: 'AWAITING PAYMENT', tone: 'live' });
    expect(statusInfo('paid')).toMatchObject({ zh: '已付款', en: 'PAID', tone: 'done' });
    expect(statusInfo('refunded')).toMatchObject({ zh: '已退款', en: 'REFUNDED', tone: 'muted' });
    expect(statusInfo('void')).toMatchObject({ zh: '已作廢', en: 'VOID', tone: 'dead' });
    expect(statusInfo('???')).toMatchObject({ key: 'issued' });
  });

  it('合計：負數減免行如實顯示，權威總額係 finalCents', () => {
    const rows = totalsPlan(bill);
    const grand = rows.find((r) => r.kind === 'grand')!;
    expect(grand.value).toBe(fmtHKD(78000));
    expect(rows.some((r) => r.kind === 'sub')).toBe(true);
  });

  it('付款 CTA：issued 且 finalCents>0 先有', () => {
    expect(canPay(bill)).toBe(true);
    expect(canPay({ status: 'paid', finalCents: 100 })).toBe(false);
    expect(canPay({ status: 'issued', finalCents: 0 })).toBe(false);
  });

  it('手續費提示：surchargeOn=false 改述（一字唔准改口徑）', () => {
    expect(surchargeNote({ surchargeOn: true })).toBe(SURCHARGE_DISCLAIMER);
    expect(surchargeNote({ surchargeOn: false })).toBe(SURCHARGE_OFF_NOTE);
    expect(surchargeNote({ surchargeOn: null })).toBe(SURCHARGE_DISCLAIMER);
  });

  it('fmtPeriod／部份退款判定', () => {
    expect(fmtPeriod('2026-11')).toBe('2026年11月');
    expect(fmtPeriod(null)).toBe('');
    const paidPartial: Pick<WebDesignPublicBillView, 'status' | 'refundedCents'> = {
      status: 'paid',
      refundedCents: 500,
    };
    expect(isPartialRefund(paidPartial)).toBe(true);
    expect(isPartialRefund({ status: 'paid', refundedCents: 0 })).toBe(false);
  });

  it('PUBLIC_BILL_TOKEN_RE 同 server 口徑一致', () => {
    expect(PUBLIC_BILL_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(PUBLIC_BILL_TOKEN_RE.test('abc')).toBe(false);
  });
});
