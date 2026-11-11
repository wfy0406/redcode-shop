/**
 * 直播場次公開摘要測試（v2026.11.11.2）——contracts/livePublicSummary 純函數，node 環境行。
 * 覆蓋：真件數／真分類組成、代表商品上限、無描述舊商品唔影響摘要、
 * 過往場次中性「場次商品記錄」文案、香港今日 YYYYMMDD、零商品保守回 ""。
 * （放 src/lib 係因為 vitest include 只掃 api/** 同 src/**；被測模組喺 contracts/。）
 */
import { describe, expect, it } from 'vitest';
import {
  emptyLivePublicCopy,
  hkTodayYmd,
  isValidLiveDateYmd,
  isValidLiveSessionStr,
  liveEra,
  liveFactsSentence,
  livePublicDescription,
  livePublicPath,
  resolveLiveMetaUpdate,
  summarizeLiveProducts,
} from '@contracts/livePublicSummary';

// 真商品行 fixture：有舊商品冇 category（DB default other 前嘅數據）、
// 有空名行（唔入代表商品）——全部唔包 description，證明摘要不依賴描述欄。
const FIXTURE = [
  { id: 11, name: '星空閃石上衣', category: 'top' },
  { id: 12, name: '高腰闊腳褲', category: 'pants' },
  { id: 13, name: '碎花長裙', category: 'dress' },
  { id: 14, name: '針織短上衣', category: 'top' },
  { id: 15, name: '絲質頸巾' }, // 無 category → 其他
];

describe('summarizeLiveProducts — 真件數同真分類組成', () => {
  it('件數係全場實數；分類按件數多→少排', () => {
    const s = summarizeLiveProducts(FIXTURE);
    expect(s.totalCount).toBe(5);
    expect(s.categories[0]).toEqual({ label: '上衣', count: 2 });
    expect(s.categories).toHaveLength(4);
    expect(s.categories).toEqual(
      expect.arrayContaining([
        { label: '上衣', count: 2 },
        { label: '褲', count: 1 },
        { label: '裙', count: 1 },
        { label: '其他', count: 1 },
      ]),
    );
  });

  it('唔識嘅分類值當「其他」，唔會出 raw code', () => {
    const s = summarizeLiveProducts([{ id: 1, name: 'X', category: 'alien-cat' }]);
    expect(s.categories).toEqual([{ label: '其他', count: 1 }]);
  });

  it('代表商品最多 3 件、按輸入順序、空名／壞 id 唔入', () => {
    const s = summarizeLiveProducts([
      { id: 1, name: '  ' },
      { id: -2, name: '壞 id' },
      { id: 3, name: 'A' },
      { id: 4, name: 'B' },
      { id: 5, name: 'C' },
      { id: 6, name: 'D' },
    ]);
    expect(s.highlights).toEqual([
      { id: 3, name: 'A' },
      { id: 4, name: 'B' },
      { id: 5, name: 'C' },
    ]);
    expect(s.totalCount).toBe(6); // 空名行照計件數
  });

  it('空場次：totalCount 0、句嘢都唔編', () => {
    const s = summarizeLiveProducts([]);
    expect(s).toEqual({ totalCount: 0, categories: [], highlights: [] });
    expect(liveFactsSentence(s, 'current')).toBe('');
    expect(liveFactsSentence(s, 'past')).toBe('');
  });
});

describe('liveFactsSentence — 事實句', () => {
  it('包含真件數、分類同代表商品名', () => {
    const text = liveFactsSentence(summarizeLiveProducts(FIXTURE), 'current');
    expect(text).toContain('共 5 件公開商品');
    expect(text).toContain('上衣 2 件');
    expect(text).toContain('褲 1 件');
    expect(text).toContain('裙 1 件');
    expect(text).toContain('代表商品：星空閃石上衣、高腰闊腳褲、碎花長裙');
    expect(text).toContain('以商品頁為準');
  });

  it('超過 4 類會收埋做「等 N 類」，唔會寫死長串', () => {
    const items = [
      { id: 1, name: 'a', category: 'top' },
      { id: 2, name: 'b', category: 'pants' },
      { id: 3, name: 'c', category: 'dress' },
      { id: 4, name: 'd', category: 'shoes' },
      { id: 5, name: 'e', category: 'skincare' },
    ];
    const text = liveFactsSentence(summarizeLiveProducts(items), 'current');
    expect(text).toContain('等 5 類');
  });

  it('過往場次：中性「場次商品記錄」；唔聲稱優惠有效、唔斷言已完結、冇編時間', () => {
    const text = liveFactsSentence(summarizeLiveProducts(FIXTURE), 'past');
    expect(text).toContain('場次商品記錄');
    expect(text).toContain('以商品頁而家顯示為準');
    expect(text).not.toContain('即睇即買');
    expect(text).not.toContain('優惠價');
    expect(text).not.toContain('已完結');
    expect(text).not.toMatch(/\d{1,2}:\d{2}/); // 冇任何時間
  });

  it('今日／未來場次唔會被誤標做歷史記錄', () => {
    const text = liveFactsSentence(summarizeLiveProducts(FIXTURE), 'current');
    expect(text).not.toContain('場次商品記錄');
    expect(text).toContain('以商品頁為準');
  });

  it('includeHighlights=false：留件數同分類，代表商品交俾 caller 出內鏈', () => {
    const text = liveFactsSentence(summarizeLiveProducts(FIXTURE), 'current', {
      includeHighlights: false,
    });
    expect(text).toContain('共 5 件公開商品');
    expect(text).not.toContain('代表商品');
    expect(text).not.toContain('星空閃石上衣');
  });
});

