/**
 * 金額 / 檔案大小格式（配合 §2.3：價錢用 DM Mono 顯示）
 * HKD integer：`HK$1,234`
 */
export function formatHKD(value: number): string {
  return `HK$${Math.round(value).toLocaleString('en-US')}`;
}

/** 上傳檔案大小（DM Mono 用） */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
