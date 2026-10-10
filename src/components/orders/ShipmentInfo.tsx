/**
 * Wave 2 出貨同步顯示組件（2026-10-09）——會員訂單卡／訪客查單卡／單據／後台共用。
 *
 * - `ItemShipChips`：逐件貨品狀態 chip——已寄出（綠）／儲貨中（紫）／已取消＋原因（紅）／
 *   員工更改＋說明（金）。待寄出唔出聲（未確認單唔好出噪音），由 caller 按訂單狀態決定顯示。
 * - `ShipmentSection`：出貨批次區——物流方式 icon＋順豐單號（即撳追蹤 ↗）＋寄出時間＋
 *   呢批貨品清單；順豐批附「順豐系統一般需要 2–10 小時先更新追蹤狀態…」提示（老闆指定原句）。
 *
 * 資料來源兩款都食：會員 tRPC（Drizzle row：itemIds 係 JSON string、shippedAt 係 Date）
 * 同訪客 payload（itemIds 已 parse、shippedAt ISO string）——用呢個檔嘅 `ShipmentBatchView` 兼容。
 */
import { Archive, Handshake, Home, PencilLine, Truck, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** 順豐官方追蹤連結（香港繁中版，同 WMS SfQrScanButton 同一格式；舊 chn/sc 內地版唔啱香港客用） */
export function sfTrackingUrl(sfNo: string): string {
  return `https://www.sf-express.com/hk/tc/dynamic_function/waybill/#search/bill-number/${encodeURIComponent(sfNo)}`;
}

/** 順豐追蹤更新提示（老闆指定原句，email 同前台一致） */
export const SF_TRACKING_HINT =
  '順豐系統一般需要 2–10 小時先更新追蹤狀態，暫時撳入去未見到資料係正常嘅，請稍候再睇。';

export interface ShipmentBatchView {
  id: number;
  shipMethod: string; // 'sf'｜'face'｜'pickup'｜'storage'
  sfNo: string | null;
  /** DB row 係 JSON string；訪客 payload 已 parse 成 array */
  itemIds: string | number[];
  shippedAt: string | Date;
}

export const SHIP_METHOD_META: Record<string, { label: string; icon: LucideIcon }> = {
  sf: { label: '順豐速運', icon: Truck },
  face: { label: '面交交收', icon: Handshake },
  pickup: { label: '上門自取', icon: Home },
  storage: { label: '已入倉儲存', icon: Archive },
};

export function parseBatchItemIds(itemIds: string | number[]): number[] {
  if (Array.isArray(itemIds)) return itemIds;
  try {
    const parsed = JSON.parse(itemIds) as unknown;
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

function fmtDT(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-HK', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 批次 shipMethod 對照（畀逐件 chip 搵「儲貨中」用）：shipmentId → shipMethod */
export function batchMethodMap(shipments: ShipmentBatchView[]): Map<number, string> {
  return new Map(shipments.map((s) => [s.id, s.shipMethod]));
}

/**
 * 逐件貨品狀態 chips（件貨行下面一行細 chip）。
 * - showPending=true（訂單已確認後）先出「待寄出」灰 chip；否則 pending 唔出聲。
 * - methodMap 有批次對照時，shipped＋storage → 「儲貨中」。
 */
export function ItemShipChips({
  item,
  showPending,
  methodMap,
}: {
  item: {
    shipStatus?: string;
    shipmentId?: number | null;
    cancelReason?: string | null;
    /** v2.5.4：同款多件部分取消 — 已取消件數（>0 且未全取消 → 「部分取消 X 件」chip） */
    cancelledQty?: number | null;
    staffChangedAt?: string | Date | null;
    staffChangeNote?: string | null;
  };
  showPending: boolean;
  methodMap?: Map<number, string>;
}) {
  const chips: React.ReactNode[] = [];
  const status = item.shipStatus ?? 'pending';
  // v2.5.4：同款多件部分取消（未全取消先顯示；全取消咗就由「已取消」chip 話事）
  const partialQty = status !== 'cancelled' && (item.cancelledQty ?? 0) > 0 ? (item.cancelledQty ?? 0) : 0;
  if (partialQty > 0) {
    chips.push(
      <span
        key="partial"
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
        style={{ color: '#FFB020', borderColor: 'rgba(255,176,32,0.4)' }}
      >
        <XCircle size={11} aria-hidden="true" />
        部分取消 {partialQty} 件
      </span>,
    );
  }
  if (status === 'shipped') {
    const isStorage =
      item.shipmentId != null && methodMap?.get(item.shipmentId) === 'storage';
    chips.push(
      <span
        key="ship"
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
        style={
          isStorage
            ? { color: 'var(--lavender)', borderColor: 'color-mix(in srgb, var(--lavender) 40%, transparent)' }
            : {
                color: 'var(--success)',
                borderColor: 'color-mix(in srgb, var(--success) 40%, transparent)',
              }
        }
      >
        {isStorage ? <Archive size={11} aria-hidden="true" /> : <Truck size={11} aria-hidden="true" />}
        {isStorage ? '儲貨中' : '已寄出'}
      </span>,
    );
  } else if (status === 'cancelled') {
    chips.push(
      <span
        key="cancelled"
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
        style={{ color: '#FF6B5B', borderColor: 'rgba(255,107,91,0.4)' }}
      >
        <XCircle size={11} aria-hidden="true" />
        已取消
      </span>,
    );
  } else if (showPending) {
    chips.push(
      <span
        key="pending"
        className="inline-flex items-center gap-1 rounded-full border border-space-line px-2 py-0.5 text-[11px] text-txt-3"
      >
        待寄出
      </span>,
    );
  }
  if (item.staffChangedAt) {
    chips.push(
      <span
        key="changed"
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
        style={{ color: 'var(--gold)', borderColor: 'color-mix(in srgb, var(--gold) 40%, transparent)' }}
        title={item.staffChangeNote ?? undefined}
      >
        <PencilLine size={11} aria-hidden="true" />
        員工更改
      </span>,
    );
  }
  const notes: React.ReactNode[] = [];
  if (status === 'cancelled' && item.cancelReason) {
    notes.push(
      <span key="cr" className="block text-[12px]" style={{ color: '#FF6B5B' }}>
        取消原因：{item.cancelReason}
      </span>,
    );
  } else if (partialQty > 0 && item.cancelReason) {
    notes.push(
      <span key="crp" className="block text-[12px]" style={{ color: '#FFB020' }}>
        部分取消原因：{item.cancelReason}
      </span>,
    );
  }
  if (item.staffChangedAt && item.staffChangeNote) {
    notes.push(
      <span key="cn" className="block text-[12px] text-gold">
        更改說明：{item.staffChangeNote}
      </span>,
    );
  }
  if (chips.length === 0 && notes.length === 0) return null;
  return (
    <span className="mt-1 block">
      {chips.length > 0 && <span className="flex flex-wrap items-center gap-1.5">{chips}</span>}
      {notes}
    </span>
  );
}

/**
 * 出貨批次區（訂單卡／查單卡／單據用）。
 * items 用嚟對返「呢批寄咗邊幾件」（itemIds → 貨名 ×數量）。
 */
export default function ShipmentSection({
  shipments,
  items,
}: {
  shipments: ShipmentBatchView[];
  items: { id?: number; productName: string; size: string | null; quantity: number }[];
}) {
  if (shipments.length === 0) return null;
  const itemName = (id: number): string | null => {
    const it = items.find((x) => x.id === id);
    return it ? `${it.productName}${it.size ? `（${it.size}）` : ''} ×${it.quantity}` : null;
  };
  return (
    <section aria-label="出貨紀錄" className="mt-4 border-t border-space-line pt-4">
      <p className="mb-2.5 flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.14em] text-txt-3">
        <Truck size={13} aria-hidden="true" className="text-gold" />
        出貨紀錄
      </p>
      <ul className="space-y-2.5">
        {shipments.map((s) => {
          const meta = SHIP_METHOD_META[s.shipMethod] ?? {
            label: s.shipMethod,
            icon: Truck,
          };
          const Icon = meta.icon;
          const names = parseBatchItemIds(s.itemIds)
            .map(itemName)
            .filter((n): n is string => n != null);
          return (
            <li
              key={s.id}
              className="rounded-xl border border-space-line bg-space-2/60 px-3.5 py-3"
            >
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-medium text-txt-1">
                <Icon size={14} aria-hidden="true" className="text-gold" />
                {meta.label}
                {s.shipMethod === 'sf' && s.sfNo && (
                  <>
                    <span className="font-mono text-[13px] tracking-wide text-txt-2">{s.sfNo}</span>
                    <a
                      href={sfTrackingUrl(s.sfNo)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium transition-colors"
                      style={{
                        color: 'var(--gold)',
                        borderColor: 'color-mix(in srgb, var(--gold) 45%, transparent)',
                      }}
                    >
                      追蹤貨件 ↗
                    </a>
                  </>
                )}
              </p>
              <p className="mt-1 font-mono text-[11.5px] text-txt-3">寄出時間：{fmtDT(s.shippedAt)}</p>
              {names.length > 0 && (
                <p className="mt-1.5 text-[12.5px] text-txt-2">呢批：{names.join('、')}</p>
              )}
              {s.shipMethod === 'sf' && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-txt-3">{SF_TRACKING_HINT}</p>
              )}
              {(s.shipMethod === 'face' || s.shipMethod === 'pickup') && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-txt-3">
                  {s.shipMethod === 'face'
                    ? '貨品已按你揀嘅方式面交交收，如有問題 WhatsApp 我哋。'
                    : '貨品已可以上門自取，如有問題 WhatsApp 我哋。'}
                </p>
              )}
              {s.shipMethod === 'storage' && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-txt-3">
                  貨品已入倉儲存，想寄出／安排交收隨時 WhatsApp 我哋。
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
