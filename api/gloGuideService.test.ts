/**
 * Glo Glo service 規則測試（唔掂 DB）：
 * ─ published 圖片 mutation 規則：published 指南唔准刪圖／改圖審批／加圖／重生圖
 *   （會即時破壞公開文）；draft/pending_review/rejected 先郁得；
 * ─ pickAutoProducts：本週可選 0/1 件 → 唔生成，2 件 → 全取，≥3 → 隨機抽 3
 *   （可注入 seed RNG；唔再固定 newest）；
 * ─ source guard：service 真係喺 reviewImage/deleteImage/uploadImage/generateImages
 *   落 published 閘（防回歸）。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gloGuidePublishedMutationError, isArticleEditable } from "./gloGuideValidation";

// ── 模特兒原圖 service 測試用嘅 fake DB（記錄 update/insert 次序，唔掂真 DB）──
const h = vi.hoisted(() => {
  const state = {
    /** tx.select 喺 model image 函數入面讀嘅未刪行（精簡形狀） */
    liveRows: [] as { id: number; path: string; isDefault: boolean; createdAt: Date }[],
    /** db.select（listModelImages／resolveArticleModelImageRef）讀嘅行 */
    fullRows: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
    /** 設咗就令 tx.insert 拋呢個錯（模擬 DB 寫入失敗） */
    failInsert: null as Error | null,
  };
  // drizzle 鏈：where() 結果可直接 await（thenable），亦可再 .orderBy()
  function rowsChain(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return { orderBy: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
  }
  const tx = {
    select: () => ({ from: () => ({ where: () => rowsChain(state.liveRows) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(v);
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        if (state.failInsert) throw state.failInsert;
        state.inserts.push(v);
        return {
          returning: () =>
            Promise.resolve([
              {
                id: 99,
                publicId: "pub-99",
                isDefault: v.isDefault,
                path: v.path,
                width: v.width,
                height: v.height,
              },
            ]),
        };
      },
    }),
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    select: () => ({ from: () => ({ where: () => rowsChain(state.fullRows) }) }),
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./audit", () => ({ logAudit: vi.fn(async () => undefined) }));

import {
  deleteModelImage,
  listModelImages,
  pickAutoProducts,
  resolveArticleModelImageRef,
  setDefaultModelImage,
  uploadModelImage,
  GloGuideError,
  type WeeklyProductDto,
} from "./gloGuideService";

const MODEL_UUID = "3f6b2a1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";
const MODEL_PATH = `/uploads/glo-guide-models/${MODEL_UUID}.jpg`;
const ACTOR = { id: 7, name: "陳小明", role: "staff" as const };

function liveRow(id: number, isDefault: boolean, createdAt: string) {
  return { id, path: MODEL_PATH, isDefault, createdAt: new Date(createdAt) };
}
function fullRow(id: number, isDefault: boolean) {
  return {
    id,
    publicId: `pub-${id}`,
    path: MODEL_PATH,
    originalFilename: "model.jpg",
    width: 100,
    height: 200,
    isDefault,
    createdById: 7,
    createdByName: "陳小明",
    deletedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
  };
}
/** 1×1 png base64 */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fakeSave = vi.fn(async () => ({ path: MODEL_PATH, width: 100, height: 200 }));

beforeEach(() => {
  h.state.liveRows = [];
  h.state.fullRows = [];
  h.state.updates = [];
  h.state.inserts = [];
  h.state.failInsert = null;
  fakeSave.mockClear();
});

describe("published 圖片 mutation 規則", () => {
  it("published 不可編輯；draft/pending_review/rejected/archived 可以", () => {
    expect(isArticleEditable("published")).toBe(false);
    for (const s of ["draft", "pending_review", "rejected", "archived"]) {
      expect(isArticleEditable(s)).toBe(true);
    }
  });

  it("review/delete/add/regenerate 四類 mutation 對 published 一律擋（純閘）", () => {
    for (const action of ["改圖片審批", "刪圖", "加圖", "重生圖"]) {
      expect(gloGuidePublishedMutationError(action, "published")).toContain("已發布");
      expect(gloGuidePublishedMutationError(action, "draft")).toBeNull();
      expect(gloGuidePublishedMutationError(action, "pending_review")).toBeNull();
      expect(gloGuidePublishedMutationError(action, "rejected")).toBeNull();
    }
  });

  it("service 每個圖片 mutator（review/delete/upload/generate/regenerate）都落咗 published 閘（source guard）", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
    // M5：deleteImage／reviewImage 用 transaction 內 lockArticleForImageMutation（FOR UPDATE）擋 published
    for (const fn of ["deleteImage", "reviewImage"]) {
      const fnBody = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf(`export async function ${fn}`) + 1800);
      expect(fnBody).toContain("db.transaction");
      expect(fnBody).toContain("lockArticleForImageMutation");
    }
    // uploadImage／generateImages 都喺 transaction 內鎖文章再驗
    for (const fn of ["uploadImage", "generateImages"]) {
      const fnBody = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf(`export async function ${fn}`) + 2000);
      expect(fnBody).toContain("lockArticleForImageMutation");
    }
    // 共用鎖 helper：FOR UPDATE＋published 閘
    const helper = src.slice(src.indexOf("async function lockArticleForImageMutation"), src.indexOf("async function lockArticleForImageMutation") + 800);
    expect(helper).toContain("FOR UPDATE");
    expect(helper).toContain("gloGuidePublishedMutationError");
    // regenerateArticle 都擋 published
    const regen = src.slice(src.indexOf("export async function regenerateArticle"), src.indexOf("export async function regenerateArticle") + 900);
    expect(regen).toContain('"published"');
    expect(regen).toContain("唔可以直接重生");
  });

  it("H1/M4 source guard：generateImages 唔再寫文章 status；generateArticle 一個 transaction", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
    const gen = src.slice(src.indexOf("export async function generateImages"), src.indexOf("export async function readImageForPreview"));
    // H1：唔准再用 stale bundle.status 寫文章 status
    expect(gen).not.toContain("bundle.article.status");
    expect(gen).toContain("db.transaction");
    expect(gen).toContain("lockArticleForImageMutation");
    const genArticle = src.slice(src.indexOf("export async function generateArticle"), src.indexOf("export async function recordFailedScheduledSlot"));
    // M4：文章＋links＋job 同一個 transaction；23505＋constraint 判定
    expect(genArticle).toContain("db.transaction");
    expect(genArticle).toContain("isUniqueViolation");
    expect(genArticle).toContain("gloguidejobs_idempotency");
    expect(genArticle).toContain("gloguidearticles_slug");
  });
});

