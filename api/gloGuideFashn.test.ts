import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { GloGuideImageGenInput } from "./gloGuideProviders";
import {
  generateGloGuideImage,
  resolveGloGuideModelImage,
  resolveGloGuideModelImageInput,
  resumeGloGuideImage,
} from "./gloGuideFashn";
import {
  GLO_GUIDE_MODEL_IMAGE_PREFIX,
  isGloGuideImagePath,
} from "./gloGuideValidation";

let uploadsDir: string;

beforeEach(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), "glo-guide-fashn-"));
});

afterEach(async () => {
  await rm(uploadsDir, { recursive: true, force: true });
});

const noSleep = async () => {};

function makeInput(overrides: Partial<GloGuideImageGenInput> = {}): GloGuideImageGenInput {
  return {
    articleId: 1,
    imageId: 2,
    productId: 3,
    category: "top",
    modelImage: "https://redcode.red/gloglo-3.jpg",
    productImage: "https://redcode.red/uploads/product-3.png",
    experimental: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function pngResponse(): Promise<Response> {
  const png = await sharp({
    create: { width: 48, height: 72, channels: 3, background: { r: 90, g: 60, b: 30 } },
  })
    .png()
    .toBuffer();
  return new Response(new Uint8Array(png), { status: 200 });
}

const OPTS = () => ({ sleep: noSleep, apiKey: "unit-fashn-key", uploadsDir, pollIntervalMs: 1 });

describe("gloGuideFashn（tryon-max＋poll＋轉存）", () => {
  it("成功流程：POST /v1/run（tryon-max）→ poll completed → 下載轉存站內 PNG", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/run")) return jsonResponse({ id: "pred-1" });
      if (u.includes("/v1/status/pred-1")) {
        return jsonResponse({ status: "completed", output: ["https://cdn.fashn.ai/out.png"] });
      }
      if (u === "https://cdn.fashn.ai/out.png") return pngResponse();
      throw new Error(`unexpected url ${u}`);
    });

    const result = await generateGloGuideImage(makeInput(), { ...OPTS(), fetchImpl });
    expect(result.providerJobId).toBe("pred-1");
    expect(isGloGuideImagePath(result.path)).toBe(true);
    expect(result.width).toBe(48);
    expect(result.height).toBe(72);
    // 短期 CDN URL 唔會出現喺結果
    expect(result.path).not.toContain("fashn.ai");

    // 提交 payload：tryon-max＋真實參考圖＋商品圖
    const [submitUrl, submitInit] = fetchImpl.mock.calls[0]!;
    expect(String(submitUrl)).toBe("https://api.fashn.ai/v1/run");
    const payload = JSON.parse(String(submitInit?.body));
    expect(payload.model_name).toBe("tryon-max");
    expect(payload.inputs.model_image).toBe("https://redcode.red/gloglo-3.jpg");
    expect(payload.inputs.product_image).toBe("https://redcode.red/uploads/product-3.png");
  });

  it("submit 成功後、第一次 poll 前即刻交出 providerJobId 俾上層持久化", async () => {
    const persisted: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v1/run")) return jsonResponse({ id: "pred-immediate" });
      if (u.includes("/v1/status/pred-immediate")) {
        return jsonResponse({ status: "completed", output: ["https://cdn.fashn.ai/immediate.png"] });
      }
      if (u === "https://cdn.fashn.ai/immediate.png") return pngResponse();
      throw new Error(`unexpected url ${u}`);
    });

    await generateGloGuideImage(
      makeInput({
        onProviderJobId: async (providerJobId) => {
          persisted.push(providerJobId);
          // 呢刻只應有 submit；如果已經開始 poll，重啟窗口就仍然存在。
          expect(fetchImpl).toHaveBeenCalledTimes(1);
          expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.fashn.ai/v1/run");
        },
      }),
      { ...OPTS(), fetchImpl },
    );
    expect(persisted).toEqual(["pred-immediate"]);
  });

  it("experimental（飾品／多品）行 /v1/agent/images/run", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v1/agent/images/run")) return jsonResponse({ id: "pred-2" });
      if (u.includes("/v1/status/pred-2")) {
        return jsonResponse({ status: "completed", output: ["https://cdn.fashn.ai/o.png"] });
      }
      return pngResponse();
    });
    const result = await generateGloGuideImage(
      makeInput({ category: "accessory", experimental: true }),
      { ...OPTS(), fetchImpl },
    );
    expect(result.providerJobId).toBe("pred-2");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.fashn.ai/v1/agent/images/run");
  });

  it("4xx（422）唔 retry：fetch 只打一次，throw FASHN_INPUT retryable=false", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad input" }, 422));
    await expect(generateGloGuideImage(makeInput(), { ...OPTS(), fetchImpl })).rejects.toMatchObject({
      code: "FASHN_INPUT",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("401 唔 retry：throw FASHN_AUTH", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    await expect(generateGloGuideImage(makeInput(), { ...OPTS(), fetchImpl })).rejects.toMatchObject({
      code: "FASHN_AUTH",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("network 錯：最多補試 2 次（共 3 次）有 backoff，之後誠實 throw", async () => {
    const sleepCalls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      generateGloGuideImage(makeInput(), {
        ...OPTS(),
        fetchImpl,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      }),
    ).rejects.toMatchObject({ code: "FASHN_NETWORK", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([500, 1000]);
  });

  it("5xx 第 2 次成功 → 繼續流程（retry 真係救得返）", async () => {
    let submitCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v1/run")) {
        submitCalls += 1;
        return submitCalls === 1 ? jsonResponse({}, 500) : jsonResponse({ id: "pred-3" });
      }
      if (u.includes("/v1/status/pred-3")) {
        return jsonResponse({ status: "completed", output: ["https://cdn.fashn.ai/o.png"] });
      }
      return pngResponse();
    });
    const result = await generateGloGuideImage(makeInput(), { ...OPTS(), fetchImpl });
    expect(result.providerJobId).toBe("pred-3");
    expect(submitCalls).toBe(2);
  });

  it("prediction failed 帶 OutOfCredits → throw FASHN_CREDITS，唔 retry", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v1/run")) return jsonResponse({ id: "pred-4" });
      return jsonResponse({
        status: "failed",
        error: { code: "OutOfCredits", message: "not enough credits" },
      });
    });
    await expect(generateGloGuideImage(makeInput(), { ...OPTS(), fetchImpl })).rejects.toMatchObject({
      code: "FASHN_CREDITS",
      retryable: false,
    });
  });

  it("completed 但輸出唔係 https URL → throw FASHN_BAD_OUTPUT，唔會當成功", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v1/run")) return jsonResponse({ id: "pred-5" });
      return jsonResponse({ status: "completed", output: ["http://insecure.example.com/x.png"] });
    });
    await expect(generateGloGuideImage(makeInput(), { ...OPTS(), fetchImpl })).rejects.toMatchObject({
      code: "FASHN_BAD_OUTPUT",
    });
  });

  it("resume：processing → null；completed → 轉存；failed → throw", async () => {
    const processingFetch = vi.fn(async () => jsonResponse({ status: "processing" }));
    await expect(
      resumeGloGuideImage("pred-6", makeInput(), { ...OPTS(), fetchImpl: processingFetch }),
    ).resolves.toBeNull();

    const completedFetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/v1/status/")) {
        return jsonResponse({ status: "completed", output: ["https://cdn.fashn.ai/r.png"] });
      }
      return pngResponse();
    });
    const done = await resumeGloGuideImage("pred-6", makeInput(), {
      ...OPTS(),
      fetchImpl: completedFetch,
    });
    expect(done?.providerJobId).toBe("pred-6");
    expect(done && isGloGuideImagePath(done.path)).toBe(true);

    const failedFetch = vi.fn(async () =>
      jsonResponse({ status: "failed", error: { code: "PredictionFailed", message: "boom" } }),
    );
    await expect(
      resumeGloGuideImage("pred-6", makeInput(), { ...OPTS(), fetchImpl: failedFetch }),
    ).rejects.toMatchObject({ code: "FASHN_FAILED" });
  });

  it("resume：4xx 查狀態唔 retry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    await expect(
      resumeGloGuideImage("pred-7", makeInput(), { ...OPTS(), fetchImpl }),
    ).rejects.toMatchObject({ code: "FASHN_INPUT", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("模特兒參考圖：/gloglo-3.jpg 及 env override 得；任意站內路徑／http 唔得", () => {
    expect(resolveGloGuideModelImage("/gloglo-3.jpg", { PUBLIC_BASE_URL: "https://redcode.red" })).toBe(
      "https://redcode.red/gloglo-3.jpg",
    );
    expect(
      resolveGloGuideModelImage("/models/a.jpg", {
        PUBLIC_BASE_URL: "https://redcode.red",
        GLO_GUIDE_MODEL_IMAGE_URLS: "/models/a.jpg,https://cdn.example.com/m.png",
      }),
    ).toBe("https://redcode.red/models/a.jpg");
    expect(() => resolveGloGuideModelImage("/uploads/random.png", {})).toThrowError(/已授權/);
    expect(() => resolveGloGuideModelImage("http://example.com/m.jpg", {})).toThrowError();
  });

  it("冇 FASHN_API_KEY → throw FASHN_CONFIG（唔會假成功）", async () => {
    await expect(
      generateGloGuideImage(makeInput(), { sleep: noSleep, apiKey: "", uploadsDir }),
    ).rejects.toMatchObject({ code: "FASHN_CONFIG" });
  });
});

