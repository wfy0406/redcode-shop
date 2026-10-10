import { useEffect, useMemo, useState } from 'react';
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
  'approval.request': '提交審批請求',
  'approval.approve': '批准審批',
  'approval.reject': '拒絕審批',
  'promo.marketingEmail': '寄促銷電郵',
  // v2.2.17：順豐站點同步紀錄（成功/部分失敗/失敗都會入日誌，詳情欄有寫）
  'station.upsert': '新增/更新站點',
  'station.delete': '刪除站點',
  'station.reseed': '重新導入站點清單',
  'station.sync': '順豐站點每日同步',
  'station.syncNow': '順豐站點即時同步',
  // 2026-10-10（Wave 4 老闆指示）：日誌保留期 / 清除
  'audit.purge': '清除舊日誌',
  'audit.retention': '改日誌保留期',
};

const ROLE_META: Record<string, { label: string; color: string }> = {
  admin: { label: '管理員', color: 'var(--gold)' },
  staff: { label: '員工', color: 'var(--lavender)' },
  supervisor: { label: '主管', color: '#b79cff' },
  member: { label: '會員', color: 'var(--starlight)' },
  system: { label: '系統', color: 'var(--text-3)' },
};

const FILTERS: { key: string; label: string; match: (a: string) => boolean }[] = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'order', label: '訂單', match: (a) => a.startsWith('order.') },
  { key: 'member', label: '會員', match: (a) => a.startsWith('member.') },
  { key: 'product', label: '商品', match: (a) => a.startsWith('product.') },
  { key: 'staff', label: '帳號', match: (a) => a.startsWith('staff.') },
  { key: 'approval', label: '審批', match: (a) => a.startsWith('approval.') },
  { key: 'other', label: '其他', match: (a) => /^(promo|praise|setting|station|audit)\./.test(a) },
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

      {/* 2026-10-10（Wave 4 老闆指示）：日誌保留期管理（admin） */}
      <RetentionCard />

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

/** 2026-10-10（Wave 4 老闆指示）：保留期設定 + 人手清除舊日誌（admin only，後端 adminProcedure 把關） */
function RetentionCard() {
  const utils = trpc.useUtils();
  const stats = trpc.audit.stats.useQuery(undefined, { refetchOnWindowFocus: false });
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (stats.data && days === '') setDays(String(stats.data.retentionDays));
  }, [stats.data, days]);

  const setRetention = trpc.audit.setRetention.useMutation({
    onSuccess: (r) => {
      setMsg(`已保存：保留 ${r.retentionDays} 日`);
      void utils.audit.stats.invalidate();
    },
    onError: (e) => setMsg(`保存失敗：${e.message}`),
  });
  const purge = trpc.audit.purge.useMutation({
    onSuccess: (r) => {
      setMsg(`已清除 ${r.deleted} 條舊日誌（cutoff ${r.cutoff}）`);
      void utils.audit.list.invalidate();
      void utils.audit.stats.invalidate();
    },
    onError: (e) => setMsg(`清除失敗：${e.message}`),
  });

  const d = Number(days);
  const daysValid = Number.isInteger(d) && d >= 30 && d <= 3650;

  return (
    <div
      className="mt-4 rounded-xl border p-3.5 text-[13px]"
      style={{ borderColor: 'var(--space-line)', background: 'var(--glass-bg)' }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-txt-3">
        <span className="font-bold text-txt-1">日誌保留期</span>
        <span>
          總數 <span className="font-mono">{stats.data ? stats.data.total.toLocaleString() : '—'}</span> 條
        </span>
        <span>最舊 {stats.data?.oldest ? fmtTime(stats.data.oldest) : '—'}</span>
        <span>
          而家保留 <span className="font-mono text-gold">{stats.data?.retentionDays ?? '—'}</span> 日
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={30}
          max={3650}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="w-24 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-txt-1"
          style={{ borderColor: 'var(--space-line)' }}
          aria-label="保留日數"
        />
        <span className="text-txt-3">日（30–3650）</span>
        <button
          type="button"
          disabled={!daysValid || setRetention.isPending}
          onClick={() => {
            setMsg('');
            setRetention.mutate({ days: d });
          }}
          className="rounded-full border px-3.5 py-1.5 transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--pink)', color: 'var(--pink)' }}
        >
          {setRetention.isPending ? '保存中…' : '保存保留期'}
        </button>
        <button
          type="button"
          disabled={purge.isPending}
          onClick={() => {
            if (window.confirm('確定即刻清除舊過保留期嘅日誌？刪咗就攞唔返。')) {
              setMsg('');
              purge.mutate();
            }
          }}
          className="rounded-full border px-3.5 py-1.5 transition-colors disabled:opacity-40"
          style={{ borderColor: '#e06c7d', color: '#e06c7d' }}
        >
          {purge.isPending ? '清除中…' : '立即清除舊紀錄'}
        </button>
        {msg && <span className="text-txt-3">{msg}</span>}
      </div>
      <p className="mt-2 text-[12px] text-txt-3">
        系統開機同埋每 24 小時會自動清除超過保留期嘅日誌；呢度可以即時人手清一次。清除動作本身都會入日誌。
      </p>
    </div>
  );
}
