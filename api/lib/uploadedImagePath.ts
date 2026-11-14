import { z } from "zod";

/**
 * /api/upload 唯一成功輸出：/uploads/<randomUUID>.<jpg|png|webp>。
 * 付款證明只接受本站已驗圖及 re-encode 嘅相對路徑；外部 URL／其他路徑
 * 會令職員瀏覽器向第三方發請求，亦繞過上傳驗證，所以喺 tRPC 邊界拒絕。
 */
export const uploadedImagePathSchema = z
  .string()
  .trim()
  .max(512)
  .regex(
    /^\/uploads\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/,
    "付款證明路徑唔啱，請重新上傳圖片",
  );
