/**
 * Glo Glo 指南——每篇專屬社交分享預覽圖。
 *
 * GET /og/glo-guide/:slug.png → 1200×630 PNG：已發布封面＋文章主題／標題／摘要。
 * 資料同首口 HTML 一樣只經 getPublishedGuideBySlug；非 published／唔存在一律 404，
 * 唔會因 crawler 攞預覽圖而公開草稿、待批或未審批圖片。
 */
import type { Context } from "hono";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GuideDetail } from "@contracts/gloGuide";
import { getPublishedGuideBySlug } from "./gloGuidePublic";
import { GLO_GUIDE_PATH_PREFIX, isGloGuideImagePath } from "./gloGuideValidation";

export const GLO_GUIDE_SOCIAL_IMAGE_WIDTH = 1200;
export const GLO_GUIDE_SOCIAL_IMAGE_HEIGHT = 630;
export const gloGuideSocialImagePath = (slug: string) => `/og/glo-guide/${slug}.png`;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** CJK 全形約佔一格、拉丁約半格；只係排版估算，避免長標題越界。 */
function displayUnits(value: string): number {
  return [...value].reduce((sum, ch) => sum + (/^[\x00-\xff]$/.test(ch) ? 0.55 : 1), 0);
}

function wrapText(value: string, maxUnits: number, maxLines: number): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const lines: string[] = [];
  let line = "";
  let units = 0;
  let truncated = false;
  for (const ch of [...normalized]) {
    const w = /^[\x00-\xff]$/.test(ch) ? 0.55 : 1;
    if (units + w > maxUnits && line) {
      if (lines.length === maxLines - 1) {
        truncated = true;
        break;
      }
      lines.push(line);
      line = ch;
      units = w;
    } else {
      line += ch;
      units += w;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (truncated || displayUnits(normalized) > displayUnits(lines.join(""))) {
    lines[lines.length - 1] = `${lines[lines.length - 1]?.replace(/[，。；、：\s]+$/u, "")}…`;
  }
  return lines;
}

function textLines(
  lines: readonly string[],
  x: number,
  y: number,
  lineHeight: number,
  className: string,
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" class="${className}">${esc(line)}</text>`,
    )
    .join("");
}

