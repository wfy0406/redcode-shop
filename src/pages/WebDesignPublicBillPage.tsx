// ===== v2026.11.13.2 redcode.red 公開單據頁（SPEC §9；公開頁，唔使登入）=====
// 路由：/web-design-bill/:token（App.tsx 掛 lazy route，BrowserRouter 乾淨 path 直達）
// 契約：
//   trpc.webDesignPublicBill.getPublic.useQuery({ token })      — 官網白名單代理 WMS getPublic
//   trpc.webDesignPublicBill.confirmAndPay.useMutation({ token, returnUrl }) — 代理 WMS confirmAndPay
// 頁面／QR／下載全部只用官網 canonical URL（https://redcode.red/web-design-bill/<token>），
// 唔會出現 WMS 內部域名；禁止 iframe／redirect。
// v2026.11.13.2：黑金高級文件感重做 — 單欄文件流、serif 大標題、香檳金箔 hairline；
// 中文人性分節標籤（單據資料／服務明細／費用總計／付款資料／備註紀錄／網上單據），
// document.title 跟載入／有效／失效三態（見下面 useEffect）。
// 注意：本頁係客戶經專屬 token 連結直達嘅公開頁，永遠唔准加會員登入要求，
// 亦唔准顯示內部資料（sourcePayload／開支／fee/net／操作人）。

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { trpc } from '@/providers/trpc';
import {
  PUBLIC_BILL_TOKEN_RE,
  REFUNDED_NOTE,
  billTitles,
  canPay,
  foldLabel,
  fmtHKD,
  fmtDateTime,
  fmtMethod,
  lineDisc,
  metaRows,
  normalizeWebDesignPublicBill,
  paidDetailLines,
  primaryDateLine,
  qrPayloadForBill,
  statusInfo,
  surchargeNote,
  totalsPlan,
  type WebDesignPublicBillView,
} from './webDesignPublicBill';
import {
  downloadWebDesignPublicBillPng,
  downloadWebDesignPublicBillPdf,
} from '@/utils/webDesignPublicBillDownload';
import './WebDesignPublicBillPage.css';

// 公司顯示名 fallback — 後端 getPublic 有返 companyName 會優先用佢
const COMPANY_NAME = 'RedCode HK直播台';
// 網頁設計業務專用：同 WMS 網頁設計介面同一個原裝透明 PNG；商城 FASHION DESIGN logo 唔用喺呢類單據。
const LOGO_SRC = '/redcode-web-design-logo.png';

// ---------- Airwallex.js SDK loader（redirectToCheckout 托管收銀台，同 WMS BillPage 路線 B）----------
// SDK script 只載入一次（module-level promise 記住），失敗會 reject 畀 caller 喺頁內顯示錯誤
let awSdkPromise: Promise<any> | null = null;
function loadAirwallexSdk(): Promise<any> {
  if (awSdkPromise) return awSdkPromise;
  awSdkPromise = new Promise((resolve, reject) => {
    const w = window as any;
    if (w.AirwallexComponentsSDK) {
      resolve(w.AirwallexComponentsSDK);
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://static.airwallex.com/components/sdk/v1/index.js';
    s.async = true;
    s.onload = () => {
      if (w.AirwallexComponentsSDK) resolve(w.AirwallexComponentsSDK);
      else reject(new Error('Airwallex SDK 載入異常'));
    };
    s.onerror = () => {
      awSdkPromise = null; // 失敗唔好 cache 住，畀客人重試
      reject(new Error('Airwallex SDK 載入失敗'));
    };
    document.head.appendChild(s);
  });
  return awSdkPromise;
}

// ---------- 網上單據 QR（payload＝onlineUrl；失敗 loud，唔出假 QR）----------
// website 已有 `qrcode` 依賴（同 PaymentHeroCard 同一做法 dynamic import，唔塞首屏 bundle）。
function BillQr({ payload }: { payload: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDataUrl(null);
    setFailed(null);
    import('qrcode')
      .then((QRCode) =>
        QRCode.default.toDataURL(payload, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: 'M',
          // 深底上 QR 一定要白底深字先掃到
          color: { dark: '#0c1220', light: '#ffffff' },
        }),
      )
      .then((u) => {
        if (alive) setDataUrl(u);
      })
      .catch((e) => {
        console.error('[wd-public-bill] QR 生成失敗', e);
        if (alive) setFailed('二維碼生成失敗，請重新整理頁面；你仍可用下面條連結開啟單據。');
      });
    return () => {
      alive = false;
    };
  }, [payload]);
  if (failed) {
    return (
      <div className="wdb-error-line" role="alert">
        {failed}
      </div>
    );
  }
  if (!dataUrl) {
    return (
      <div className="wdb-qr-loading" role="status">
        二維碼生成中…
      </div>
    );
  }
  return (
    <img
      className="wdb-qr"
      src={dataUrl}
      width={120}
      height={120}
      alt={`單據二維碼（掃描開啟 ${payload}）`}
    />
  );
}

