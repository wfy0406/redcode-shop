import { useState } from 'react';
import { trpc } from '@/providers/trpc';
import FormField from './FormField';
import WishingStar from './WishingStar';

/**
 * 「完成會員資料」卡（2026-08-04 Google 登入配套）
 * Google 開戶嗰陣淨係攞到 email 同名，電話要用 g- 佔位頂住 ——
 * 呢張卡喺會員中心頂置（電話仲係 g- 先出現），將 Google 預填嘅資料擺晒出嚟：
 * 稱呼預填可改；Email 鎖定跟 Google 電郵（2026-08-04 Glo 要求，唯讀唔准改）；
 * 電話空白要親手填，撳「確認儲存」先真正落實（＝ Glo 講嘅「預設可改完先確認」）。
 * 儲存成功後 user.phone 變返真號，呢張卡自動消失。
 */

interface CompleteProfileUser {
  id: number;
  name: string;
  phone: string;
  email?: string | null;
}

interface CompleteProfileCardProps {
  user: CompleteProfileUser;
  pushToast: (text: string) => void;
}

/** 香港電話：8 位本地號，或者 852 前綴 11 位（後端會再正規化） */
function isValidHKPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 8 || (digits.length === 11 && digits.startsWith('852'));
}

export default function CompleteProfileCard({ user, pushToast }: CompleteProfileCardProps) {
  const utils = trpc.useUtils();
  const updateProfile = trpc.auth.updateProfile.useMutation();

  const [name, setName] = useState(user.name);
  // Email 鎖定（2026-08-04 Glo 要求）：Google 開戶嘅帳號 email 跟實 Google 電郵，唔准改 → 淨係讀，冇 setter
  const [email] = useState(user.email ?? '');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (updateProfile.isPending) return;
    setError(null);
    if (!name.trim()) {
      setError('稱呼唔可以留空');
      return;
    }
    const emailTrimmed = email.trim();
    if (emailTrimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      setError('Email 格式唔啱，請再檢查');
      return;
    }
    if (!phone.trim()) {
      setError('請填返你嘅電話號碼（Google 冇呢項資料，要你親手填一次）');
      return;
    }
    if (!isValidHKPhone(phone)) {
      setError('請輸入香港 8 位電話號碼（例如 9123 4567）');
      return;
    }
    try {
      await updateProfile.mutateAsync({
        name: name.trim(),
        email: emailTrimmed || null,
        phone: phone.trim(),
      });
      await utils.auth.me.invalidate();
      pushToast('會員資料已確認 ✓');
      // 唔使自己收卡：phone 一變真號，阿媽（Account 頁）就唔再 render 呢張卡
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '儲存失敗，請稍後再試');
    }
  };

  return (
    <div
      className="rounded-2xl border p-6 md:p-8"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--gold)',
      }}
    >
      <p className="font-mono text-xs tracking-[0.2em] text-gold">ONE LAST STEP</p>
      <h2 className="mt-2 font-serif-tc text-2xl font-semibold text-txt-1">完成會員資料 ✦</h2>
      <p className="mt-3 text-[14px] leading-[1.8] text-txt-2">
        你係用 Google 帳號登入，我哋已經幫你開好會員戶口。
        Email 跟實你嘅 Google 電郵（唔可以更改），稱呼可以改，
        <span className="text-txt-1">電話就要你親手填一次</span>，填好撳「確認儲存」。
      </p>

      <div className="mt-5 flex flex-col gap-5">
        <FormField
          id="cp-name"
          label="稱呼"
          autoComplete="name"
          placeholder="點稱呼你好？"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {/* Email 鎖定（2026-08-04 Glo 要求）：Google 開戶嘅帳號 email 跟實 Google 電郵，唯讀顯示 */}
        <div className="w-full">
          <span className="mb-2 block text-sm text-txt-2">Email（你嘅 Google 電郵，唔可以更改）</span>
          <div className="flex h-12 w-full items-center rounded-xl border border-space-line bg-space-2 px-4 text-[15px] text-txt-3">
            {email}
          </div>
        </div>
        <FormField
          id="cp-phone"
          label="電話（Google 冇呢項資料，要親手填一次）"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="例如 9123 4567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>

      <p className="mt-3 text-[13px] leading-[1.7] text-txt-3">
        電話用嚟對數同執貨聯絡你，填一次之後就記住，以後落單唔使再填。
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 flex items-center gap-2 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
            <path
              d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
              fill="var(--gold)"
            />
          </svg>
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void onConfirm()}
        disabled={updateProfile.isPending}
        className="btn btn-primary mt-5 w-full disabled:opacity-70"
      >
        {updateProfile.isPending ? <WishingStar size={16} spinning /> : '確認儲存'}
      </button>
    </div>
  );
}
