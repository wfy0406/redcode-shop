import { useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { LoadingBlock } from './WishingStar';

/**
 * 操作日誌（admin only）—— trpc.audit.list
 * 記低管理員／員工／會員嘅關鍵改動：落單、上傳截圖、審批、出貨/取消、
 * 商品/優惠碼/打卡相/設定改動、會員註冊/修改/重設密碼/刪除、員工帳號改動、WMS 重試。
 * 表格：時間／操作者／角色／動作／詳情；支援按動作類型篩選。最新 200 條。
 */

type AuditRow = {
  id: number;
  actorId: number | null;
  actorName: string;
  actorRole: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: Date | string;
};

const ACTION_LABEL: Record<string, string> = {
  'member.register': '會員註冊',
  'member.update': '修改會員資料',
  'member.resetPassword': '重設會員密碼',
  'member.emailResetPassword': 'Email自助重設密碼',
  'member.remove': '刪除會員',
  'order.create': '客人落單',
  'order.attachProof': '上傳截圖',
  'order.approve': '批准付款',
  'order.reject': '拒絕付款',
  'order.ship': '轉出貨',
  'order.cancel': '取消訂單',
  'order.resyncWms': '重試WMS同步',
  'product.create': '新增商品',
  'product.update': '更新商品',
  'product.remove': '刪除商品',
  'promo.create': '新增優惠碼',
  'promo.update': '更新優惠碼',
  'promo.remove': '刪除優惠碼',
  'praise.create': '新增打卡相',
  'praise.update': '更新打卡相',
  'praise.remove': '刪除打卡相',
  'setting.upsert': '更新設定',
  'staff.create': '開新帳號',
  'staff.updateRole': '改權限',
  'staff.remove': '刪除帳號',
};

const ROLE_META: Record<string, { label: string; color: string }> = {
  admin: { label: '管理員', color: 'var(--gold)' },
  staff: { label: '員工', color: 'var(--lavender)' },
  member: { label: '會員', color: 'var(--starlight)' },
  system: { label: '系統', color: 'var(--text-3)' },
};

const FILTERS: { key: string; label: string; match: (a: string) => boolean }[] = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'order', label: '訂單', match: (a) => a.startsWith('order.') },
  { key: 'member', label: '會員', match: (a) => a.startsWith('member.') },
  { key: 'product', label: '商品', match: (a) => a.startsWith('product.') },
  { key: 'staff', label: '帳號', match: (a) => a.startsWith('staff.') },
  { key: 'other', label: '其他', match: (a) => /^(promo|praise|setting)\./.test(a) },
];

function fmtTime(d: Date | string): string {
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export default function AuditLog() {
  const [filter, setFilter] = useState('all');
  const listQuery = trpc.audit.list.useQuery(undefined, { refetchOnWindowFocus: false });
  const rows = useMemo(() => (listQuery.data ?? []) as AuditRow[], [listQuery.data]);
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const filtered = useMemo(() => rows.filter((r) => active.match(r.action)), [rows, active]);

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <ScrollText size={16} aria-hidden="true" className="text-gold" />
        操作日誌
        {!listQuery.isLoading && !listQuery.isError && (
          <span className="font-mono text-[13px] font-normal text-txt-3">
            （最新 {rows.length} 條）
          </span>
        )}
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        管理員、員工同會員嘅關鍵改動都會記低喺度，包括邊個幾時做咗咩。
      </p>

      {/* 篩選 chips */}
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="按類型篩選">
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(f.key)}
              className="rounded-full border px-3.5 py-1.5 text-[13px] transition-colors"
              style={{
                borderColor: on ? 'var(--pink)' : 'var(--space-line)',
                color: on ? 'var(--pink)' : 'var(--text-3)',
                background: on ? 'var(--glass-bg)' : 'transparent',
                fontWeight: on ? 700 : 400,
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {listQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊日誌…" />
      ) : listQuery.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft">
          載入日誌失敗：{listQuery.error.message}
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">
          {rows.length === 0 ? '暫時未有紀錄（新部署之後嘅改動先會開始記）。' : '呢個類型冇紀錄。'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-[14px]">
            <thead>
              <tr
                className="border-b text-left text-[12px] text-txt-3"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <th className="w-36 py-2 pr-3 font-normal">時間</th>
                <th className="w-28 py-2 pr-3 font-normal">操作者</th>
                <th className="w-20 py-2 pr-3 font-normal">角色</th>
                <th className="w-28 py-2 pr-3 font-normal">動作</th>
                <th className="py-2 font-normal">詳情</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const role = ROLE_META[r.actorRole] ?? ROLE_META.system;
                return (
                  <tr
                    key={r.id}
                    className="border-b last:border-0"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-3">
                      {fmtTime(r.createdAt)}
                    </td>
                    <td className="max-w-0 truncate py-2.5 pr-3 text-txt-1">{r.actorName}</td>
                    <td className="py-2.5 pr-3 text-[13px]" style={{ color: role.color }}>
                      {role.label}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-lavender">
                      {ACTION_LABEL[r.action] ?? r.action}
                    </td>
                    <td className="py-2.5 text-[13px] leading-[1.55] text-txt-2">
                      {r.detail ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
