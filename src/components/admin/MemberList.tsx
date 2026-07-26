import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDate, fmtHKD } from './format';
import { LoadingBlock } from './WishingStar';

/**
 * 會員列表（F-H，admin only）—— trpc.members.list
 * 表格：名／電話／email／註冊日期／訂單數／累計消費（排除 cancelled/rejected），按註冊日期新至舊。
 * 後端 membersRouter 未 merge 前 tsc 會報 does not exist（預期），本地型別同 spec §B4 契約一致。
 */

/** membersRouter 未 merge 前嘅本地型別（同 spec §B4 契約一致） */
type MemberRow = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  createdAt: Date | string;
  orderCount: number;
  totalSpent: number;
};

export default function MemberList() {
  const listQuery = trpc.members.list.useQuery(undefined);
  const members = useMemo(() => (listQuery.data ?? []) as MemberRow[], [listQuery.data]);

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Users size={16} aria-hidden="true" className="text-lavender" />
        會員
        {!listQuery.isLoading && !listQuery.isError && (
          <span className="font-mono text-[13px] font-normal text-txt-3">（{members.length}）</span>
        )}
      </h3>
      {listQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊會員名單…" />
      ) : listQuery.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft">
          載入會員失敗：{listQuery.error.message}
        </p>
      ) : members.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">暫時冇會員。</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[14px]">
            <thead>
              <tr
                className="border-b text-left text-[12px] text-txt-3"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <th className="py-2 pr-3 font-normal">名</th>
                <th className="py-2 pr-3 font-normal">電話</th>
                <th className="py-2 pr-3 font-normal">Email</th>
                <th className="py-2 pr-3 font-normal">註冊日期</th>
                <th className="w-16 py-2 pr-3 text-right font-normal">訂單數</th>
                <th className="w-28 py-2 text-right font-normal">累計消費</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.id}
                  className="border-b last:border-0"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <td className="max-w-0 truncate py-2.5 pr-3 text-txt-1">{m.name}</td>
                  <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-2">{m.phone}</td>
                  <td className="max-w-0 truncate py-2.5 pr-3 font-mono text-[13px] text-txt-3">
                    {m.email || '—'}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-3">
                    {fmtDate(m.createdAt)}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-[13px] text-txt-2">
                    {m.orderCount}
                  </td>
                  <td className="py-2.5 text-right font-mono text-[13px] text-pink">
                    {fmtHKD(m.totalSpent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
