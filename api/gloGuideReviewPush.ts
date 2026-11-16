/**
 * Glo Glo 精選文章——待審批 WMS 員工推播。
 *
 * 官網仍係文章 single source of truth；呢度只喺文章真係進入 pending_review 後，
 * 經現有 WMS_BASE_URL＋WMS_CALLBACK_SECRET 通知 WMS，由 WMS 推俾主管／管理員。
 * 推播失敗唔會推翻文章狀態，但會落官網 audit DB＋server log，唔准靜默或假成功。
 * notificationKey 由實際 job／submit transition 提供；call site 唔會喺重複 recovery 再推。
 */
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { gloGuideArticleProducts, gloGuideArticles } from "@db/schema";
import { logAudit } from "./audit";

const DEFAULT_WMS_BASE_URL = "https://red-code-wms.onrender.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GloGuideReviewPushInput {
  articleId: number;
  title: string;
  productCount: number;
  notificationKey: string;
}

export interface GloGuideReviewPushResult {
  ok: boolean;
  sent: number;
  failed: number;
  disabled: number;
  error?: string;
}

interface ReviewPushDeps {
  fetchImpl: typeof fetch;
  audit: typeof logAudit;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function defaultDeps(): ReviewPushDeps {
  const raw = Number.parseInt(process.env.GLO_GUIDE_REVIEW_PUSH_TIMEOUT_MS ?? "", 10);
  return {
    fetchImpl: fetch,
    audit: logAudit,
    env: process.env,
    timeoutMs: Number.isInteger(raw) && raw >= 1_000 && raw <= 30_000 ? raw : DEFAULT_TIMEOUT_MS,
  };
}

/** 同現有 wmsSync／webDesignPublicBill 共用 WMS_BASE_URL；env 只存 server-side。 */
export function gloGuideReviewPushUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.WMS_BASE_URL || DEFAULT_WMS_BASE_URL).replace(/\/+$/, "");
  return `${base}/api/glo-guide/review-push`;
}

function cleanError(raw: unknown, secret: string): string {
  let text = typeof raw === "string" ? raw.trim() : "";
  if (secret) text = text.split(secret).join("[redacted]");
  return text.slice(0, 300);
}

function replyCounts(value: unknown): { sent: number; failed: number; disabled: number } {
  const b = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const count = (key: string) => {
    const n = b[key];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  };
  return { sent: count("sent"), failed: count("failed"), disabled: count("disabled") };
}

/**
 * 送一次 WMS callback。呢個函數永遠回真結果，唔會 throw 去拖冧文章流程；
 * 成功同失敗都審計落 DB。request body 嘅 secret 唔會出現喺 audit／log。
 */
export async function postGloGuideReviewPush(
  input: GloGuideReviewPushInput,
  overrides: Partial<ReviewPushDeps> = {},
): Promise<GloGuideReviewPushResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const secret = (deps.env.WMS_CALLBACK_SECRET ?? "").trim();
  let result: GloGuideReviewPushResult;
  if (!secret) {
    result = { ok: false, sent: 0, failed: 0, disabled: 0, error: "官網未設定 WMS_CALLBACK_SECRET" };
  } else {
    try {
      const response = await deps.fetchImpl(gloGuideReviewPushUrl(deps.env), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, ...input }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      const body: unknown = await response.json().catch(() => null);
      const counts = replyCounts(body);
      const replyOk = Boolean(body && typeof body === "object" && (body as { ok?: unknown }).ok === true);
      if (!response.ok || !replyOk) {
        const rawError = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
        result = {
          ok: false,
          ...counts,
          error:
            cleanError(rawError, secret) ||
            `WMS 推播 callback 失敗（HTTP ${response.status}）`,
        };
      } else {
        result = { ok: true, ...counts };
      }
    } catch (e) {
      result = {
        ok: false,
        sent: 0,
        failed: 0,
        disabled: 0,
        error: cleanError(e instanceof Error ? e.message : String(e), secret) || "WMS 推播網絡失敗",
      };
    }
  }

  const detail = result.ok
    ? `待審批推播已送 WMS：成功 ${result.sent}、失敗 ${result.failed}、停用 ${result.disabled}`
    : `待審批推播失敗：${result.error ?? "未知原因"}`;
  await deps.audit({
    actorRole: "system",
    action: result.ok ? "gloGuide.reviewPushSent" : "gloGuide.reviewPushFailed",
    targetType: "gloGuideArticle",
    targetId: input.articleId,
    detail,
  });
  if (!result.ok) console.error(`[glo-guide] 文章 #${input.articleId} 待審批推播失敗：${result.error}`);
  return result;
}

/**
 * 實際 pending_review 閘＋最新標題／商品數先至推；文章被撤回／批准後嘅舊 callback 唔會再出通知。
 * 所有意外喺呢層收口，call site 可以安全 fire-and-forget。
 */
export async function notifyGloGuideReviewers(articleId: number, notificationKey: string): Promise<void> {
  try {
    const db = getDb();
    const article = await db.query.gloGuideArticles.findFirst({
      where: eq(gloGuideArticles.id, articleId),
      columns: { id: true, status: true, title: true },
    });
    if (!article || article.status !== "pending_review") return;
    const links = await db
      .select({ productId: gloGuideArticleProducts.productId })
      .from(gloGuideArticleProducts)
      .where(eq(gloGuideArticleProducts.articleId, articleId));
    await postGloGuideReviewPush({
      articleId,
      title: article.title,
      productCount: links.length,
      notificationKey,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[glo-guide] 文章 #${articleId} 待審批推播準備失敗：${message}`);
    await logAudit({
      actorRole: "system",
      action: "gloGuide.reviewPushFailed",
      targetType: "gloGuideArticle",
      targetId: articleId,
      detail: `待審批推播準備失敗：${message.slice(0, 300)}`,
    });
  }
}
