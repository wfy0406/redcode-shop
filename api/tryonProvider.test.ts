import { describe, expect, it, vi } from "vitest";
import { FashnTryOnProvider, TryOnProviderError } from "./tryonProvider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INPUT = {
  modelImage: "data:image/jpeg;base64,bW9kZWw=",
  productImage: "https://example.com/product.png",
  productKind: "ring" as const,
};

describe("FASHN Try-On Max server adapter", () => {
  it("固定 tryon-max／quality／1k／一張 PNG，並以原圖局部修改及保留人物場景為優先", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse({ id: "job-123" }));
    const provider = new FashnTryOnProvider("unit-test-key", { fetchImpl });
    await expect(provider.submit(INPUT)).resolves.toEqual({ id: "job-123" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.fashn.ai/v1/run");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer unit-test-key" });
    const payload = JSON.parse(String(init?.body));
    expect(payload.model_name).toBe("tryon-max");
    expect(payload.inputs).toMatchObject({
      product_image: INPUT.productImage,
      model_image: INPUT.modelImage,
      generation_mode: "quality",
      resolution: "1k",
      num_images: 1,
      output_format: "png",
      return_base64: true,
      seed: 42,
    });
    expect(payload.inputs.prompt).toContain("on a suitable visible finger of the original person's hand");
    expect(payload.inputs.prompt).toContain("Edit model_image itself");
    expect(payload.inputs.prompt).toContain(
      "same person, face, hair, body shape, pose, framing, camera angle, lighting and original background",
    );
    expect(payload.inputs.prompt).toContain("preserving its design, color, pattern, material appearance, logos and details");
    expect(payload.inputs.prompt).toContain("Keep all other clothing, accessories and scene elements unchanged");
    expect(payload.inputs.prompt).not.toMatch(/\b(?:do not|never)\b/i);
  });

  it.each([
    ["top", "on the original person's upper body as the replacement upper-body garment"],
    ["pants", "on the original person's lower body as the replacement lower-body garment"],
    ["dress", "on the original person as the replacement dress"],
    ["shoes", "on the original person's feet as the replacement shoes"],
    ["ring", "on a suitable visible finger of the original person's hand"],
    ["necklace", "around the original person's neck, following the existing neckline"],
    ["earrings", "at the original person's natural ear positions"],
    ["bracelet", "around a suitable visible wrist of the original person"],
  ] as const)("%s 使用原人物嘅正確穿戴位置", async (productKind, placement) => {
    let prompt = "";
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      prompt = JSON.parse(String(init?.body)).inputs.prompt;
      return jsonResponse({ id: "job-123" });
    });
    const provider = new FashnTryOnProvider("unit-test-key", { fetchImpl });
    await provider.submit({ ...INPUT, productKind });
    expect(prompt).toContain(placement);
    expect(prompt).toContain("original background");
    expect(prompt).toContain("all other clothing, accessories and scene elements unchanged");
  });

  it.each(["starting", "in_queue", "processing"])("供應商狀態 %s 會繼續等待", async (status) => {
    const provider = new FashnTryOnProvider("unit-test-key", {
      fetchImpl: async () => jsonResponse({ status }),
    });
    await expect(provider.status("job-123")).resolves.toEqual({ state: "processing" });
  });

  it("completed 只接受私人 base64 圖像；公開輸出 URL 唔當成功", async () => {
    const completed = new FashnTryOnProvider("unit-test-key", {
      fetchImpl: async () => jsonResponse({ status: "completed", output: ["data:image/png;base64,aGVsbG8="] }),
    });
    await expect(completed.status("job-123")).resolves.toEqual({
      state: "completed", imageDataUri: "data:image/png;base64,aGVsbG8=",
    });

    const badOutput = new FashnTryOnProvider("unit-test-key", {
      fetchImpl: async () => jsonResponse({ status: "completed", output: ["https://example.com/result.png"] }),
    });
    const error = await badOutput.status("job-123").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TryOnProviderError);
    expect(error).toMatchObject({ code: "PROVIDER_BAD_OUTPUT", retryable: false });
  });

  it("供應商明確失敗會回 failed，由 service 釋放個人額度", async () => {
    const provider = new FashnTryOnProvider("unit-test-key", {
      fetchImpl: async () => jsonResponse({ status: "failed", error: { code: "CONTENT_POLICY" } }),
    });
    await expect(provider.status("job-123")).resolves.toMatchObject({
      state: "failed", code: "CONTENT_POLICY",
    });
  });

  it.each([
    [401, "PROVIDER_AUTH", false],
    [429, "PROVIDER_RATE_LIMIT", true],
    [500, "PROVIDER_HTTP_500", true],
    [422, "PROVIDER_INPUT", false],
  ])("HTTP %i 錯誤分類正確", async (httpStatus, code, retryable) => {
    const provider = new FashnTryOnProvider("unit-test-key", {
      fetchImpl: async () => jsonResponse({ error: "unit test" }, httpStatus),
    });
    const error = await provider.status("job-123").catch((value: unknown) => value);
    expect(error).toMatchObject({ code, retryable });
  });

  it("網絡失敗屬提交結果不確定，可交由 service 保留估算成本待核實", async () => {
    const provider = new FashnTryOnProvider("unit-test-key", {
      fetchImpl: async () => { throw new TypeError("offline"); },
    });
    const error = await provider.submit(INPUT).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "PROVIDER_NETWORK", retryable: true });
  });
});