describe('livePublicDescription — 前後端共用 description builder', () => {
  const SUMMARY = summarizeLiveProducts(FIXTURE);

  it('全日同單場文案一定唔同；帶真日期、實數、分類、代表商品', () => {
    const day = livePublicDescription({ liveDate: '20261111', liveSession: null }, SUMMARY, '20261111');
    const session = livePublicDescription({ liveDate: '20261111', liveSession: '2' }, SUMMARY, '20261111');
    expect(day).not.toBeNull();
    expect(session).not.toBeNull();
    expect(day).not.toBe(session);
    expect(day).toContain('2026年11月11日 全日全部場次直播商品');
    expect(session).toContain('2026年11月11日 第2場直播商品');
    expect(session).toContain('共 5 件公開商品');
    expect(session).toContain('代表商品：星空閃石上衣');
  });

  it('過往場次中性「場次商品記錄」；未來場次唔會誤標', () => {
    const past = livePublicDescription({ liveDate: '20200101', liveSession: null }, SUMMARY, '20261111');
    expect(past).toContain('場次商品記錄');
    const future = livePublicDescription({ liveDate: '20990101', liveSession: null }, SUMMARY, '20261111');
    expect(future).not.toContain('場次商品記錄');
  });

  it('空 summary → null（caller 行空場次分流，唔出「0 件」假摘要）', () => {
    expect(
      livePublicDescription({ liveDate: '20261111', liveSession: null }, summarizeLiveProducts([]), '20261111'),
    ).toBeNull();
  });

  it('無效輸入 → null，絕不反射落 description', () => {
    expect(
      livePublicDescription({ liveDate: '20261111"><script>', liveSession: null }, SUMMARY, '20261111'),
    ).toBeNull();
    expect(
      livePublicDescription({ liveDate: '20261111', liveSession: 'abc' }, SUMMARY, '20261111'),
    ).toBeNull();
    expect(
      livePublicDescription({ liveDate: '20261111', liveSession: '0' }, SUMMARY, '20261111'),
    ).toBeNull();
  });

  it('假日曆日期（唔止格式）→ null：20230229／20261301 唔會被格式化做假日期', () => {
    expect(
      livePublicDescription({ liveDate: '20230229', liveSession: null }, SUMMARY, '20261111'),
    ).toBeNull();
    expect(
      livePublicDescription({ liveDate: '20261301', liveSession: '1' }, SUMMARY, '20261111'),
    ).toBeNull();
    // 閏年 2/29 係真日期，要過
    expect(
      livePublicDescription({ liveDate: '20240229', liveSession: null }, SUMMARY, '20240229'),
    ).toContain('2024年2月29日');
  });
});

describe('isValidLiveDateYmd / isValidLiveSessionStr — 真日曆驗證', () => {
  it('真日期過（閏年 2/29 都過）；假日曆日期唔過', () => {
    expect(isValidLiveDateYmd('20240229')).toBe(true);
    expect(isValidLiveDateYmd('20261028')).toBe(true);
    expect(isValidLiveDateYmd('20230229')).toBe(false);
    expect(isValidLiveDateYmd('20261301')).toBe(false);
    expect(isValidLiveDateYmd('20260230')).toBe(false);
    expect(isValidLiveDateYmd('2026-11-11')).toBe(false);
  });
  it('場次：正整數 1–999；零／前導零／負數／非數字唔過', () => {
    expect(isValidLiveSessionStr('1')).toBe(true);
    expect(isValidLiveSessionStr('999')).toBe(true);
    for (const bad of ['', '0', '01', '-1', '1.5', 'abc']) {
      expect(isValidLiveSessionStr(bad)).toBe(false);
    }
  });
});

describe('emptyLivePublicCopy — 空場次前後端共用文案', () => {
  it('全日／單場文案有分別，如實講冇公開商品、唔扮有貨', () => {
    const day = emptyLivePublicCopy({ liveDate: '20261111', liveSession: null });
    const session = emptyLivePublicCopy({ liveDate: '20261111', liveSession: '3' });
    expect(day?.title).toBe('2026年11月11日 直播暫未有公開商品｜RedCode Fashion Design');
    expect(session?.title).toBe('2026年11月11日 第3場直播暫未有公開商品｜RedCode Fashion Design');
    expect(session?.description).toContain('冇公開商品');
    expect(session?.description).toContain('以商品頁為準');
    expect(session?.description).not.toContain('直播優惠');
  });
  it('假日曆日期／無效場次 → null（絕不反射）', () => {
    expect(emptyLivePublicCopy({ liveDate: '20230229', liveSession: null })).toBeNull();
    expect(emptyLivePublicCopy({ liveDate: '20261111', liveSession: 'abc' })).toBeNull();
  });
});

