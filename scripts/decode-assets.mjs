// Build-time helper: restore public/ binary assets from assets-b64/*.b64
// （Git repo 只放 base64 文字檔；二進制圖片/影片喺 build 時還原）
// 如果 public/ 已經有同名檔案（例如本地開發），會跳過唔覆寫。
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const b64Dir = path.join(root, 'assets-b64');
const pubDir = path.join(root, 'public');

if (!existsSync(b64Dir)) {
  console.log('[decode-assets] no assets-b64 directory, nothing to do');
  process.exit(0);
}

mkdirSync(pubDir, { recursive: true });
let restored = 0;
let skipped = 0;
for (const file of readdirSync(b64Dir)) {
  if (!file.endsWith('.b64')) continue;
  const target = path.join(pubDir, file.slice(0, -4));
  if (existsSync(target)) {
    skipped++;
    continue;
  }
  const data = readFileSync(path.join(b64Dir, file), 'utf8');
  writeFileSync(target, Buffer.from(data.trim(), 'base64'));
  restored++;
}
console.log(`[decode-assets] restored ${restored} files, skipped ${skipped} existing`);
