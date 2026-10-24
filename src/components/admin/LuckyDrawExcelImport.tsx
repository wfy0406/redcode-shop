import { useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { trpc } from '@/providers/trpc';

/**
 * LuckyDrawExcelImport —— 名單／抽獎劵 Excel 匯入卡（v2.5.6）
 *
 * 流程（同 server 合約 adminImportExcel 一對一）：
 *   下載範本（adminDownloadTemplate 回 base64 → Blob 下載 .xlsx）
 *   → 揀檔（client 先擋 >2MB／非 .xlsx；FileReader 讀 base64）
 *   → 預覽（commit:false，server 零 DB 寫）：逐行姓名/劵數＋逐行錯誤＋重複報告
 *   → 確認匯入（commit:true）：有任何逐行錯誤就唔畀撳（server 亦會全數拒寫，雙保險）
 *
 * ticket 模式：重複處理 skip／merge 可揀（揀咗即重新預覽）；要傳 eventId（未歸檔活動）。
 * list 模式：commit＝開新名單（要名單名＋每人每日限中 N）。
 */

type ImportKind = 'list' | 'ticket';

type RowError = { row: number; field: string; message: string };
type ValidRow = { rowNo: number; name: string; normalizedName: string; ticketCount: number };
type DuplicateReport = { row: number; name: string; action: 'skip' | 'merge'; detail: string };
type ImportResult = {
  committed: boolean;
  rows: ValidRow[];
  errors: RowError[];
  duplicates: DuplicateReport[];
  summary: {
    kind: ImportKind;
    dataRows: number;
    validRows: number;
    inserts: number;
    merges: number;
    duplicates: number;
    errors: number;
    totalTickets: number;
  };
  listId?: number;
};

/** 同 LuckyDrawPanel 嘅 fmtErr 口径（zod raw JSON 拆第一條 message） */
function fmtErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('[{')) {
    try {
      const arr = JSON.parse(msg);
      if (Array.isArray(arr) && arr[0]?.message) return arr[0].message as string;
    } catch {
      /* fallthrough */
    }
  }
  return msg;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 同 server IMPORT_MAX_BYTES 一致