describe('resolveLiveMetaUpdate — 狀態感知、可逆嘅 meta 決策', () => {
  const TARGET = { liveDate: '20261111', liveSession: '2' };
  const GENERIC = {
    title: '2026年11月11日 第2場直播商品｜RedCode Fashion Design',
    description: 'RedCode 2026年11月11日 第2場直播商品——（通用句）以商品頁為準。',
  };

  it('pending → 保留首口真 ItemList；error → 清舊 ItemList，兩者都唔當空場', () => {
    const pending = resolveLiveMetaUpdate(TARGET, { status: 'pending', data: [] }, '20261111', GENERIC);
    expect(pending).toEqual({
      title: GENERIC.title,
      description: GENERIC.description,
      robots: 'index, follow',
      canonicalPath: '/products?liveDate=20261111&liveSession=2',
    });

    // 包括「曾經空場 success[]，之後 refetch 故障但 React Query 留住 data=[]」
    const error = resolveLiveMetaUpdate(TARGET, { status: 'error', data: [] }, '20261111', GENERIC);
    expect(error).toEqual({
      title: GENERIC.title,
      description: GENERIC.description,
      robots: 'index, follow',
      canonicalPath: '/products?liveDate=20261111&liveSession=2',
      clearRouteSchema: true,
    });
  });

  it('success＋[]（查詢成功、真空場次）→ 空場次文案＋noindex＋移除 canonical', () => {
    const update = resolveLiveMetaUpdate(TARGET, { status: 'success', data: [] }, '20261111', GENERIC);
    expect(update?.title).toBe('2026年11月11日 第2場直播暫未有公開商品｜RedCode Fashion Design');
    expect(update?.description).toContain('冇公開商品');
    expect(update?.robots).toBe('noindex, nofollow');
    expect(update?.canonicalPath).toBeNull();
    expect(update?.clearRouteSchema).toBe(true);
  });

  it('success＋有貨 → 真摘要 description，並還原 robots／canonical（empty→有貨可逆）', () => {
    const update = resolveLiveMetaUpdate(TARGET, { status: 'success', data: FIXTURE }, '20261111', GENERIC);
    expect(update?.description).toBe(
      livePublicDescription(TARGET, summarizeLiveProducts(FIXTURE), '20261111'),
    );
    expect(update?.title).toBe(GENERIC.title);
    expect(update?.robots).toBe('index, follow');
    expect(update?.canonicalPath).toBe('/products?liveDate=20261111&liveSession=2');
  });

  it('無效場次目標 → null（絕不反射）', () => {
    expect(
      resolveLiveMetaUpdate({ liveDate: '20230229', liveSession: null }, { status: 'success', data: [] }, '20261111', GENERIC),
    ).toBeNull();
    expect(
      resolveLiveMetaUpdate({ liveDate: '20261111', liveSession: 'abc' }, { status: 'success', data: FIXTURE }, '20261111', GENERIC),
    ).toBeNull();
  });

  it('livePublicPath 同 server livePath 一致（canonical 前後端唔分叉）', () => {
    expect(livePublicPath(TARGET)).toBe('/products?liveDate=20261111&liveSession=2');
    expect(livePublicPath({ liveDate: '20261111', liveSession: null })).toBe('/products?liveDate=20261111');
    expect(livePublicPath({ liveDate: '20230229', liveSession: null })).toBeNull();
  });
});

describe('liveEra / hkTodayYmd — 場次時代', () => {
  it('liveDate 早過香港今日 → past；當日／未來 → current', () => {
    expect(liveEra('20200101', '20261111')).toBe('past');
    expect(liveEra('20261111', '20261111')).toBe('current');
    expect(liveEra('20990101', '20261111')).toBe('current');
  });
  it('壞輸入保守當 current（唔會誤標歷史記錄）', () => {
    expect(liveEra('bad', '20261111')).toBe('current');
    expect(liveEra('20261111', 'bad')).toBe('current');
  });
  it('hkTodayYmd 出 YYYYMMDD 真日曆日期（香港時區）', () => {
    // UTC 2026-11-11 16:00 ＝ 香港 2026-11-12 00:00
    expect(hkTodayYmd(new Date(Date.UTC(2026, 10, 11, 16, 0, 0)))).toBe('20261112');
    expect(hkTodayYmd(new Date(Date.UTC(2026, 10, 11, 15, 59, 59)))).toBe('20261111');
    expect(hkTodayYmd()).toMatch(/^\d{8}$/);
  });
});
