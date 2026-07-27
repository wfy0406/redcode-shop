// Build-time helper: restore public/ binary assets
// 1. assets-b64/*.b64（base64 文字檔，經 git 傳輸）→ decode 去 public/
// 2. assets-bin/*（二進制原檔，直接喺 GitHub 上傳）→ copy 去 public/
// 如果 public/ 已經有同名檔案（例如本地開發），會跳過唔覆寫。
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pubDir = path.join(root, 'public');
mkdirSync(pubDir, { recursive: true });

let restored = 0;
let skipped = 0;

const b64Dir = path.join(root, 'assets-b64');
if (existsSync(b64Dir)) {
  for (const file of readdirSync(b64Dir)) {
    if (!file.endsWith('.b64')) continue;
    const target = path.join(pubDir, file.slice(0, -4));
    if (existsSync(target)) { skipped++; continue; }
    const data = readFileSync(path.join(b64Dir, file), 'utf8');
    writeFileSync(target, Buffer.from(data.trim(), 'base64'));
    restored++;
  }
}

const binDir = path.join(root, 'assets-bin');
if (existsSync(binDir)) {
  for (const file of readdirSync(binDir)) {
    if (file.startsWith('.') || file.toLowerCase() === 'readme.md') continue;
    const target = path.join(pubDir, file);
    if (existsSync(target)) { skipped++; continue; }
    copyFileSync(path.join(binDir, file), target);
    restored++;
  }
}

// 3. api/assets/*.b64（大型 binary 經 base64 文字檔經 git 傳輸，例如營運數據 Excel 模板）
//    → decode 返同一目錄（strip .b64），已存在會跳過
const apiAssetsDir = path.join(root, 'api', 'assets');
if (existsSync(apiAssetsDir)) {
  for (const file of readdirSync(apiAssetsDir)) {
    if (!file.endsWith('.b64')) continue;
    const target = path.join(apiAssetsDir, file.slice(0, -4));
    if (existsSync(target)) { skipped++; continue; }
    const data = readFileSync(path.join(apiAssetsDir, file), 'utf8');
    writeFileSync(target, Buffer.from(data.trim(), 'base64'));
    restored++;
  }
}

console.log(`[decode-assets] restored ${restored} files, skipped ${skipped} existing`);
