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
  it("固定 tryon-max／quality／1k／一張 PNG，商品及人物 preservation prompt 不變", async () => {
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
    expect(payload.inputs.prompt).toContain("ring on a suitable finger");
    expect(payload.inputs.prompt).toContain("Preserve its design, color, pattern, material appearance");
    expect(payload.inputs.prompt).toContain("Preserve the model's identity, facial features, hair, body shape and pose");
  });

  it("耳環同手鏈使用各自 placement，唔係籠統 accessory", async () => {
    const prompts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      prompts.push(JSON.parse(String(init?.body)).inputs.prompt);
      return jsonResponse({ id: "job-123" });
    });
    const provider = new FashnTryOnProvider("unit-test-key", { fetchImpl });
    await provider.submit({ ...INPUT, productKind: "earrings" });
    await provider.submit({ ...INPUT, productKind: "bracelet" });
    expect(prompts[0]).toContain("earrings on the ears");
    expect(prompts[1]).toContain("bracelet or bangle on the wrist");
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