describe("article update／regenerate 同 approve 嘅行鎖", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");

  it("update 喺 transaction 內 FOR UPDATE 重讀 status＋generationStatus，生成中唔准編輯", () => {
    const fn = src.slice(src.indexOf("export async function updateArticle"), src.indexOf("export async function submitArticle"));
    expect(fn).toContain("db.transaction(async (tx)");
    expect(fn).toContain('SELECT id, status, "generationStatus" FROM "gloGuideArticles"');
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain('["queued", "processing"].includes(existing.generationStatus)');
    expect(fn.indexOf("FOR UPDATE")).toBeLessThan(fn.indexOf("if (existing.status"));
  });

  it("regenerate 唔靠 tx 外舊 bundle；鎖內擋 published／生成中，再用鎖定 row 嘅 publicId 建 job", () => {
    const fn = src.slice(src.indexOf("export async function regenerateArticle"), src.indexOf("export async function updateArticle"));
    expect(fn).toContain("db.transaction(async (tx)");
    expect(fn).toContain('SELECT id, status, "generationStatus", "publicId" FROM "gloGuideArticles"');
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain('["queued", "processing"].includes(row.generationStatus)');
    expect(fn).toContain("return row.publicId");
    expect(fn).toContain("regen:${publicId}");
    expect(fn).not.toContain("const bundle =");
  });
});

