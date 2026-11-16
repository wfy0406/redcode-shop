import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gloGuideReviewPushUrl,
  postGloGuideReviewPush,
  type GloGuideReviewPushInput,
} from "./gloGuideReviewPush";

const INPUT: GloGuideReviewPushInput = {
  articleId: 42,
  title: "返工穿搭",
  productCount: 3,
  notificationKey: "job:public-job-id",
};
const ENV = { WMS_CALLBACK_SECRET: "callback-secret", WMS_BASE_URL: "https://wms.example/" };
const audit = vi.fn(async (_entry: {
  actorId?: number | null;
  actorRole: string;
  actorNameFallback?: string;
  action: string;
  targetType?: string;
  targetId?: string | number;
  detail?: string;
}) => undefined);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  audit.mockClear();
});

describe("Glo Guide 待審批 WMS callback", () => {
  it("成功 POST 現有 WMS_BASE_URL＋server-only secret，並記真 delivery counts", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, sent: 2, failed: 1, disabled: 3 }),
    );
    const result = await postGloGuideReviewPush(INPUT, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit,
      env: ENV,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ ok: true, sent: 2, failed: 1, disabled: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://wms.example/api/glo-guide/review-push");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ secret: "callback-secret", ...INPUT });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "gloGuide.reviewPushSent",
      targetType: "gloGuideArticle",
      targetId: 42,
    }));
    const detail = String(audit.mock.calls[0]![0]?.detail ?? "");
    expect(detail).toContain("成功 2、失敗 1、停用 3");
    expect(detail).not.toContain("callback-secret");
  });

  it("HTTP 非 2xx 唔當成功，並落失敗審計", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: "bad callback" }, 401));
    const result = await postGloGuideReviewPush(INPUT, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit,
      env: ENV,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ ok: false, error: "bad callback" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "gloGuide.reviewPushFailed" }));
  });

  it("HTTP 200 但 ok:false 都係失敗，唔會假成功", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: "push disabled" }, 200));
    const result = await postGloGuideReviewPush(INPUT, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit,
      env: ENV,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ ok: false, error: "push disabled" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "gloGuide.reviewPushFailed" }));
  });

  it("網絡失敗回真錯誤；audit 同 console 均唔漏 secret", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => {
      throw new Error("request callback-secret failed");
    });
    const result = await postGloGuideReviewPush(INPUT, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit,
      env: ENV,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ ok: false, error: "request [redacted] failed" });
    const detail = String(audit.mock.calls[0]![0]?.detail ?? "");
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("callback-secret");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]![0])).not.toContain("callback-secret");
  });

  it("缺 WMS_CALLBACK_SECRET 唔發 request，亦唔假裝已推播", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const result = await postGloGuideReviewPush(INPUT, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      audit,
      env: {},
      timeoutMs: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("WMS_CALLBACK_SECRET");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "gloGuide.reviewPushFailed" }));
  });

  it("callback URL 會移除 base 尾斜線；無 env 先用現有 WMS 預設", () => {
    expect(gloGuideReviewPushUrl(ENV)).toBe("https://wms.example/api/glo-guide/review-push");
    expect(gloGuideReviewPushUrl({})).toBe("https://red-code-wms.onrender.com/api/glo-guide/review-push");
  });
});
