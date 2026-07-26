import { Link } from 'react-router';
import { StarGlyph } from './WishingStar';

/**
 * 未登入提示玻璃卡（Cart / Checkout 共用）
 * 唔好 hard redirect —— 頁面標題照舊顯示，下面畀張卡叫人登入。
 */
interface LoginPromptProps {
  message?: string;
}

export default function LoginPrompt({
  message = '登入會員之後，先可以睇到自己嘅購物車同落單。',
}: LoginPromptProps) {
  return (
    <div
      className="mx-auto mt-12 max-w-[420px] rounded-3xl border p-8 text-center md:p-10"
      style={{
        background: 'var(--glass-bg-strong)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex justify-center">
        <StarGlyph size={36} />
      </div>
      <h2 className="mt-4 font-serif-tc text-2xl font-semibold text-txt-1">請先登入</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-txt-2">{message}</p>
      <Link to="/login" className="btn btn-primary mt-6 w-full">
        去登入
      </Link>
      <p className="mt-4 text-[13px] text-txt-3">
        未係會員？
        <Link to="/register" className="text-purple-text underline-offset-4 hover:underline">
          一齊許願 →
        </Link>
      </p>
    </div>
  );
}
