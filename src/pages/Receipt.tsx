import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { LoadingBlock } from '@/components/admin/WishingStar';

/**
 * 訂單單據 /#/receipt/:orderId —— 白紙黑字嘅正式單據，可以列印／儲存 PDF。
 * 會員喺會員中心撳「單據」睇自己嘅單；員工喺後台撳「單據」新分頁開任何單。
 * server（orders.receipt）把關：會員只攞到自己嘅單。
 * 列印時用 visibility 技巧淨係印 .receipt-paper（網站導航唔會上紙）。
 */

const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;

const fmtMoney = (n: number) => `HK$${n.toLocaleString('en-HK')}`;

/** HKT YYYY-MM-DD HH:mm */
function fmtDateTimeHKT(d: Date | string): string {
  const t = new Date(new Date(d).getTime() + HKT_OFFSET_MS);
  return t.toISOString().slice(0, 16).replace('T', ' ');
}

const STATUS_TEXT: Record<string, string> = {
  pending_payment: '待付款',
  payment_review: '對數中',
  approved: '已確認',
  rejected: '待重傳付款截圖',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
};

const ink = '#211d18';
const inkSoft = '#77705f';
const line = '#e6e0d5';

export default function Receipt() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const id = Number(orderId);

  // 後台「單據」係新分頁開——分頁冇瀏覽歷史，navigate(-1) 會冇反應；
  // 冇歷史就按身份返去所屬頁（員工 → 後台，會員 → 會員中心）
  const goBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(user?.role === 'staff' || user?.role === 'admin' ? '/admin' : '/account');
    }
  };
  const q = trpc.orders.receipt.useQuery(
    { orderId: id },
    { enabled: Number.isInteger(id) && id > 0, retry: false, refetchOnWindowFocus: false },
  );

  if (q.isLoading) {
    return (
      <section className="mx-auto flex min-h-[50dvh] w-full max-w-[820px] items-center justify-center px-5 py-20">
        <LoadingBlock text="許願星準備緊單據…" />
      </section>
    );
  }

  if (q.isError || !q.data) {
    return (
      <section className="mx-auto flex min-h-[50dvh] w-full max-w-[820px] flex-col items-center justify-center gap-5 px-5 py-20">
        <p className="text-[15px] text-pink-soft">
          開唔到單據：{q.error?.message ?? '訂單不存在'}
        </p>
        <button
          type="button"
          onClick={goBack}
          className="btn btn-secondary !px-6 !py-2.5 text-[14px]"
        >
          返回
        </button>
      </section>
    );
  }

  const order = q.data;
  const subtotal = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const deliveryText =
    order.deliveryMethod === 'sf_station'
      ? `順豐站自取${order.pickupPoint ? `：${order.pickupPoint}` : ''}`
      : order.deliveryMethod === 'sf_locker'
        ? `順豐智能櫃自取${order.pickupPoint ? `：${order.pickupPoint}` : ''}`
        : '送貨上門';

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-10 md:px-8">
      {/* 操作列（列印時隱藏） */}
      <div className="receipt-no-print mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          className="btn btn-secondary !px-4 !py-2 text-[13px]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          返回
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="btn btn-primary !px-5 !py-2 text-[13px]"
        >
          <Printer size={14} aria-hidden="true" />
          列印／儲存 PDF
        </button>
      </div>

      {/* 單據紙（列印就係呢張） */}
      <div
        className="receipt-paper"
        style={{
          background: '#ffffff',
          color: ink,
          borderRadius: 12,
          padding: 'clamp(28px, 6vw, 48px)',
          boxShadow: '0 12px 48px rgba(0, 0, 0, 0.4)',
        }}
      >
        {/* 檔頭：品牌 + 單據 */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            borderBottom: `2px solid ${ink}`,
            paddingBottom: 18,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src="/logo.png" alt="RedCode" style={{ height: 40, width: 'auto' }} />
            <div>
              <p style={{ fontSize: 17, fontWeight: 700, letterSpacing: '0.04em' }}>
                RedCode Fashion Design
              </p>
              <p style={{ fontSize: 12, color: inkSoft }}>redcode.red</p>
            </div>
          </div>
          <p style={{ fontSize: 24, fontWeight: 700, letterSpacing: '0.12em' }}>單據</p>
        </div>

        {/* 單據資料 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '10px 24px',
            marginTop: 18,
            fontSize: 13.5,
          }}
        >
          <p>
            <span style={{ color: inkSoft }}>單據編號：</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{order.orderNo}</span>
          </p>
          <p>
            <span style={{ color: inkSoft }}>落單日期：</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>
              {fmtDateTimeHKT(order.createdAt)}
            </span>
          </p>
          <p>
            <span style={{ color: inkSoft }}>訂單狀態：</span>
            {STATUS_TEXT[order.status] ?? order.status}
          </p>
          <p>
            <span style={{ color: inkSoft }}>客戶：</span>
            {order.user.name}
          </p>
          <p>
            <span style={{ color: inkSoft }}>電話：</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{order.user.phone}</span>
          </p>
        </div>

        {/* 貨品表 */}
        <table style={{ width: '100%', marginTop: 24, borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ borderTop: `1px solid ${ink}`, borderBottom: `1px solid ${ink}` }}>
              <th style={{ textAlign: 'left', padding: '8px 4px', fontWeight: 700 }}>貨品</th>
              <th style={{ textAlign: 'right', padding: '8px 4px', fontWeight: 700, width: 90 }}>
                單價
              </th>
              <th style={{ textAlign: 'right', padding: '8px 4px', fontWeight: 700, width: 56 }}>
                數量
              </th>
              <th style={{ textAlign: 'right', padding: '8px 4px', fontWeight: 700, width: 100 }}>
                小計
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} style={{ borderBottom: `1px solid ${line}` }}>
                <td style={{ padding: '10px 4px' }}>
                  <p style={{ fontWeight: 600 }}>{item.productName}</p>
                  <p style={{ fontSize: 12, color: inkSoft, fontFamily: 'ui-monospace, monospace' }}>
                    {item.sku}
                    {item.size ? `・${item.size}` : ''}
                  </p>
                </td>
                <td
                  style={{
                    padding: '10px 4px',
                    textAlign: 'right',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {fmtMoney(item.price)}
                </td>
                <td
                  style={{
                    padding: '10px 4px',
                    textAlign: 'right',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {item.quantity}
                </td>
                <td
                  style={{
                    padding: '10px 4px',
                    textAlign: 'right',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {fmtMoney(item.price * item.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 金額總結 */}
        <div style={{ marginTop: 16, marginLeft: 'auto', maxWidth: 300, fontSize: 13.5 }}>
          <p style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ color: inkSoft }}>貨品合計</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{fmtMoney(subtotal)}</span>
          </p>
          {order.discountAmount > 0 && (
            <p style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ color: inkSoft }}>
                優惠碼{order.promoCode ? `（${order.promoCode}）` : ''}折扣
              </span>
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>
                −{fmtMoney(order.discountAmount)}
              </span>
            </p>
          )}
          <p
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              borderTop: `2px solid ${ink}`,
              marginTop: 8,
              paddingTop: 10,
            }}
          >
            <span style={{ fontWeight: 700 }}>實收總額</span>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 22, fontWeight: 700 }}>
              {fmtMoney(order.total)}
            </span>
          </p>
        </div>

        {/* 取貨 + 備註 */}
        <div style={{ marginTop: 26, borderTop: `1px solid ${line}`, paddingTop: 14, fontSize: 13 }}>
          <p>
            <span style={{ color: inkSoft }}>取貨方式：</span>
            {deliveryText}
          </p>
          {order.deliveryMethod === 'address' && order.address && (
            <p style={{ marginTop: 4 }}>
              <span style={{ color: inkSoft }}>收件地址：</span>
              {order.address}
            </p>
          )}
          {order.note && (
            <p style={{ marginTop: 4 }}>
              <span style={{ color: inkSoft }}>備註：</span>
              {order.note}
            </p>
          )}
        </div>

        {/* 頁尾 */}
        <p style={{ marginTop: 34, textAlign: 'center', fontSize: 12.5, color: inkSoft }}>
          多謝支持 RedCode！如有查詢，請聯絡我哋並提供單據編號。
        </p>
      </div>

      {/* 列印規則：淨係印張單據，網站其他嘢全部隱藏 */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .receipt-paper, .receipt-paper * { visibility: visible; }
          .receipt-paper {
            position: absolute;
            inset: 0;
            width: 100%;
            border-radius: 0 !important;
            box-shadow: none !important;
            padding: 24px !important;
          }
        }
      `}</style>
    </section>
  );
}
