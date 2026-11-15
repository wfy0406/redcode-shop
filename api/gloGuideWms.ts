/**
 * Glo Glo 指南——WMS → 官網內部統一端點（POST /api/wms/glo-guide）。
 *
 * 合約（SPEC v1）：JSON { secret, actor:{id,name,role}, action, payload }
 * ─ secret=WMS_CALLBACK_SECRET，用 secretEquals（timingSafeEqual 常數時間比對）；
 * ─ actor id/name 合理長度、role 白名單（staff/supervisor/admin）；
 * ─ 三級員工：products.list／article.*／image.*；approve/reject 只 supervisor/admin；
 * ─ 成功 {ok:true,data}；失敗 {ok:false,error,code}＋正確 HTTP status；
 * ─ 每個 mutating action 喺 service 層 logAudit（actor、時間、target、結果）；
 * ─ 所有失敗真實 JSON error，唔准 mock 成功。
 *
 * 信任模型（L6，有意為之）：WMS_CALLBACK_SECRET 係 server-to-server 全信任通道——
 * actor 由 WMS server 砌（client/browser 永遠唔會攞到 secret），所以呢度信足 actor 嘅
 * id/name/role；secret 嘅強度（WMS 生成、環境變數、唔入 git）係唯一防線。
 */
import type { Context } from "hono";
import { secretEquals } from "./wmsSecret";
import {
  actionNeedsSupervisor,
  isGloGuideAction,
  parseGloGuideActor,
  type GloGuideAction,
  type GloGuideActor,
} from "./gloGuideValidation";
import * as service from "./gloGuideService";
import { GloGuideError } from "./gloGuideService";
import { defaultGloGuideProviders, type GloGuideProviders } from "./gloGuideProviders";
import { logAudit } from "./audit";

/** dispatch 依賴（測試可以 mock；production 用真 service） */
export interface GloGuideDispatchDeps {
  service: Pick<
    typeof service,
    | "listWeeklyProducts"
    | "listArticleSummaries"
    | "getArticleBundle"
    | "toInternalArticle"
    | "generateArticle"
    | "regenerateArticle"
    | "updateArticle"
    | "submitArticle"
    | "approveArticle"
    | "rejectArticle"
    | "archiveArticle"
    | "reviewImage"
    | "deleteImage"
    | "uploadImage"
    | "generateImages"
    | "readImageForPreview"
  >;
  providers: GloGuideProviders;
}

// ── payload 取值小工具（唔啱 → 即刻 throw GloGuideError 400，唔會放行走壞 payload）──
function bad(msg: string): never {
  throw new GloGuideError(400, "BAD_REQUEST", msg);
}

function reqId(payload: Record<string, unknown>, key = "id"): number {
  const v = payload[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) bad(`${key} 必填（正整數）`);
  return v as number;
}

function optIds(payload: Record<string, unknown>, key: string): number[] | undefined {
  const v = payload[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isSafeInteger(x))) {
    bad(`${key} 要係數字 array`);
  }
  return v as number[];
}

function optStr(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") bad(`${key} 要係字串`);
  return v;
}

/**
 * 純 dispatch（唔掂 Hono）：權限閘喺度做，方便測試直接驗權限矩陣。
 * 回 data（handler 包 {ok:true,data}）；失敗 throw GloGuideError。
 */