describe("resolveGloGuideModelImageInput（後台模特兒原圖：私密 path → disk data URI）", () => {
  const UUID = "3f6b2a1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

  async function seedModelPng(): Promise<string> {
    const dir = path.join(uploadsDir, "glo-guide-models");
    await mkdir(dir, { recursive: true });
    const png = await sharp({
      create: { width: 20, height: 30, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, `${UUID}.png`), png);
    return png.toString("base64");
  }

  it("glo-guide-models path → 讀 disk 轉 data URI（唔會轉公開 URL）", async () => {
    const expectedB64 = await seedModelPng();
    const out = await resolveGloGuideModelImageInput(
      `${GLO_GUIDE_MODEL_IMAGE_PREFIX}${UUID}.png`,
      { UPLOADS_DIR: uploadsDir },
    );
    expect(out).toBe(`data:image/png;base64,${expectedB64}`);
    expect(out).not.toContain("http");
  });

  it("檔案唔存在 → 真錯誤 FASHN_MODEL_IMAGE（絕唔 mock）", async () => {
    await expect(
      resolveGloGuideModelImageInput(`${GLO_GUIDE_MODEL_IMAGE_PREFIX}${UUID}.png`, {
        UPLOADS_DIR: uploadsDir,
      }),
    ).rejects.toMatchObject({ code: "FASHN_MODEL_IMAGE" });
  });

  it("traversal／非 uuid 檔名／其他站內路徑 → 拒絕", async () => {
    await seedModelPng();
    await expect(
      resolveGloGuideModelImageInput(`/uploads/glo-guide-models/../glo-guide/x.png`, {
        UPLOADS_DIR: uploadsDir,
      }),
    ).rejects.toThrowError();
    await expect(
      resolveGloGuideModelImageInput(`/uploads/glo-guide-models/model.png`, {
        UPLOADS_DIR: uploadsDir,
      }),
    ).rejects.toThrowError();
    await expect(
      resolveGloGuideModelImageInput("/uploads/random.png", { UPLOADS_DIR: uploadsDir }),
    ).rejects.toThrowError(/已授權/);
  });

  it("其他輸入照舊行 sync 白名單（/gloglo-3.jpg → 絕對 URL；https 直用）", async () => {
    await expect(
      resolveGloGuideModelImageInput("/gloglo-3.jpg", { PUBLIC_BASE_URL: "https://redcode.red" }),
    ).resolves.toBe("https://redcode.red/gloglo-3.jpg");
    await expect(
      resolveGloGuideModelImageInput("https://cdn.example.com/m.png", {}),
    ).resolves.toBe("https://cdn.example.com/m.png");
  });

  it("完整生成流程：DB 私密原圖會以 data URI 做 model_image 交俾 Fashn", async () => {
    const expectedB64 = await seedModelPng();
    const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/run")) return jsonResponse({ id: "pred-model" });
      if (u.includes("/v1/status/pred-model")) {
        return jsonResponse({ status: "completed", output: ["https://cdn.fashn.ai/o.png"] });
      }
      return pngResponse();
    });
    const result = await generateGloGuideImage(
      makeInput({ modelImage: `${GLO_GUIDE_MODEL_IMAGE_PREFIX}${UUID}.png` }),
      { ...OPTS(), fetchImpl, env: { UPLOADS_DIR: uploadsDir } },
    );
    expect(result.providerJobId).toBe("pred-model");
    const submitInit = fetchImpl.mock.calls[0]![1];
    const payload = JSON.parse(String(submitInit?.body));
    expect(payload.inputs.model_image).toBe(`data:image/png;base64,${expectedB64}`);
  });
});
