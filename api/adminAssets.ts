import type { Context, Next } from "hono";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { userFromAuthHeader } from "./auth";

/**
 * 網站資產管理（staff/admin）—— 畀非技術用戶喺後台直接上傳兩個 binary 資產，
 * 唔使掂 GitHub：
 *   1. empty-cart.png   → 購物車空狀態插圖（前台 /empty-cart.png 引用）
 *   2. ops-template.xlsx → 每日數據導出嘅 Excel 模板
 *
 * 檔案寫入 UPLOAD_DIR/system/（Render Persistent Disk，重新部署都唔會散）。
 * Runtime 優先讀 disk 上傳版；disk 冇先至 fallback repo/dist 自帶版。
 */

const UPLOAD_DIR = process.env.UPLOADS_DIR || "uploads";
const SYSTEM_DIR = path.join(UPLOAD_DIR, "system");

type AssetDef = {
  key: string;
  filename: string;
  label: string;
  extHint: string;
  maxBytes: number;
  extRe: RegExp;
  repoPaths: string[]; // fallback 狀態檢查用（相對 process.cwd()）
};

const SITE_ASSETS: AssetDef[] = [
  {
    key: "empty-cart",
    filename: "empty-cart.png",
    label: "購物車空狀態插圖",
    extHint: "PNG 圖片",
    maxBytes: 2 * 1024 * 1024,
    extRe: /\.png$/i,
    repoPaths: ["dist/public/empty-cart.png", "public/empty-cart.png"],
  },
  {
    key: "ops-template",
    filename: "ops-template.xlsx",
    label: "每日導出 Excel 模板",
    extHint: "Excel .xlsx",
    maxBytes: 5 * 1024 * 1024,
    extRe: /\.xlsx$/i,
    repoPaths: ["api/assets/ops-template.xlsx"],
  },
];

/** 每日導出模板候選路徑：disk 上傳版優先，repo 版 fallback（exportDaily.ts 用） */
export function opsTemplateCandidates(): string[] {
  return [
    path.join(SYSTEM_DIR, "ops-template.xlsx"),
    path.resolve(process.cwd(), "api/assets/ops-template.xlsx"),
  ];
}

async function requireStaff(c: Context) {
  const user = await userFromAuthHeader(c.req.header("authorization"));
  if (!user || (user.role !== "staff" && user.role !== "admin")) return null;
  return user;
}

/** GET /api/admin/site-assets —— 資產狀態列表（uploaded/repo/missing + size + mtime） */
export async function siteAssetsStatus(c: Context) {
  const user = await requireStaff(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const items = await Promise.all(
    SITE_ASSETS.map(async (a) => {
      const disk = await stat(path.join(SYSTEM_DIR, a.filename)).catch(() => null);
      if (disk?.isFile()) {
        return {
          key: a.key,
          label: a.label,
          status: "uploaded" as const,
          size: disk.size,
          updatedAt: disk.mtime.toISOString(),
        };
      }
      for (const rp of a.repoPaths) {
        const repo = await stat(path.resolve(process.cwd(), rp)).catch(() => null);
        if (repo?.isFile()) {
          return {
            key: a.key,
            label: a.label,
            status: "repo" as const,
            size: repo.size,
            updatedAt: repo.mtime.toISOString(),
          };
        }
      }
      return { key: a.key, label: a.label, status: "missing" as const, size: 0, updatedAt: null };
    }),
  );
  return c.json({ assets: items });
}

/** POST /api/admin/upload-asset?key=empty-cart|ops-template —— multipart「file」欄位上傳 */
export async function uploadSiteAsset(c: Context) {
  const user = await requireStaff(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const key = c.req.query("key") ?? "";
  const asset = SITE_ASSETS.find((a) => a.key === key);
  if (!asset) return c.json({ error: "Unknown asset key" }, 400);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Missing file field" }, 400);
  if (!asset.extRe.test(file.name)) {
    return c.json({ error: `檔案格式唔啱（需要 ${asset.extHint}）` }, 400);
  }
  if (file.size > asset.maxBytes) {
    return c.json({ error: `檔案太大（上限 ${Math.round(asset.maxBytes / 1024 / 1024)}MB）` }, 400);
  }
  await mkdir(SYSTEM_DIR, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(SYSTEM_DIR, asset.filename), buffer);
  return c.json({ ok: true, key: asset.key, size: buffer.length });
}

/** GET /empty-cart.png —— disk 有上傳版就 serve disk 版；冇就 next() 跌落 dist 靜態版 */
export async function serveEmptyCartOverride(c: Context, next: Next) {
  try {
    const data = await readFile(path.join(SYSTEM_DIR, "empty-cart.png"));
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    });
  } catch {
    return next();
  }
}