export async function dispatchGloGuideAction(
  actor: GloGuideActor,
  action: GloGuideAction,
  payload: Record<string, unknown>,
  deps: GloGuideDispatchDeps,
): Promise<unknown> {
  // approve／reject 只 supervisor/admin（API 層再擋，WMS UI 收埋都冇用）
  if (actionNeedsSupervisor(action) && actor.role !== "supervisor" && actor.role !== "admin") {
    throw new GloGuideError(403, "FORBIDDEN", "批准／拒絕指南需要主管或管理員權限");
  }
  const s = deps.service;
  switch (action) {
    case "products.list":
      return { items: await s.listWeeklyProducts() };
    case "article.list": {
      const status = optStr(payload, "status");
      const limitRaw = payload.limit;
      const limit =
        limitRaw === undefined
          ? undefined
          : typeof limitRaw === "number" && Number.isSafeInteger(limitRaw)
            ? limitRaw
            : (() => {
                throw bad("limit 要係整數");
              })();
      return { items: await s.listArticleSummaries({ status, limit }) };
    }
    case "article.get":
      return s.toInternalArticle(await s.getArticleBundle(reqId(payload)));
    case "article.generate":
      return s.generateArticle(actor, {
        productIds: optIds(payload, "productIds"),
        themeHint: optStr(payload, "themeHint"),
      });
    case "article.regenerate":
      return s.regenerateArticle(actor, {
        id: reqId(payload),
        themeHint: optStr(payload, "themeHint"),
      });
    case "article.update": {
      const title = payload.title;
      const body = payload.body;
      const theme = payload.theme;
      if (typeof title !== "string" || typeof body !== "string" || typeof theme !== "string") {
        bad("title／body／theme 必填（字串）");
      }
      return s.updateArticle(actor, {
        id: reqId(payload),
        title: title as string,
        body: body as string,
        theme: theme as string,
        productIds: optIds(payload, "productIds"),
      });
    }
    case "article.submit":
      return s.submitArticle(actor, reqId(payload));
    case "article.approve":
      return s.approveArticle(actor, reqId(payload));
    case "article.reject":
      return s.rejectArticle(actor, {
        id: reqId(payload),
        reason: typeof payload.reason === "string" ? payload.reason : "",
      });
    case "article.archive":
      return s.archiveArticle(actor, reqId(payload));
    case "image.generate":
      return s.generateImages(actor, {
        id: reqId(payload),
        imageId: payload.imageId === undefined ? undefined : reqId(payload, "imageId"),
        productId: payload.productId === undefined ? undefined : reqId(payload, "productId"),
      });
    case "image.upload":
      return s.uploadImage(
        actor,
        {
          id: reqId(payload),
          productId: reqId(payload, "productId"),
          filename: optStr(payload, "filename") ?? "",
          mime: optStr(payload, "mime") ?? "",
          dataBase64: typeof payload.dataBase64 === "string" ? payload.dataBase64 : "",
        },
        deps.providers,
      );
    case "image.delete":
      return s.deleteImage(actor, { id: reqId(payload), imageId: reqId(payload, "imageId") });
    case "image.review": {
      const decision = payload.decision;
      if (decision !== "approved" && decision !== "rejected") {
        bad("decision 只可以係 approved 或 rejected");
      }
      return s.reviewImage(actor, {
        id: reqId(payload),
        imageId: reqId(payload, "imageId"),
        decision,
        note: optStr(payload, "note"),
      });
    }
    case "image.read":
      return s.readImageForPreview(actor, { id: reqId(payload), imageId: reqId(payload, "imageId") });
    default:
      throw bad("未知 action");
  }
}

/** POST /api/wms/glo-guide handler（註冊喺 boot.ts tRPC mount 前） */
export async function wmsGloGuide(c: Context) {
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET", code: "NO_SECRET" }, 503);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON", code: "BAD_JSON" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!secretEquals(b.secret, secret)) {
    return c.json({ ok: false, error: "secret 唔啱", code: "BAD_SECRET" }, 401);
  }
  const actor = parseGloGuideActor(b.actor);
  if (!actor) {
    return c.json(
      { ok: false, error: "actor 無效（員工 id 要正整數；內建管理員 admin 可用 id=0；name 1–64 字；role 係 staff/supervisor/admin）", code: "BAD_ACTOR" },
      400,
    );
  }
  if (!isGloGuideAction(b.action)) {
    return c.json({ ok: false, error: "未知 action", code: "BAD_ACTION" }, 400);
  }
  const payload =
    b.payload && typeof b.payload === "object" && !Array.isArray(b.payload)
      ? (b.payload as Record<string, unknown>)
      : {};
  try {
    const data = await dispatchGloGuideAction(actor, b.action, payload, {
      service,
      providers: defaultGloGuideProviders(),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    if (e instanceof GloGuideError) {
      // 業務錯誤都留 audit（結果＋錯誤；secret 永遠唔落）
      void logAudit({
        actorId: actor.id,
        actorRole: actor.role,
        actorNameFallback: `${actor.name}（WMS）`,
        action: `gloGuide.${b.action}`,
        targetType: "gloGuide",
        targetId: typeof payload.id === "number" ? payload.id : undefined,
        detail: `失敗：${e.message}`.slice(0, 500),
      });
      return c.json({ ok: false, error: e.message, code: e.code }, e.httpStatus as 400);
    }
    console.error(`[glo-guide] action ${b.action} 意外失敗:`, e);
    return c.json({ ok: false, error: "內部錯誤，請稍後再試", code: "INTERNAL" }, 500);
  }
}
