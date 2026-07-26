/** HKD 整數價錢：HK$xxx（千分位） */
export function fmtHKD(amount: number): string {
  return `HK$${Math.round(amount).toLocaleString('en-HK')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** DM Mono 用嘅等寬日期：YYYY/MM/DD HH:mm */
export function fmtDateTime(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 等待時長：「32h 15m」/「45m」 */
export function fmtWaiting(since: Date | string): { text: string; over24h: boolean } {
  const date = since instanceof Date ? since : new Date(since);
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms) || ms < 0) return { text: '0m', over24h: false };
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return { text: h > 0 ? `${h}h ${pad(m)}m` : `${m}m`, over24h: h >= 24 };
}

export function isToday(d: Date | string): boolean {
  const date = d instanceof Date ? d : new Date(d);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}
