import { Minus, Plus } from 'lucide-react';

/**
 * 數量步進器（± 玻璃圓鈕，§6.1 觸控目標 ≥ 44×44px）
 * quantity 減到 0 = 刪除（由调用方交畀 cart.updateQuantity 處理）
 */
interface QuantityStepperProps {
  quantity: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}

export default function QuantityStepper({ quantity, disabled, onChange }: QuantityStepperProps) {
  const btnClass =
    'flex min-h-11 min-w-11 items-center justify-center rounded-full border text-txt-1 transition-colors duration-200 hover:border-pink-soft disabled:opacity-40';

  return (
    <div className="flex items-center">
      <button
        type="button"
        className={btnClass}
        style={{ borderColor: 'var(--glass-border)', background: 'rgba(255,255,255,.06)' }}
        onClick={() => onChange(quantity - 1)}
        disabled={disabled}
        aria-label={quantity <= 1 ? '移除呢件商品' : '減少數量'}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <span
        className="min-w-9 text-center font-mono text-base text-txt-1"
        role="status"
        aria-label={`數量 ${quantity}`}
      >
        {quantity}
      </span>
      <button
        type="button"
        className={btnClass}
        style={{ borderColor: 'var(--glass-border)', background: 'rgba(255,255,255,.06)' }}
        onClick={() => onChange(quantity + 1)}
        disabled={disabled}
        aria-label="增加數量"
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