export default function WebDesignPublicBillPage() {
  const { token } = useParams();
  const [payError, setPayError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<null | 'png' | 'pdf'>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  // token 格式唔啱就唔好打 API（server 一樣會擋，呢度慳一轉兼即時顯示）
  const tokenValid = !!token && PUBLIC_BILL_TOKEN_RE.test(token);

  // 公開 procedure：任何人經專屬 token 連結都開到（SPEC §9 getPublic）
  const query = trpc.webDesignPublicBill.getPublic.useQuery(
    { token: tokenValid ? token : '0'.repeat(32) },
    { enabled: tokenValid, retry: 1, refetchOnWindowFocus: false, staleTime: 0 },
  );

  const bill: WebDesignPublicBillView | null = useMemo(() => {
    const view = normalizeWebDesignPublicBill(query.data);
    // route token 權威：後端返嘅 publicToken 同網址唔一致 → 當錯誤（server 已擋，呢度雙保險）
    if (view && token && view.publicToken && view.publicToken !== token) return null;
    return view;
  }, [query.data, token]);

  // 確認付款 → 跳 Airwallex 托管支付頁（redirectToCheckout）
  const pay = trpc.webDesignPublicBill.confirmAndPay.useMutation({
    onSuccess: async (res: any) => {
      // 新官網 gateway 只保留 Airwallex HPP intent flow；後端已完全 strip 舊後端嘅
      // url/redirectUrl 跳轉欄，呢度唔再做任何 full-page legacy redirect（防 open redirect sink）。
      if (res?.ok === false || !res?.intentId || !res?.clientSecret) {
        setPayError(res?.error || '未能連接支付平台，請稍後再試。');
        return;
      }
      try {
        const env: 'demo' | 'prod' = res?.env === 'prod' ? 'prod' : 'demo';
        const sdk = await loadAirwallexSdk();
        const initialized = await sdk.init({ env, enabledElements: ['payments'] });
        const payments = initialized?.payments ?? sdk?.payments ?? (window as any)?._AirwallexSDKs?.payment;
        if (!payments || typeof payments.redirectToCheckout !== 'function') {
          throw new Error('支付元件未就緒');
        }
        // 全頁跳轉去 Airwallex 托管收銀台；成功後按 returnUrl 跳返呢張單
        await payments.redirectToCheckout({
          env,
          mode: 'payment',
          currency: 'HKD',
          intent_id: res.intentId,
          client_secret: res.clientSecret,
          successUrl: window.location.href,
        });
      } catch (e) {
        console.error('[wd-public-bill] airwallex redirect failed:', e);
        const msg = e instanceof Error ? e.message : String(e ?? '');
        setPayError(msg ? `未能開啟付款頁面：${msg}` : '未能開啟付款頁面，請稍後再試。');
      }
    },
    onError: (err: any) => {
      setPayError(err?.message || '未能連接支付平台，請稍後再試。');
    },
  });

  const handlePay = () => {
    if (!bill || !token || pay.isPending) return;
    setPayError(null);
    // 只傳目前專屬單據 URL 做 returnUrl（SPEC §4：前端只傳目前頁；server 驗證同源＋同 token path）
    pay.mutate({ token, returnUrl: window.location.href.split('#')[0] });
  };

  // 分頁標題跟單據狀態（v2026.11.13.2）：hook 一定要喺 early return 之前呼叫。
  // 載入中 → 「單據載入中」；有效單據 → 「單號｜單據類型」；無效 token／查詢失敗／無單據 → 「不存在或已失效」。
  // SeoManager 喺轉頁時先設一次靜態 title，呢個 effect 喺佢之後按真實資料覆寫，唔會改 seo.ts。
  useEffect(() => {
    if (tokenValid && query.isLoading) {
      document.title = '單據載入中｜RedCode Fashion Design';
      return;
    }
    if (bill) {
      document.title = `${bill.billNo}｜${billTitles(bill.kind).zh}｜RedCode Fashion Design`;
      return;
    }
    // 呢度即下面 error 分支嘅同一條件（!tokenValid || query.isError || !bill）
    document.title = '單據不存在或已失效｜RedCode Fashion Design';
  }, [tokenValid, query.isLoading, query.isError, bill]);

  // 下載單據（下載版係中性留底格式：項目／金額／備註／網上單據 QR；版面唔需要同互動頁一樣）
  const handleDownload = async (kind: 'png' | 'pdf') => {
    if (!bill || downloading) return;
    setDownloading(kind);
    setDlError(null);
    try {
      if (kind === 'png') await downloadWebDesignPublicBillPng(bill);
      else await downloadWebDesignPublicBillPdf(bill);
    } catch (e) {
      console.error('[wd-public-bill] download failed:', e);
      const msg = e instanceof Error ? e.message : String(e ?? '');
      setDlError(msg ? `下載失敗：${msg}` : '下載失敗，請稍後再試。');
    } finally {
      setDownloading(null);
    }
  };

  // ---------- 載入中 ----------
  if (tokenValid && query.isLoading) {
    return (
      <div className="wdb-root">
        <div className="wdb-loading">
          正在載入單據
          <hr className="wdb-loading-rule" />
        </div>
      </div>
    );
  }

  // ---------- 錯誤態：單據不存在或已失效（token 格式錯都行呢度）----------
  if (!tokenValid || query.isError || !bill) {
    return (
      <div className="wdb-root">
        <header className="wdb-topbar">
          <img className="wdb-logo" src={LOGO_SRC} alt={COMPANY_NAME} />
          <div className="wdb-company">{COMPANY_NAME}</div>
        </header>
        <div className="wdb-sheet">
          <div className="wdb-error-body">
            單據不存在或已失效
            <br />
            <span className="wdb-error-sub">請確認連結完整無誤，或聯絡 Red Code 重新發出單據。</span>
          </div>
          <div className="wdb-sec wdb-foot">
            <div className="wdb-foot-main">如有查詢，請聯絡 Red Code</div>
            <div className="wdb-foot-sub">此連結為專屬單據</div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 正常單據 ----------
  const company = bill.companyName || COMPANY_NAME;
  const st = statusInfo(bill.status);
  const isTest = bill.mode === 'test';
  const isVoid = st.key === 'void';
  const isPaid = st.key === 'paid';
  const isRefunded = st.key === 'refunded';
  const isIssued = st.key === 'issued';
  const dateLine = primaryDateLine(bill);
  const meta = metaRows(bill);
  const totals = totalsPlan(bill);
  const paidLines = paidDetailLines(bill);
  const payable = canPay(bill);
  const titles = billTitles(bill.kind);
  // QR payload＝畫面顯示嘅 onlineUrl（同一來源；無效就 loud，唔出假 QR）
  const onlineUrl = qrPayloadForBill(bill);

  return (
    <div className="wdb-root">
      {/* 頂欄：logo + 公司名 + 狀態印記 + test badge */}
      <header className="wdb-topbar">
        <img className="wdb-logo" src={LOGO_SRC} alt={company} />
        <div className="wdb-company">{company}</div>
        <div className="wdb-topbar-right">
          {isTest && <span className="wdb-test-badge">TEST MODE — 唔會真實扣款</span>}
          <span className={`wdb-status-chip wdb-tone-${st.tone}`}>
            <span className={`wdb-node wdb-tone-${st.tone}`} aria-hidden="true" />
            {st.zh} · {st.en}
          </span>
        </div>
      </header>

      <div className={`wdb-sheet${isVoid ? ' wdb-is-void' : ''}`}>
        {/* 單據資料：標題 + 單號 + 日期（project 單用專案標題） */}
        <section className="wdb-sec">
          <p className="wdb-sec-tag">單據資料</p>
          <div className="wdb-doc-row">
            <div>
              <h1 className="wdb-doc-title">{titles.zh}</h1>
              <div className="wdb-doc-sub">{titles.en}</div>
            </div>
            <span className={`wdb-status-chip wdb-tone-${st.tone}`}>
              <span className={`wdb-node wdb-tone-${st.tone}`} aria-hidden="true" />
              {st.zh}
            </span>
          </div>
          <div className="wdb-billno">{bill.billNo}</div>
          {dateLine && <div className="wdb-date-line">{dateLine}</div>}
        </section>

        {/* 客戶資料：客戶 / 帳期 / 專案 / 備註 */}
        <section className="wdb-sec">
          <p className="wdb-sec-tag">客戶資料</p>
          <dl className="wdb-meta">
            {meta.map(([k, v], i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt className={i === meta.length - 1 ? 'wdb-meta-end' : undefined}>{k}</dt>
                <dd className={i === meta.length - 1 ? 'wdb-meta-end' : undefined}>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* 服務明細 */}
        <section className="wdb-sec">
          <p className="wdb-sec-tag">服務明細</p>
          <table className="wdb-items">
            <thead>
              <tr>
                <th>項目</th>
                <th className="wdb-col-num">數量</th>
                <th className="wdb-col-num">單價</th>
                <th className="wdb-col-num">小計</th>
              </tr>
            </thead>
            <tbody>
              {bill.items.map((it, i) => {
                const d = lineDisc(it);
                const fold = d.has && !d.isGift ? foldLabel(d.orig, it.unitPriceCents) : '';
                return (
                  <tr key={i}>
                    <td>
                      <span className="wdb-item-name">{it.name}</span>
                      {d.has && (
                        <span className="wdb-disc-tag">
                          {d.isGift
                            ? `贈品・全額折扣 −${fmtHKD(d.disc)}`
                            : `折咗 ${fmtHKD(d.disc)}${fold ? `・${fold}` : ''}`}
                        </span>
                      )}
                    </td>
                    <td className="wdb-col-num">{it.qty}</td>
                    <td className="wdb-col-num">
                      {d.has && <span className="wdb-orig">{fmtHKD(d.orig)}</span>}
                      {fmtHKD(it.unitPriceCents)}
                    </td>
                    <td className="wdb-col-num">{fmtHKD(it.amountCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* 費用總計 */}
        <section className="wdb-sec">
          <p className="wdb-sec-tag">費用總計</p>
          {totals.map((r, i) =>
            r.kind === 'grand' ? (
              <div className="wdb-grand" key={i}>
                <span className="wdb-l">{r.label}</span>
                <span className="wdb-v">{r.value}</span>
              </div>
            ) : r.kind === 'saved' ? (
              <div className="wdb-saved" key={i}>
                {r.value}
              </div>
            ) : (
              <div className={`wdb-total-row wdb-kind-${r.kind}`} key={i}>
                {r.label && <span className="wdb-l">{r.label}</span>}
                <span className="wdb-v">{r.value}</span>
              </div>
            ),
          )}
        </section>

        {/* 付款資料：狀態 + 已付／退款／作廢資訊 + 付款 CTA */}
        <section className="wdb-sec">
          <p className="wdb-sec-tag">付款資料</p>
          <div className="wdb-status-box">
            <div className={`wdb-status-head wdb-tone-${st.tone}`}>
              <span className={`wdb-node wdb-tone-${st.tone}`} aria-hidden="true" />
              <span>{st.zh}</span>
              <span className="wdb-en">{st.en}</span>
            </div>

            {isPaid && paidLines.length > 0 && (
              <div className="wdb-paid-detail">
                {paidLines.map((ln, i) => (
                  <div key={i}>
                    {ln.warn ? (
                      <span className="wdb-warn">{ln.text}</span>
                    ) : ln.strong ? (
                      (() => {
                        const sep = ln.text.indexOf('　');
                        return (
                          <>
                            {ln.text.slice(0, sep + 1)}
                            <span className="wdb-v">{ln.text.slice(sep + 1)}</span>
                          </>
                        );
                      })()
                    ) : (
                      ln.text
                    )}
                  </div>
                ))}
              </div>
            )}

            {isRefunded && (
              <>
                {bill.refundedAt && (
                  <div className="wdb-paid-detail">退款時間　{fmtDateTime(bill.refundedAt)}</div>
                )}
                {typeof bill.refundedCents === 'number' && bill.refundedCents > 0 && (
                  <div className="wdb-paid-detail">
                    已退款　<span className="wdb-v">{fmtHKD(bill.refundedCents)}</span>
                  </div>
                )}
                {bill.paymentMethod && (
                  <div className="wdb-paid-detail">付款方式　{fmtMethod(bill.paymentMethod)}</div>
                )}
                <div className="wdb-refund-note">{REFUNDED_NOTE}</div>
              </>
            )}

            {isVoid && <div className="wdb-refund-note">此單據已作廢，唔使付款。如有疑問請聯絡 Red Code。</div>}
          </div>

          {/* issued 且金額有效先有付款 CTA（SPEC-EXPANSION §5） */}
          {isIssued && payable && (
            <>
              <button className="wdb-pay-btn" onClick={handlePay} disabled={pay.isPending}>
                {pay.isPending ? '正在連接支付平台…' : `確認付款　${fmtHKD(bill.finalCents)}`}
              </button>
              {/* 手續費提示同現有收款單據口徑一致 */}
              <p className="wdb-disclaimer">{surchargeNote(bill)}</p>
            </>
          )}
          {isIssued && !payable && (
            <p className="wdb-disclaimer">此單據無需付款。</p>
          )}
          {payError && <div className="wdb-error-line">{payError}</div>}
        </section>

        {/* 備註紀錄（專案單據 notes snapshot；text + updatedAt，唔公開操作人） */}
        {bill.notes.length > 0 && (
          <section className="wdb-sec">
            <p className="wdb-sec-tag">備註紀錄</p>
            <ul className="wdb-notes">
              {bill.notes.map((n, i) => (
                <li key={n.id ?? i} className="wdb-note">
                  <div className="wdb-note-text">{n.text}</div>
                  {n.updatedAt && <div className="wdb-note-at">更新於 {fmtDateTime(n.updatedAt)}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 網上單據（QR + onlineUrl；QR payload 同呢度顯示一字不變，SPEC §9 驗收） */}
        <section className="wdb-sec">
          <p className="wdb-sec-tag">網上單據</p>
          {onlineUrl ? (
            <div className="wdb-online">
              <BillQr payload={onlineUrl} />
              <div className="wdb-online-text">
                <div className="wdb-online-hint">掃描二維碼或開啟以下連結查看單據</div>
                <a className="wdb-online-url" href={onlineUrl}>
                  {onlineUrl}
                </a>
              </div>
            </div>
          ) : (
            <div className="wdb-error-line" role="alert">
              未能產生網上單據連結，請聯絡 Red Code 重新發出單據。
            </div>
          )}
        </section>

        {/* 底 */}
        <section className="wdb-sec wdb-foot">
          <div className="wdb-foot-main">如有查詢，請聯絡 Red Code</div>
          <div className="wdb-foot-sub">
            {bill.kind === 'project' ? '此連結為專屬專案服務單據' : '此連結為專屬月費單據'}
          </div>
        </section>
      </div>

      {/* 下載單據（圖片 / PDF）— 同單據本體分層嘅工具區，任何狀態都用得 */}
      <div className="wdb-dl-row">
        <button className="wdb-dl-btn" onClick={() => handleDownload('png')} disabled={downloading !== null}>
          {downloading === 'png' ? '製作中…' : '下載圖片 PNG'}
        </button>
        <button className="wdb-dl-btn" onClick={() => handleDownload('pdf')} disabled={downloading !== null}>
          {downloading === 'pdf' ? '製作中…' : '下載 PDF'}
        </button>
      </div>
      {dlError ? (
        <div className="wdb-error-line" style={{ maxWidth: 680, margin: '12px auto 0' }}>
          {dlError}
        </div>
      ) : (
        <div className="wdb-dl-hint">
          下載版係中性留底單據，包含項目、金額、備註同網上單據 QR；網上付款請用本頁付款掣。
        </div>
      )}
    </div>
  );
}