describe("article.archive 落架", () => {
  it("service source guard：transaction FOR UPDATE 重讀狀態、published→archived、audit", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function archiveArticle"));
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("archiveArticleError");
    expect(fn).toContain('"archived"');
    expect(fn).toContain("gloGuide.articleArchive");
  });
  it("archive 後即時停止公開：公開 DTO／media 閘／sitemap 都只認 published（source guard）", () => {
    const pub = readFileSync(path.join(__dirname, "gloGuidePublic.ts"), "utf8");
    // published 閘嘅 source of truth 喺 gloGuidePublic：bySlug／sitemap／list 三處都只查 published
    expect(pub.match(/status,\s*"published"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // SEO 首口（gloGuideSeo.ts）唔直接掂 DB——只食 gloGuidePublic 嘅 published-only 查詢結果
    const seo = readFileSync(path.join(__dirname, "gloGuideSeo.ts"), "utf8");
    expect(seo).not.toContain("gloGuideArticles");
    expect(seo).not.toMatch(/from\s+["']\.\/queries\/connection["']/);
    const media = readFileSync(path.join(__dirname, "gloGuidePublicMedia.ts"), "utf8");
    expect(media).toContain("evaluatePublicMediaAccess"); // 閘內 status!=="published" → 404
  });
});

describe("pickAutoProducts（自動揀貨：隨機抽 2–3 件）", () => {
  const mk = (id: number): WeeklyProductDto => ({
    id,
    name: `商品${id}`,
    image: `/uploads/p${id}.jpg`,
    price: 100,
    discountPrice: null,
    aiTags: [],
    liveDate: "20261118",
    liveSession: null,
    category: "top",
    stock: 1,
  });
  // deterministic seed RNG（同 selection 模組測試一樣嘅 mulberry32）
  const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  it("0／1 件 → 唔生成（最少 2 件）；2 件 → 全取；≥3 → 隨機抽 3（唔再固定 newest）", () => {
    expect(pickAutoProducts([])).toEqual([]);
    expect(pickAutoProducts([mk(1)])).toEqual([]);
    // 2 件池無論 seed 點都全取
    expect(pickAutoProducts([mk(1), mk(2)], mulberry32(1)).map((p) => p.id).sort()).toEqual([1, 2]);
    // 4 件池：抽 3 件、唔重複、全部屬原池；同 seed 可重現
    const pool = [mk(1), mk(2), mk(3), mk(4)];
    const a = pickAutoProducts(pool, mulberry32(42)).map((p) => p.id);
    expect(a).toEqual(pickAutoProducts(pool, mulberry32(42)).map((p) => p.id));
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
    for (const id of a) expect([1, 2, 3, 4]).toContain(id);
  });
});

// ──────────────────────────── 模特兒原圖管理（fake DB，記錄次序）────────────────────────────

describe("模特兒原圖 service（fake DB）", () => {
  it("resolveArticleModelImageRef：DB 有預設 → 用 DB path；冇相 → ENV／內建 fallback", async () => {
    h.state.fullRows = [fullRow(1, true)];
    const dbSnap = await resolveArticleModelImageRef();
    expect(dbSnap).toEqual({ ref: MODEL_PATH, source: "db", imageId: 1 });

    h.state.fullRows = [];
    delete process.env.GLO_GUIDE_MODEL_IMAGE_URLS;
    const envSnap = await resolveArticleModelImageRef();
    expect(envSnap).toEqual({ ref: "/gloglo-3.jpg", source: "env", imageId: null });
  });

  it("uploadModelImage：第一張自動做預設；之後上傳係備用", async () => {
    h.state.liveRows = [];
    await uploadModelImage(ACTOR, { filename: "a.jpg", mime: "image/jpeg", dataBase64: TINY_PNG_B64 }, fakeSave);
    expect(h.state.inserts[0]).toMatchObject({ isDefault: true, path: MODEL_PATH, width: 100, height: 200 });

    h.state.inserts = [];
    h.state.liveRows = [liveRow(1, true, "2026-11-01")];
    await uploadModelImage(ACTOR, { filename: "b.jpg", mime: "image/jpeg", dataBase64: TINY_PNG_B64 }, fakeSave);
    expect(h.state.inserts[0]).toMatchObject({ isDefault: false });
  });

  it("uploadModelImage：已達 8 張 → 409 衝突，唔會再 insert", async () => {
    h.state.liveRows = Array.from({ length: 8 }, (_, i) => liveRow(i + 1, i === 0, "2026-11-01"));
    await expect(
      uploadModelImage(ACTOR, { filename: "a.jpg", mime: "image/jpeg", dataBase64: TINY_PNG_B64 }, fakeSave),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.state.inserts).toHaveLength(0);
  });

  it("uploadModelImage：base64 超 10MB → 400，saveImage 都唔會被調用", async () => {
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 8, 1).toString("base64");
    await expect(
      uploadModelImage(ACTOR, { filename: "a.jpg", mime: "image/jpeg", dataBase64: tooBig }, fakeSave),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(fakeSave).not.toHaveBeenCalled();
  });

  it("uploadModelImage：DB 寫入失敗 → 已落盤嘅真檔案被刪除（真 disk 驗證），錯誤照抛唔假成功", async () => {
    // 用真 saveGloGuideModelImage＋真 tmp UPLOADS_DIR；DB insert 模擬非 unique 故障
    const dir = await mkdtemp(path.join(tmpdir(), "gg-model-cleanup-"));
    const oldUploads = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = dir;
    h.state.failInsert = new Error("db connection lost");
    try {
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();
      await expect(
        uploadModelImage(ACTOR, {
          filename: "m.png",
          mime: "image/png",
          dataBase64: png.toString("base64"),
        }),
      ).rejects.toThrow("db connection lost");
      // 重點：檔案曾經真實落盤，DB 失敗後一定要被清走（唔留 orphan）
      const leftovers = await readdir(path.join(dir, "glo-guide-models")).catch(() => [] as string[]);
      expect(leftovers).toEqual([]);
    } finally {
      h.state.failInsert = null;
      if (oldUploads === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = oldUploads;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploadModelImage：sharp 驗證失敗 → 400 真錯誤（唔會假成功）", async () => {
    const badSave = vi.fn(async () => {
      throw new Error("圖片格式無效；只支援 JPEG／PNG／WebP");
    });
    await expect(
      uploadModelImage(ACTOR, { filename: "a.jpg", mime: "image/jpeg", dataBase64: TINY_PNG_B64 }, badSave),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.state.inserts).toHaveLength(0);
  });

  it("setDefaultModelImage：同一 tx 先清晒預設再標目標；唔存在 → 404", async () => {
    h.state.liveRows = [liveRow(1, true, "2026-11-01"), liveRow(2, false, "2026-11-02")];
    await setDefaultModelImage(ACTOR, { id: 2 });
    expect(h.state.updates).toHaveLength(2);
    expect(h.state.updates[0]).toMatchObject({ isDefault: false });
    expect(h.state.updates[1]).toMatchObject({ isDefault: true });

    h.state.updates = [];
    await expect(setDefaultModelImage(ACTOR, { id: 99 })).rejects.toMatchObject({ httpStatus: 404 });
    expect(h.state.updates).toHaveLength(0);
  });

  it("deleteModelImage：刪預設 → 同一 tx 先入 deletedAt 先至 promote 備用（次序攸關，唔會撞 partial unique）", async () => {
    h.state.liveRows = [
      liveRow(1, true, "2026-11-01"),
      liveRow(2, false, "2026-11-02"),
      liveRow(3, false, "2026-11-03"),
    ];
    await deleteModelImage(ACTOR, { id: 1 });
    expect(h.state.updates).toHaveLength(2);
    // 第一個 update 一定要係 soft-delete 舊預設（deletedAt＋清 isDefault）
    expect(h.state.updates[0]).toMatchObject({ isDefault: false });
    expect(h.state.updates[0]!.deletedAt).toBeInstanceOf(Date);
    // 第二個先係 promote 最早建立嘅備用（id 2）
    expect(h.state.updates[1]).toMatchObject({ isDefault: true });
    expect(h.state.updates[1]).not.toHaveProperty("deletedAt");
  });

  it("deleteModelImage：刪備用 → 只 soft-delete，唔郁預設；刪最後一張 → 唔 promote（list 會顯示 ENV fallback）", async () => {
    h.state.liveRows = [liveRow(1, true, "2026-11-01"), liveRow(2, false, "2026-11-02")];
    await deleteModelImage(ACTOR, { id: 2 });
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]!.deletedAt).toBeInstanceOf(Date);

    h.state.updates = [];
    h.state.liveRows = [liveRow(1, true, "2026-11-01")];
    await deleteModelImage(ACTOR, { id: 1 });
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]).toMatchObject({ isDefault: false });
    expect(h.state.updates[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("deleteModelImage：唔存在／已刪 → 404，咩都唔寫", async () => {
    h.state.liveRows = [liveRow(1, true, "2026-11-01")];
    await expect(deleteModelImage(ACTOR, { id: 99 })).rejects.toMatchObject({ httpStatus: 404 });
    expect(h.state.updates).toHaveLength(0);
  });

  it("listModelImages：附 fallback 同 effective；DB 有預設時 effective.source=db", async () => {
    h.state.fullRows = [fullRow(1, false), fullRow(2, true)];
    const out = await listModelImages();
    expect(out.maxCount).toBe(8);
    expect(out.items).toHaveLength(2);
    expect(out.effective).toEqual({ ref: MODEL_PATH, source: "db" });
    expect(out.fallback.ref).toBe("/gloglo-3.jpg");
  });
});

describe("模特兒原圖 source guard（快照／審計／私密邊界）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
  const section = src.slice(src.indexOf("模特兒原圖管理（官網 /admin 後台）"));

  it("generateArticle 用 resolveArticleModelImageRef 做快照（DB 預設優先，ENV 向後相容）", () => {
    const gen = src.slice(src.indexOf("export async function generateArticle"), src.indexOf("export async function recordFailedScheduledSlot"));
    expect(gen).toContain("resolveArticleModelImageRef");
    expect(gen).toContain("modelImage: modelSnap.ref");
    // 唔准再用齋 ENV 版本建文
    expect(gen).not.toContain("modelImage: gloGuideModelImage().ref");
  });

  it("共用 service 審計用真 actor.name——官網後台操作唔會再誤標「（WMS）」", () => {
    expect(section).toContain("actorNameFallback: actor.name");
    expect(src).not.toContain("（WMS）");
    for (const action of [
      "gloGuide.modelImageUpload",
      "gloGuide.modelImageSetDefault",
      "gloGuide.modelImageDelete",
      "gloGuide.modelImageRead",
    ]) {
      expect(section).toContain(action);
    }
  });

  it("刪相／換預設／上傳都唔會回寫舊文章（model image 段唔掂 gloGuideArticles 寫入）", () => {
    expect(section).not.toContain("update(gloGuideArticles)");
    expect(section).not.toContain("insert(gloGuideArticles)");
    // delete 係軟刪
    expect(section).toContain("deletedAt: new Date()");
    expect(section).not.toContain("delete(gloGuideModelImages)");
  });

  it("私密邊界：原圖唔入公開 DTO／SSR／RSS／JSON-LD（公開模組唔準掂 gloGuideModelImages）", () => {
    for (const f of ["gloGuidePublic.ts", "gloGuideDto.ts", "gloGuideSeo.ts", "gloGuideSyndication.ts"]) {
      const content = readFileSync(path.join(__dirname, f), "utf8");
      expect(content).not.toContain("gloGuideModelImages");
      expect(content).not.toContain("glo-guide-models");
    }
  });

  it("Fashn resolver 白名單：新前綴經 resolveGloGuideModelImageInput（disk→data URI）；orchestrator 原樣傳私密 path", () => {
    const fashn = readFileSync(path.join(__dirname, "gloGuideFashn.ts"), "utf8");
    expect(fashn).toContain("isGloGuideModelImagePath");
    expect(fashn).toContain("resolveGloGuideModelImageInput");
    const orch = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
    expect(orch).toContain("modelImageForProvider");
    expect(orch).toContain("isGloGuideModelImagePath");
  });

  it("GloGuideError 係真錯誤出口（model image 段唔准 mock 成功）", () => {
    expect(GloGuideError).toBeDefined();
    expect(section).not.toContain("mock");
  });
});