/** base64 → .xlsx 下載（Blob + a[download]） */
function downloadBase64Xlsx(filename: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function LuckyDrawExcelImport({
  kind,
  eventId,
  eventArchived,
  toast,
  onCommitted,
}: {
  kind: ImportKind;
  /** ticket 必填：匯入去邊個活動 */
  eventId?: number | null;
  /** ticket：活動已歸檔 → 全卡停用（server 都會 CONFLICT） */
  eventArchived?: boolean;
  toast: (msg: string, kind?: 'success' | 'error') => void;
  /** commit 成功回調（list 回 listId；ticket 回 summary） */
  onCommitted?: (result: ImportResult) => void;
}) {
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [duplicatePolicy, setDuplicatePolicy] = useState<'skip' | 'merge'>('skip');
  const [listName, setListName] = useState('');
  const [maxWins, setMaxWins] = useState('1');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const importMut = trpc.luckyDraw.adminImportExcel.useMutation();
  const busy = importMut.isPending || downloading;
  const disabled = busy || (kind === 'ticket' && (eventId == null || !!eventArchived));

  const resetFile = () => {
    setFileName(null);
    setFileBase64(null);
    setPreview(null);
    setLocalErr(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const downloadTemplate = async () => {
    setDownloading(true);
    setLocalErr(null);
    try {
      const r = await utils.luckyDraw.adminDownloadTemplate.fetch({ kind });
      downloadBase64Xlsx(r.filename, r.base64);
      toast(`已下載範本：${r.filename}`, 'success');
    } catch (e) {
      toast(fmtErr(e), 'error');
    } finally {
      setDownloading(false);
    }
  };

  const runPreview = async (b64: string, policy: 'skip' | 'merge') => {
    setLocalErr(null);
    try {
      const r = (await importMut.mutateAsync({
        kind,
        fileBase64: b64,
        commit: false,
        duplicatePolicy: policy,
        eventId: kind === 'ticket' ? (eventId ?? undefined) : undefined,
      })) as unknown as ImportResult;
      setPreview(r);
    } catch (e) {
      setPreview(null);
      setLocalErr(fmtErr(e));
    }
  };

  const onPickFile = (file: File) => {
    setLocalErr(null);
    setPreview(null);
    if (!/\.xlsx$/i.test(file.name)) {
      setLocalErr('只支援 .xlsx 檔案——請用系統範本');
      resetFile();
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setLocalErr(`檔案太大（上限 2MB；呢個 ${(file.size / 1024 / 1024).toFixed(2)}MB）`);
      resetFile();
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      setLocalErr('讀檔失敗，請再試一次');
      resetFile();
    };
    reader.onload = () => {
      const b64 = String(reader.result ?? '');
      setFileName(file.name);
      setFileBase64(b64);
      // list commit 預填名單名（去副檔名）
      if (kind === 'list' && !listName.trim()) setListName(file.name.replace(/\.xlsx$/i, '').slice(0, 64));
      void runPreview(b64, duplicatePolicy);
    };
    reader.readAsDataURL(file);
  };

  const changePolicy = (policy: 'skip' | 'merge') => {
    setDuplicatePolicy(policy);
    // 換政策即刻重新預覽（preview 零 DB 寫，安全）
    if (fileBase64) void runPreview(fileBase64, policy);
  };

  const commit = async () => {
    if (!fileBase64 || !preview) return;
    if (preview.errors.length > 0) return; // UI 雙保險（掣本身 disabled）
    if (kind === 'list' && !listName.trim()) {
      setLocalErr('名單名唔准空');
      return;
    }
    const mw = Math.floor(Number(maxWins));
    setLocalErr(null);
    try {
      const r = (await importMut.mutateAsync({
        kind,
        fileBase64,
        commit: true,
        duplicatePolicy,
        listName: kind === 'list' ? listName.trim() : '',
        maxWinsPerPerson: Number.isFinite(mw) ? Math.min(100, Math.max(1, mw)) : 1,
        eventId: kind === 'ticket' ? (eventId ?? undefined) : undefined,
      })) as unknown as ImportResult;
      if (!r.committed) {
        // server 防線：有錯全數唔寫——照實話俾管理員知
        setPreview(r);
        setLocalErr('server 拒絕咗匯入（有逐行錯誤，全部冇寫入）——睇下面逐行錯誤修正後再試');
        return;
      }
      toast(
        kind === 'list'
          ? `名單已匯入（新增 ${r.summary.inserts} 人${r.summary.duplicates ? `，去重 ${r.summary.duplicates}` : ''}）`
          : `劵已匯入（新增 ${r.summary.inserts} 人${r.summary.merges ? `、加劵 ${r.summary.merges} 人` : ''}，共 ${r.summary.totalTickets} 張）`,
        'success',
      );
      resetFile();
      onCommitted?.(r);
    } catch (e) {
      toast(fmtErr(e), 'error');
    }
  };

  const hasErrors = (preview?.errors.length ?? 0) > 0;
  const canCommit =
    !!preview && !hasErrors && preview.summary.inserts + preview.summary.merges > 0 && !busy;

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--space-line)', background: 'rgba(255,255,255,0.02)' }}>
      <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-txt-1">
        <FileSpreadsheet size={13} aria-hidden="true" className="text-gold" />
        Excel 匯入（{kind === 'list' ? '名單' : '抽獎劵'}）
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-txt-3">
        {kind === 'list'
          ? '範本欄位：姓名。匯入成功會開一份新名單。'
          : '範本欄位：姓名、抽獎劵數。匯入去而家揀咗嘅活動。'}
        上限：2MB／500 行數據。
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void downloadTemplate()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] text-gold-soft transition-colors hover:bg-white/5 disabled:opacity-40"
          style={{ borderColor: 'rgba(245,197,24,0.4)' }}
        >
          <Download size={12} aria-hidden="true" />
          {downloading ? '準備緊…' : '下載範本 .xlsx'}
        </button>
        <label
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
            disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer text-txt-1 hover:bg-white/5'
          }`}
          style={{ borderColor: 'var(--space-line)' }}
        >
          <Upload size={12} aria-hidden="true" />
          {importMut.isPending ? '上傳緊…' : fileName ? '換另一個檔' : '揀 .xlsx 上傳預覽'}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            disabled={disabled}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickFile(f);
              e.target.value = '';
            }}
          />
        </label>
        {fileName && (
          <span className="min-w-0 max-w-full truncate font-mono text-[11px] text-txt-3" title={fileName}>
            {fileName}
          </span>
        )}
      </div>
      {kind === 'ticket' && eventId == null && (
        <p className="mt-1.5 text-[11.5px] text-gold-soft">先喺上面揀一個活動先匯入得</p>
      )}
      {kind === 'ticket' && eventArchived && (
        <p className="mt-1.5 text-[11.5px] text-pink-soft">活動已歸檔，唔可以再匯入</p>
      )}

      {/* ticket：重複處理政策（換咗即重新預覽） */}
      {kind === 'ticket' && fileBase64 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-txt-2" role="group" aria-label="重複姓名處理">
          重複姓名：
          {(
            [
              ['skip', '略過（唔郁原有劵數）'],
              ['merge', '合併（劵數加埋）'],
            ] as const
          ).map(([p, label]) => (
            <label key={p} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name={`dup-${kind}`}
                checked={duplicatePolicy === p}
                onChange={() => changePolicy(p)}
                disabled={busy}
                className="accent-[#F5C518]"
              />
              {label}
            </label>
          ))}
        </div>
      )}

      {localErr && (
        <p role="alert" className="mt-2 rounded-lg border px-2.5 py-1.5 text-[12px] text-pink-soft" style={{ borderColor: 'rgba(255,0,84,0.4)' }}>
          {localErr}
        </p>
      )}

      {/* 預覽結果 */}
      {importMut.isPending && !preview && (
        <p className="mt-2 text-[12px] text-txt-3">預覽緊…（server 驗證中，未寫入任何嘢）</p>
      )}
      {preview && (
        <div className="mt-3 space-y-2">
          <p className="text-[12px] text-txt-1">
            預覽：數據 <b>{preview.summary.dataRows}</b> 行・有效 <b className="text-gold">{preview.summary.validRows}</b> 行
            {kind === 'ticket' && <>・將匯入 <b className="text-gold">{preview.summary.totalTickets}</b> 張劵</>}
            {preview.summary.merges > 0 && <>・合併加劵 {preview.summary.merges} 人</>}
            {preview.summary.duplicates > 0 && <>・重複 {preview.summary.duplicates} 行</>}
            {preview.summary.errors > 0 && (
              <>
                ・<b className="text-pink-soft">錯誤 {preview.summary.errors} 行</b>
              </>
            )}
          </p>

          {preview.errors.length > 0 && (
            <div className="rounded-lg border p-2" style={{ borderColor: 'rgba(255,0,84,0.4)' }}>
              <p className="text-[12px] font-bold text-pink-soft">逐行錯誤（修正晒先匯入得）：</p>
              <ul className="mt-1 max-h-[140px] space-y-0.5 overflow-y-auto pr-1">
                {preview.errors.map((er, i) => (
                  <li key={i} className="text-[11.5px] text-pink-soft">
                    第 {er.row} 行（{er.field}）：{er.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.duplicates.length > 0 && (
            <div className="rounded-lg border p-2" style={{ borderColor: 'rgba(245,197,24,0.35)' }}>
              <p className="text-[12px] font-bold text-gold-soft">重複姓名（{duplicatePolicy === 'skip' ? '已略過' : '已合併'}）：</p>
              <ul className="mt-1 max-h-[120px] space-y-0.5 overflow-y-auto pr-1">
                {preview.duplicates.map((d, i) => (
                  <li key={i} className="text-[11.5px] text-txt-2">
                    第 {d.row} 行「{d.name}」：{d.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--space-line)' }}>
              <table className="w-full text-left text-[11.5px]">
                <thead>
                  <tr className="text-txt-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <th className="px-2 py-1 font-normal">行</th>
                    <th className="px-2 py-1 font-normal">姓名</th>
                    {kind === 'ticket' && <th className="px-2 py-1 text-right font-normal">劵數</th>}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 50).map((r) => (
                    <tr key={r.rowNo} className="border-t text-txt-2" style={{ borderColor: 'var(--space-line)' }}>
                      <td className="px-2 py-1 font-mono text-txt-3">{r.rowNo}</td>
                      <td className="max-w-[160px] truncate px-2 py-1" title={r.name}>{r.name}</td>
                      {kind === 'ticket' && <td className="px-2 py-1 text-right font-mono">{r.ticketCount}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rows.length > 50 && (
                <p className="px-2 py-1 text-[11px] text-txt-3">名單太長，呢度淨顯示首 50 行；匯入係全數 {preview.summary.inserts} 人。</p>
              )}
            </div>
          )}

          {/* list commit 額外欄位 */}
          {kind === 'list' && (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <input
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                placeholder="新名單名（必填）"
                maxLength={64}
                className="rounded-lg border bg-transparent px-2.5 py-1.5 text-[12.5px] text-txt-1 outline-none focus:border-lavender"
                style={{ borderColor: 'var(--space-line)' }}
              />
              <label className="flex items-center gap-1.5 text-[12px] text-txt-2">
                每人每日限中
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxWins}
                  onChange={(e) => setMaxWins(e.target.value)}
                  className="w-16 rounded-lg border bg-transparent px-2 py-1 text-center font-mono text-[12.5px] text-txt-1 outline-none focus:border-lavender"
                  style={{ borderColor: 'var(--space-line)' }}
                />
                次
              </label>
            </div>
          )}
          {kind === 'list' && (
            <p className="text-[11px] leading-relaxed text-txt-3">
              限中口径：每個香港抽獎日全域計——同日喺任何名單中過都計入，夠 N 次就抽唔中。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void commit()}
              disabled={!canCommit || (kind === 'list' && !listName.trim())}
              className="rounded-lg px-4 py-1.5 text-[12.5px] font-bold disabled:opacity-40"
              style={{ background: '#F5C518', color: '#241505' }}
              title={hasErrors ? '有逐行錯誤，修正晒先匯入得' : undefined}
            >
              {importMut.isPending ? '匯入緊…' : hasErrors ? '有錯誤，唔匯入得' : '✓ 確認匯入'}
            </button>
            <button
              type="button"
              onClick={resetFile}
              disabled={busy}
              className="rounded-lg border px-3 py-1.5 text-[12px] text-txt-3 transition-colors hover:text-txt-1 disabled:opacity-40"
              style={{ borderColor: 'var(--space-line)' }}
            >
              清除
            </button>
            {hasErrors && (
              <span className="text-[11.5px] text-pink-soft">有逐行錯誤——全部唔會寫入，修正檔案後重新預覽</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
