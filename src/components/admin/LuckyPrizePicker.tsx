import { Gift } from 'lucide-react';
import { displayRemainingOf, type Prize } from '@/lib/luckyPrizeStock';

const GOLD = '#F5C518';

/**
 * 開獎前獎品庫存台：輪盤同抽獎劵共用。
 * 可抽同款逐款展示；已抽晒仍留低「剩 0 件」但停用，唔會靜靜雞消失或跳款。
 */
export default function LuckyPrizePicker({
  prizes,
  prizeNos,
  selectedPrizeId,
  locked,
  onSelect,
}: {
  prizes: Prize[];
  prizeNos: ReadonlyMap<number, number>;
  selectedPrizeId: number | null;
  locked: boolean;
  onSelect: (id: number) => void;
}) {
  const activePrizes = prizes.filter((p) => p.active);
  const availableCount = activePrizes.filter((p) => displayRemainingOf(p) > 0).length;

  return (
    <section className="w-full" aria-label="選擇獎品同逐件剩餘數">
      <div className="mb-2 flex w-full flex-wrap items-end justify-between gap-x-3 gap-y-1 px-1 text-left">
        <div>
          <p className="font-serif-tc text-[13px] font-bold tracking-[0.12em] text-gold-soft">獎品庫存</p>
          <p className="mt-0.5 text-[10.5px] tracking-[0.08em] text-txt-3">PRIZE INVENTORY・逐款實時剩餘</p>
        </div>
        <p className="font-mono text-[11px] text-txt-3">
          {availableCount} 款可抽 <span aria-hidden="true">／</span> {activePrizes.length} 款上架
        </p>
      </div>

      {activePrizes.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-4 text-center text-[13px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
          呢場冇抽得嘅獎品——去下面「獎品管理」加返，或者轉場次繼續抽
        </p>
      ) : (
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {activePrizes.map((p) => {
            const remaining = displayRemainingOf(p);
            const soldOut = remaining <= 0;
            const selected = selectedPrizeId === p.id && !soldOut;
            const name = p.name || p.sku;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                disabled={locked || soldOut}
                aria-pressed={selected}
                aria-label={`${name}，剩 ${remaining} 件${soldOut ? '，已抽晒' : ''}`}
                title={soldOut ? `${name} 已抽晒` : `揀 ${name}，剩 ${remaining} 件`}
                className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${
                  selected ? 'text-txt-1' : soldOut ? 'text-txt-3' : 'text-txt-2 hover:text-txt-1'
                } ${locked && !soldOut ? 'opacity-60' : ''}`}
                style={{
                  borderColor: selected ? GOLD : soldOut ? 'rgba(255,255,255,0.07)' : 'var(--space-line)',
                  background: selected
                    ? 'linear-gradient(135deg, rgba(245,197,24,0.20), rgba(245,197,24,0.055))'
                    : soldOut
                      ? 'rgba(255,255,255,0.015)'
                      : 'rgba(255,255,255,0.025)',
                  boxShadow: selected ? '0 8px 28px rgba(245,197,24,0.10), inset 0 1px rgba(255,246,216,0.08)' : undefined,
                  opacity: soldOut ? 0.58 : undefined,
                }}
              >
                <span className={`shrink-0 font-mono text-[11px] tracking-wider ${selected ? 'text-gold' : 'text-txt-3'}`}>
                  [{String(prizeNos.get(p.id) ?? 0).padStart(2, '0')}]
                </span>
                {p.imagePath ? (
                  <img
                    src={p.imagePath}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-lg border object-cover"
                    style={{ borderColor: selected ? 'rgba(245,197,24,0.55)' : 'var(--space-line)' }}
                  />
                ) : (
                  <Gift size={19} aria-hidden="true" className={`shrink-0 ${selected ? 'text-gold' : 'text-txt-3'}`} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[12.5px] font-semibold leading-snug">{name}</span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-txt-3">HK${p.price}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    className={`block whitespace-nowrap font-serif-tc text-[15px] font-bold ${soldOut ? 'text-pink-soft' : 'text-gold-soft'}`}
                  >
                    剩 {remaining} 件
                  </span>
                  <span className="mt-0.5 block text-[9.5px] tracking-[0.12em] text-txt-3">
                    {soldOut ? '已抽晒' : selected ? '開獎用呢款' : '可以抽'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {activePrizes.length > 0 && availableCount === 0 && (
        <p className="mt-2 text-center text-[12px] text-pink-soft">呢場上架獎品已抽晒；請加貨或轉場次，唔會自動跳去其他款。</p>
      )}
    </section>
  );
}
