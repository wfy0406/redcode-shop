import { describe, expect, it } from "vitest";
import { uploadedImagePathSchema } from "./uploadedImagePath";

describe("付款證明 imagePath 白名單", () => {
  it.each(["jpg", "png", "webp"])("接受 /api/upload 嘅 UUID .%s 相對路徑", (ext) => {
    const path = `/uploads/123e4567-e89b-42d3-a456-426614174000.${ext}`;
    expect(uploadedImagePathSchema.parse(path)).toBe(path);
  });

  it.each([
    "https://attacker.example/tracking.png",
    "//attacker.example/tracking.png",
    "/uploads/../../secret.png",
    "/uploads/123e4567-e89b-42d3-a456-426614174000.svg",
    "/uploads/123e4567-e89b-42d3-a456-426614174000.png?x=https://attacker.example",
    "data:image/png;base64,AAAA",
    "/other/123e4567-e89b-42d3-a456-426614174000.png",
  ])("拒絕外部、繞路或未驗證格式：%s", (path) => {
    expect(uploadedImagePathSchema.safeParse(path).success).toBe(false);
  });
});