/** 純 SVG 排版：封面以外嘅文字／品牌版式可獨立測試及檢視。 */
export function buildGloGuideSocialSvg(
  detail: Pick<GuideDetail, "title" | "theme" | "excerpt">,
): string {
  const titleLines = wrapText(detail.title, 12.5, 5);
  const themeLines = wrapText(detail.theme, 28, 1);
  // 長標題優先完整呈現；四行或以上就唔再硬塞摘要，避免壓到頁尾。
  const excerptLines = titleLines.length <= 3 ? wrapText(detail.excerpt, 27, 2) : [];
  const titleSize = titleLines.length >= 4 ? 43 : 50;
  const titleLineHeight = titleLines.length >= 4 ? 56 : 64;
  const excerptY = 190 + titleLines.length * titleLineHeight + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GLO_GUIDE_SOCIAL_IMAGE_WIDTH}" height="${GLO_GUIDE_SOCIAL_IMAGE_HEIGHT}" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff8f1"/><stop offset="1" stop-color="#f3dfcf"/>
    </linearGradient>
    <linearGradient id="coverFallback" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#281c2d"/><stop offset="1" stop-color="#0f0c13"/>
    </linearGradient>
  </defs>
  <style>
    .sans { font-family: 'Noto Sans CJK TC', 'Noto Sans TC', 'PingFang HK', sans-serif; }
    .serif { font-family: 'Noto Serif CJK TC', 'Noto Serif TC', 'Songti TC', serif; }
    .kicker { font-family: 'Noto Sans CJK TC', sans-serif; font-size: 20px; font-weight: 600; letter-spacing: 3px; fill: #795a0a; }
    .theme { font-family: 'Noto Sans CJK TC', sans-serif; font-size: 23px; fill: #6f5b50; }
    .title { font-family: 'Noto Serif CJK TC', 'Noto Serif TC', serif; font-size: ${titleSize}px; font-weight: 700; fill: #151515; }
    .excerpt { font-family: 'Noto Sans CJK TC', sans-serif; font-size: 22px; fill: #5f514a; }
    .brand { font-family: 'Noto Sans CJK TC', sans-serif; font-size: 19px; font-weight: 600; letter-spacing: 2px; fill: #fef1e8; }
    .issue { font-family: 'Noto Sans CJK TC', sans-serif; font-size: 18px; letter-spacing: 2px; fill: #d9b56d; }
  </style>
  <rect width="1200" height="630" fill="url(#coverFallback)"/>
  <rect width="700" height="630" fill="url(#paper)"/>
  <rect x="0" y="0" width="12" height="630" fill="#d69900"/>
  <rect x="42" y="38" width="616" height="554" rx="2" fill="none" stroke="#d69900" stroke-opacity="0.55"/>
  <text x="72" y="91" class="kicker">GLO GLO · 精選指南</text>
  <line x1="72" y1="116" x2="628" y2="116" stroke="#d69900" stroke-width="2"/>
  ${textLines(themeLines, 72, 153, 30, "theme")}
  ${textLines(titleLines, 72, 224, titleLineHeight, "title")}
  ${textLines(excerptLines, 72, excerptY, 34, "excerpt")}
  <rect x="42" y="542" width="616" height="50" fill="#151515"/>
  <text x="72" y="575" class="brand">RedCode · Glo Glo 撰寫</text>
  <text x="1070" y="586" text-anchor="middle" class="issue">STYLE NOTES</text>
</svg>`;
}

/** SVG → PNG；有已批准封面先讀檔合成，冇封面都係該篇專屬文字卡，唔出通用 logo。 */
export async function renderGloGuideSocialImage(
  detail: GuideDetail,
  cover?: Buffer,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const svg = Buffer.from(buildGloGuideSocialSvg(detail), "utf8");
  if (!cover) return sharp(svg).png({ compressionLevel: 9 }).toBuffer();
  const resizedCover = await sharp(cover, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(500, 630, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();
  return sharp(svg)
    .composite([{ input: resizedCover, top: 0, left: 700 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function readPublishedCover(detail: GuideDetail): Promise<Buffer | undefined> {
  const cover = detail.coverImage;
  if (!cover) return undefined;
  if (!isGloGuideImagePath(cover.path)) throw new Error("Invalid public guide cover path");
  const file = path.basename(cover.path);
  const dir = path.resolve(process.env.UPLOADS_DIR || "uploads", "glo-guide");
  const absolute = path.resolve(dir, file);
  if (path.dirname(absolute) !== dir || cover.path !== `${GLO_GUIDE_PATH_PREFIX}${file}`) {
    throw new Error("Invalid public guide cover location");
  }
  return readFile(absolute);
}

/** published 狀態仍逐次查 DB；ETag 只令相同內容嘅 revalidation 唔使再讀封面及 Sharp 重畫。 */
function socialImageETag(detail: GuideDetail): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        slug: detail.slug,
        title: detail.title,
        theme: detail.theme,
        excerpt: detail.excerpt,
        publishedAt: detail.publishedAt,
        updatedAt: detail.updatedAt,
        cover: detail.coverImage
          ? { id: detail.coverImage.id, path: detail.coverImage.path }
          : null,
      }),
    )
    .digest("base64url");
  return `W/"glo-guide-${digest}"`;
}

interface SocialImageDependencies {
  loadDetail: (slug: string) => Promise<GuideDetail | null>;
  readCover: (detail: GuideDetail) => Promise<Buffer | undefined>;
}

function deny(c: Context, status: 404 | 503 = 404) {
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  return c.json({ error: status === 404 ? "Not Found" : "Preview temporarily unavailable" }, status);
}

/** 可注入依賴嘅 handler 工廠：測試唔需要掂真 DB／正式上載目錄。 */
export function createGloGuideSocialImageHandler(
  dependencies: SocialImageDependencies = {
    loadDetail: getPublishedGuideBySlug,
    readCover: readPublishedCover,
  },
) {
  return async (c: Context) => {
    const param = c.req.param("slug") ?? "";
    if (!/^[a-z0-9-]+\.png$/i.test(param)) return deny(c);
    const slug = param.slice(0, -4);
    let detail: GuideDetail | null;
    try {
      detail = await dependencies.loadDetail(slug);
    } catch (error) {
      console.error("[glo-guide-og] 公開文章查詢失敗:", error instanceof Error ? error.message : "unknown");
      return deny(c, 503);
    }
    if (!detail || detail.slug !== slug) return deny(c);
    const etag = socialImageETag(detail);
    const cacheHeaders = {
      ETag: etag,
      "Cache-Control": "no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    };
    const noneMatch = c.req.header("If-None-Match") ?? "";
    if (noneMatch.split(",").some((value) => value.trim() === etag || value.trim() === "*")) {
      return c.body(null, 304, cacheHeaders);
    }
    try {
      const cover = await dependencies.readCover(detail);
      const png = await renderGloGuideSocialImage(detail, cover);
      return c.body(new Uint8Array(png), 200, {
        ...cacheHeaders,
        "Content-Type": "image/png",
      });
    } catch (error) {
      console.error("[glo-guide-og] 社交預覽圖生成失敗:", error instanceof Error ? error.message : "unknown");
      return deny(c, 503);
    }
  };
}

export const gloGuideSocialImage = createGloGuideSocialImageHandler();
