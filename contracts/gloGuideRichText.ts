/**
 * Glo Glo 指南安全 inline markup（isomorphic：contracts 可供 API／React 共用）。
 *
 * 只支援 [b]、[gold]、[pink]、[tag] 及對應 closing tag；唔係 HTML sanitizer，
 * 任何 <script>、URL、event handler 都只會當普通文字並喺輸出端 escape。
 * body DB 欄位維持純字串，舊 AI／人手純文字唔使遷移。
 */

export const GLO_GUIDE_RICH_TAGS = ["b", "gold", "pink", "tag"] as const;
export type GloGuideRichTag = (typeof GLO_GUIDE_RICH_TAGS)[number];
export type GloGuideTextColor = "gold" | "pink";

export interface GloGuideRichSegment {
  text: string;
  bold: boolean;
  color: GloGuideTextColor | null;
  tag: boolean;
}

export interface GloGuideRichTextResult {
  segments: GloGuideRichSegment[];
  plainText: string;
  highlights: string[];
  error: string | null;
}

const TOKEN = /\[(b|gold|pink|tag)\]|\[\/(b|gold|pink|tag)\]/g;

function sameStyle(a: GloGuideRichSegment, b: GloGuideRichSegment): boolean {
  return a.bold === b.bold && a.color === b.color && a.tag === b.tag;
}

/** Parse 受控標記；未知／錯寫 tag 保留做普通文字，合法 tag 必須正確巢狀及唔跨段落。 */
export function parseGloGuideRichText(input: string): GloGuideRichTextResult {
  const body = String(input ?? "");
  const stack: GloGuideRichTag[] = [];
  const segments: GloGuideRichSegment[] = [];
  let cursor = 0;
  let error: string | null = null;

  const pushText = (text: string) => {
    if (!text) return;
    if (stack.length > 0 && /\n/.test(text) && !error) {
      error = "粗體／顏色／重點標籤唔可以跨段落，請逐段設定";
    }
    const segment: GloGuideRichSegment = {
      text,
      bold: stack.includes("b"),
      color: stack.includes("gold") ? "gold" : stack.includes("pink") ? "pink" : null,
      tag: stack.includes("tag"),
    };
    const previous = segments.at(-1);
    if (previous && sameStyle(previous, segment)) previous.text += text;
    else segments.push(segment);
  };

  for (const match of body.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    pushText(body.slice(cursor, index));
    cursor = index + match[0].length;
    const opening = match[1] as GloGuideRichTag | undefined;
    const closing = match[2] as GloGuideRichTag | undefined;
    if (opening) {
      stack.push(opening);
    } else if (closing) {
      const expected = stack.at(-1);
      if (expected !== closing) {
        if (!error) error = `重點標記結尾不對稱：[/${closing}]`;
      } else {
        stack.pop();
      }
    }
  }
  pushText(body.slice(cursor));
  if (stack.length > 0 && !error) error = `重點標記未閉合：[${stack.at(-1)}]`;

  const plainText = segments.map((s) => s.text).join("");
  const highlights = [
    ...new Set(
      segments
        .filter((s) => s.tag)
        .map((s) => s.text.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  return { segments, plainText, highlights, error };
}

/** SEO excerpt／字數／JSON-LD articleBody 統一用呢個純文字版本。 */
export function gloGuideRichTextPlain(body: string): string {
  return parseGloGuideRichText(body).plainText;
}

export function escapeGloGuideHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 單段 whitelist HTML；所有文字先 escape，標籤只由 parser 自己產生。 */
export function renderGloGuideInlineHtml(paragraph: string): string {
  const parsed = parseGloGuideRichText(paragraph);
  if (parsed.error) return escapeGloGuideHtml(paragraph);
  return parsed.segments
    .map((segment) => {
      let html = escapeGloGuideHtml(segment.text);
      if (segment.bold) html = `<strong>${html}</strong>`;
      if (segment.color) html = `<span class="gg-text-${segment.color}">${html}</span>`;
      if (segment.tag) html = `<mark class="gg-key-tag">${html}</mark>`;
      return html;
    })
    .join("");
}

/** 公開首口 HTML／RSS 共用：段落結構同 React 版一致。 */
export function renderGloGuideBodyHtml(body: string): string {
  return body
    .split(/\n{2,}|\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${renderGloGuideInlineHtml(paragraph)}</p>`)
    .join("");
}

export interface GloGuideWrappedSelection {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Editor toolbar 共用：只包住已選文字；冇選擇就原樣返回，唔會偷加 placeholder。 */
export function wrapGloGuideSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  tag: GloGuideRichTag,
): GloGuideWrappedSelection {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.min(value.length, Math.max(selectionStart, selectionEnd));
  if (start === end) return { value, selectionStart: start, selectionEnd: end };
  const selected = value.slice(start, end);
  if (/\n/.test(selected)) return { value, selectionStart: start, selectionEnd: end };
  const open = `[${tag}]`;
  const close = `[/${tag}]`;
  return {
    value: `${value.slice(0, start)}${open}${selected}${close}${value.slice(end)}`,
    selectionStart: start + open.length,
    selectionEnd: start + open.length + selected.length,
  };
}
