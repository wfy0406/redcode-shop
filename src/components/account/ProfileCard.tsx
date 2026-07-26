import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { trpc } from '@/providers/trpc';
import FormField from './FormField';

/**
 * 會員資料卡（§P8 + R3 逐行 inline edit）
 * 稱呼／地址／年齡逐行 display ↔ edit 兩態，兩態共用行高 h-14 唔跳位；
 * 儲存 → auth.updateProfile → 成功 toast「資料已更新」+ utils.auth.me.invalidate()；
 * 失敗：錯誤訊息 persist 喺欄下直到改正。電話係登入帳號，唯讀。
 */

interface ProfileUser {
  id: number;
  name: string;
  phone: string;
  address?: string | null;
  age?: number | null;
}

interface ProfileCardProps {
  user: ProfileUser;
  onLogout: () => void;
  pushToast: (text: string) => void;
}

type EditableField = 'name' | 'address' | 'age';

const FIELD_LABEL: Record<EditableField, string> = {
  name: '稱呼',
  address: '地址',
  age: '年齡',
};

/** auth.updateProfile 契約（spec §1）：name/address/age 全 optional */
type ProfileUpdateInput = { name?: string; address?: string | null; age?: number | null };

function buildPayload(field: EditableField, draft: string): { payload: ProfileUpdateInput } | { error: string } {
  const trimmed = draft.trim();
  if (field === 'name') {
    if (!trimmed) return { error: '稱呼唔可以留空' };
    return { payload: { name: trimmed } };
  }
  if (field === 'address') {
    return { payload: { address: trimmed || null } };
  }
  // age：選填，1–120 整數
  if (!trimmed) return { payload: { age: null } };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 120) return { error: '年齡要係 1 至 120 嘅整數' };
  return { payload: { age: n } };
}

function DisplayRow({
  label,
  value,
  onEdit,
  disabled,
}: {
  label: string;
  value: string;
  onEdit?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-14 items-center gap-3">
      <span className="w-20 shrink-0 text-sm text-txt-3">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[15px] text-txt-1">{value}</span>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          className="shrink-0 text-sm text-pink-soft transition-colors duration-200 hover:text-pink-tint disabled:opacity-40"
        >
          編輯
        </button>
      )}
    </div>
  );
}

export default function ProfileCard({ user, onLogout, pushToast }: ProfileCardProps) {
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const updateProfile = trpc.auth.updateProfile.useMutation();

  const startEdit = (field: EditableField) => {
    setEditing(field);
    setError(null);
    setDraft(
      field === 'name'
        ? user.name
        : field === 'address'
          ? (user.address ?? '')
          : user.age != null
            ? String(user.age)
            : '',
    );
  };

  const cancelEdit = () => {
    setEditing(null);
    setError(null);
  };

  const save = async (field: EditableField) => {
    const parsed = buildPayload(field, draft);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    try {
      await updateProfile.mutateAsync(parsed.payload);
      await utils.auth.me.invalidate();
      pushToast('資料已更新');
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '儲存失敗，請稍後再試');
    }
  };

  const onEditKeyDown = (field: EditableField) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save(field);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const renderRow = (field: EditableField, displayValue: string) => {
    if (editing !== field) {
      return (
        <DisplayRow
          label={FIELD_LABEL[field]}
          value={displayValue}
          onEdit={() => startEdit(field)}
          disabled={updateProfile.isPending}
        />
      );
    }
    return (
      <FormField
        inline
        id={`profile-${field}`}
        label={FIELD_LABEL[field]}
        optional={field !== 'name'}
        value={draft}
        error={error ?? undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={onEditKeyDown(field)}
        autoFocus
        maxLength={field === 'name' ? 255 : undefined}
        inputMode={field === 'age' ? 'numeric' : undefined}
        autoComplete={field === 'name' ? 'name' : field === 'address' ? 'street-address' : 'off'}
        onFocus={(e) => {
          const len = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(len, len);
        }}
        actions={
          <span className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => void save(field)}
              disabled={updateProfile.isPending}
              className="btn btn-primary !px-4 !py-2 text-[13px] disabled:opacity-50"
            >
              {updateProfile.isPending ? '儲存中…' : '儲存'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={updateProfile.isPending}
              className="text-sm text-txt-3 transition-colors duration-200 hover:text-txt-1 disabled:opacity-40"
            >
              取消
            </button>
          </span>
        }
      />
    );
  };

  return (
    <div
      className="rounded-2xl border p-6 md:p-8"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-serif-tc text-2xl font-semibold text-txt-1">{user.name}</h2>
          <p className="mt-1 font-mono text-sm text-txt-3">會員編號 #{user.id}</p>
        </div>
        <button type="button" onClick={onLogout} className="btn btn-secondary !px-6 !py-2.5 text-sm">
          登出
        </button>
      </div>
      <div className="mt-5 divide-y divide-space-line border-t border-space-line">
        {renderRow('name', user.name)}
        <DisplayRow label="電話" value={user.phone} />
        {renderRow('address', user.address?.trim() ? user.address : '未填寫')}
        {renderRow('age', user.age != null ? `${user.age} 歲` : '未填寫')}
      </div>
    </div>
  );
}
