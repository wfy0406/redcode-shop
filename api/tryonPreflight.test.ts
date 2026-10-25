import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { inspectTryOnModelImage } from "./tryonPreflight";

const publicFile = (relative: string) => readFile(path.resolve(process.cwd(), "public", relative));

async function geometricNonHuman(): Promise<Buffer> {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="480" height="720">
      <rect width="480" height="720" fill="#d8d8d8"/>
      <rect x="35" y="50" width="410" height="180" fill="#7290a8"/>
      <rect x="70" y="270" width="150" height="330" fill="#a66f4f"/>
      <rect x="260" y="300" width="150" height="300" fill="#527a62"/>
      <path d="M0 720 L240 470 L480 720 Z" fill="#b7a67a"/>
    </svg>`);
  return sharp(svg).jpeg().toBuffer();
}

describe("TryOn 本地生成前相片檢查", () => {
  it("正面全身實人像：離線模型辨認到人像並放行", async () => {
    const result = await inspectTryOnModelImage(await publicFile("home/card-dress.jpg"));
    expect(result.faceCount).toBeGreaterThan(0);
    expect(result.meanLuma).toBeGreaterThan(28);
    expect(result.faceLuma).toBeGreaterThan(38);
  }, 20_000);

  it("一般正面實人像：唔會誤當非人像", async () => {
    const result = await inspectTryOnModelImage(await publicFile("about/host-2.jpg"));
    expect(result.faceCount).toBeGreaterThan(0);
  }, 20_000);

  it("光線充足但完全非人像：建立工作前拒絕", async () => {
    await expect(inspectTryOnModelImage(await geometricNonHuman())).rejects.toMatchObject({
      code: "NO_HUMAN_FACE",
    });
  }, 20_000);

  it("真實非人像背景素材：唔會因放寬門檻就誤當人臉", async () => {
    await expect(inspectTryOnModelImage(await publicFile("about-texture.jpg"))).rejects.toMatchObject({
      code: "NO_HUMAN_FACE",
    });
  }, 20_000);

  it("極暗相片：唔做人面生成、直接要求重拍", async () => {
    const dark = await sharp({
      create: { width: 480, height: 720, channels: 3, background: { r: 4, g: 4, b: 4 } },
    }).jpeg().toBuffer();
    await expect(inspectTryOnModelImage(dark)).rejects.toMatchObject({ code: "IMAGE_TOO_DARK" });
  }, 20_000);

  it("一般暗光實人像：仍然睇得清楚就放行，唔好反覆要求重拍", async () => {
    const dim = await sharp(await publicFile("home/card-dress.jpg"))
      .linear(0.24, 0)
      .jpeg({ quality: 90 })
      .toBuffer();
    const result = await inspectTryOnModelImage(dim);
    expect(result.faceCount).toBeGreaterThan(0);
    expect(result.meanLuma).toBeGreaterThan(18);
    expect(result.faceLuma).toBeGreaterThan(24);
  }, 20_000);

  it("輕微側斜實人像：備援角度辨認，唔係一睇唔到就即拒", async () => {
    const tilted = await sharp(await publicFile("home/card-dress.jpg"))
      .rotate(20, { background: "#777777" })
      .jpeg()
      .toBuffer();
    const result = await inspectTryOnModelImage(tilted);
    expect(result.faceCount).toBeGreaterThan(0);
  }, 20_000);

  it("真係極暗嘅實人像：放寬一般暗光後仍然要拒絕", async () => {
    const extremelyDark = await sharp(await publicFile("home/card-dress.jpg"))
      .linear(0.12, 0)
      .jpeg({ quality: 90 })
      .toBuffer();
    await expect(inspectTryOnModelImage(extremelyDark)).rejects.toMatchObject({
      code: "IMAGE_TOO_DARK",
    });
  }, 20_000);
});
