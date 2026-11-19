import { describe, expect, it, vi } from "vitest";
import type { GloGuideTextInput } from "./gloGuideProviders";
import {
  detectUnsafeFacts,
  generateGloGuideText,
  gloGuideBodyLength,
  resolveGloGuideAiConfig,
} from "./gloGuideText";

const ENV = {
  GLO_GUIDE_AI_BASE_URL: "https://ai.example.com/v1",
  GLO_GUIDE_AI_API_KEY: "unit-test-key",
  GLO_GUIDE_AI_MODEL: "unit-model",
};

function makeInput(): GloGuideTextInput {
  return {
    products: [
      {
        name: "荷葉邊雪紡感上衣",
        category: "top",
        categoryLabel: "上衣",
        aiTags: ["顯瘦", "百搭"],
        price: 199,
        discountPrice: 159,
        liveDate: "2025-06-11",
        liveSession: "晚市",
      },
      {
        name: "高腰闊腳褲",
        category: "pants",
        categoryLabel: "褲",
        aiTags: ["修腿"],
        price: 259,
        discountPrice: null,
        liveDate: null,
        liveSession: null,
      },
    ],
    recentThemes: ["返工穿搭", "雨天造型"],
    recentIntros: ["最近天氣熱辣辣"],
    weatherLines: ["2025-06-11（星期三）：26–30°C，大致多雲"],
  };
}

/** 產生一個啱硬閘嘅輸出（body 400–800 code points，空白唔計，含兩個真副標題） */
function validOutput(overrides: Partial<{ title: string; body: string; theme: string }> = {}) {
  return {
    title: "夏日返工咁著最醒",
    body:
      "我哋 Glo Glo 今期用荷葉邊雪紡感上衣同高腰闊腳褲，示範[tag]返工至周末[/tag]三種襯法。" +
      "想直接參考，可以先由上衣嘅領口細節同褲款嘅高腰剪裁入手，再按返工、放假或晚飯場合轉換鞋款同外套。" +
      "\n\n[h2]荷葉邊雪紡感上衣返工點襯[/h2]\n" +
      "第一種係返工：將上衣攝入褲頭，加對樂福鞋；荷葉邊已經有細節，飾物保持簡潔，重點放喺領口同高腰剪裁。" +
      "如果想再整齊少少，可以将頭髮束起，令領位線條更清楚；袋款揀結構簡潔嘅手提或肩背款，避免太多裝飾搶走重點。" +
      "\n\n[h2]高腰闊腳褲放假配搭[/h2]\n" +
      "第二種係[tag]放假休閒[/tag]：上衣襯牛仔褲同波鞋，褲腳輕輕摺起；高腰闊腳褲亦可分開配淨色T恤，兩件單品唔一定要一套著。" +
      "周末去海濱或者咖啡店，可以用波鞋取代樂福鞋，再將外套隨身帶住；入到室內除低外套，上身重點仍然保留。" +
      "第三種適合晚飯聚會：上衣外面加淨色外套，披開時保留領口層次；褲款就配短款外套同平底鞋，由日頭返工轉成晚間造型。" +
      "聽日 26–30°C、大致多雲，外套揀易穿脫嘅款式，出入室內外都方便增減。" +
      "上衣而家 HK$159（原價 HK$199），曾喺 2025-06-11 晚市場次出現；想重溫可以睇相關場次，再入商品詳情睇兩件單品。", 
    theme: "夏日返工輕盈配搭",
    ...overrides,
  };
}

function chatJson(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function chatResponse(output: unknown, status = 200): Response {
  return chatJson(typeof output === "string" ? output : JSON.stringify(output), status);
}

const noSleep = async () => {};

describe("gloGuideText（OpenAI-compatible server-only）", () => {
  it("成功：呼叫 chat/completions、帶 Bearer、要求 JSON 輸出；回傳已驗證 title/body/theme", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => chatResponse(validOutput()));
    const result = await generateGloGuideText(makeInput(), {
      fetchImpl,
      env: ENV,
      sleep: noSleep,
    });

    expect(result.title).toBe("夏日返工咁著最醒");
    expect(result.theme).toBe("夏日返工輕盈配搭");
    const len = gloGuideBodyLength(result.body);
    expect(len).toBeGreaterThanOrEqual(400);
    expect(len).toBeLessThanOrEqual(800);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ai.example.com/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer unit-test-key" });
    const payload = JSON.parse(String(init?.body));
    expect(payload.model).toBe("unit-model");
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("prompt 含全部硬要求：廣東話、400–800 字、SEO／GEO、三種穿搭、真實導購、禁估資料", async () => {
    let system = "";
    let user = "";
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)).messages;
      system = messages[0].content;
      user = messages[1].content;
      return chatResponse(validOutput());
    });
    await generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep });

    expect(system).toContain("廣東話");
    expect(system).toContain("Glo Glo");
    expect(system).toContain("第一人稱");
    expect(system).toContain("400–800");
    expect(system).not.toContain("150–300");
    expect(system).toContain("SEO");
    expect(system).toContain("GEO");
    expect(system).toContain("最少寫 3 種");
    expect(system).toContain("真實價錢、直播日期及場次");
    expect(system).toContain("唔准虛構銷量、評價、庫存、折扣期限");
    expect(system).toContain("品牌同材質一律直接略過");
    expect(system).toContain("品牌不明");
    expect(system).toContain("材質未知");
    expect(system).toContain("商品名或標籤即使出現棉、雪紡、皮革等字眼");
    expect(system).toContain("唔可以當成材質證明");
    expect(system).toContain("emoji");
    expect(system).toContain("[tag]…[/tag]");
    expect(system).toContain("[h2]副標題[/h2]");
    expect(system).toContain("長尾搜尋句");
    expect(system).toContain("實際搜尋量、熱門程度或排名保證");
    expect(system).toContain("JSON");
    // user prompt：真實商品 facts（名／類別／標籤／價錢）
    expect(user).toContain("荷葉邊雪紡感上衣");
    expect(user).toContain("顯瘦");
    expect(user).toContain("HK$159");
    expect(user).toContain("原價 HK$199");
    expect(user).toContain("長尾字事實種子");
    expect(user).toContain("荷葉邊雪紡感上衣點襯");
    expect(user).toContain("唔代表搜尋量或排名");
    // 近 8 主題＋開頭＋天氣
    expect(user).toContain("返工穿搭");
    expect(user).toContain("最近天氣熱辣辣");
    expect(user).toContain("26–30°C");
  });

  it("body 字數以 Unicode code points 計、空白唔計", () => {
    // 10 個 CJK 字＋10 個空格 → 10 code points
    expect(gloGuideBodyLength("一二三四五六七八九十          ")).toBe(10);
    // emoji（surrogate pair）算 1 個 code point
    expect(gloGuideBodyLength("😊😊😊")).toBe(3);
    expect(gloGuideBodyLength("a b c")).toBe(3);
  });

  it("body 太短 → 有限重試（附失敗原因），全部唔合格最後 throw AI_VALIDATION", async () => {
    const short = validOutput({
      body: "[h2]荷葉邊雪紡感上衣點襯[/h2]\n[h2]放假配搭[/h2]\n太短[tag]重點[/tag]",
    });
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => chatResponse(short));
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ name: "GloGuideProviderError", code: "AI_VALIDATION" });
    // 預設 3 次嘗試
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 重試請求有附返上次失敗原因
    const lastPayload = JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body));
    const lastMessage = lastPayload.messages[lastPayload.messages.length - 1].content;
    expect(lastMessage).toContain("上次輸出唔合格");
    expect(lastMessage).toContain("內文要 400–800 字");
    expect(lastMessage).toContain("400–800 字，空白唔計");
  });

  it("自動稿冇重點標籤 → 唔會當成功，會要求改正", async () => {
    const withoutTags = validOutput({
      body: validOutput().body.replace(/\[\/?tag\]/g, ""),
    });
    const fetchImpl = vi.fn(async () => chatResponse(withoutTags));
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep, maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "AI_VALIDATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("長尾句冇商品全名＋穿搭意圖 → 唔當成功；冇副標題一樣會擋", async () => {
    const generic = validOutput({
      body: validOutput().body
        .replaceAll("荷葉邊雪紡感上衣", "呢件上衣")
        .replaceAll("高腰闊腳褲", "呢款褲"),
    });
    const noHeadings = validOutput({ body: validOutput().body.replaceAll("[h2]", "").replaceAll("[/h2]", "") });
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => chatResponse(generic))
      .mockImplementationOnce(async () => chatResponse(noHeadings));
    await expect(generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep, maxAttempts: 1 }))
      .rejects.toMatchObject({ code: "AI_VALIDATION", message: expect.stringContaining("長尾句") });
    await expect(generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep, maxAttempts: 1 }))
      .rejects.toMatchObject({ code: "AI_VALIDATION", message: expect.stringContaining("2–4 個") });
  });

  it("壞 JSON → 重試後仍壞 → throw AI_BAD_JSON，唔會照收", async () => {
    const fetchImpl = vi.fn(async () => chatJson("唔係JSON呀老闆"));
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "AI_BAD_JSON" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("壞 JSON → 第 2 次改正 → 成功（有限重試真係用到）", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? chatJson("```json\n{broken") : chatResponse(validOutput());
    });
    const result = await generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep });
    expect(result.title).toBe("夏日返工咁著最醒");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("無依據事實（估材質）→ AI_VALIDATION，用盡重試後 throw", async () => {
    const unsafe = validOutput({ body: `${validOutput().body}呢件純棉造㗎，意大利進口。` });
    const fetchImpl = vi.fn(async () => chatResponse(unsafe));
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "AI_VALIDATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("detectUnsafeFacts：完整商品名可保留；名稱或標籤字眼唔可以拆出嚟當材質證明", () => {
    const input = makeInput();
    // 商品名本身有「雪紡感」；完整點名唔等於材質斷言。
    expect(detectUnsafeFacts(validOutput(), input)).toEqual([]);

    const inferredFromName = validOutput({ body: `${validOutput().body}呢件係雪紡。` });
    expect(detectUnsafeFacts(inferredFromName, input)).toContain("雪紡");

    input.products[0]!.aiTags = ["純棉", "百搭"];
    const inferredFromTag = validOutput({ body: `${validOutput().body}呢件係純棉。` });
    expect(detectUnsafeFacts(inferredFromTag, input)).toContain("純棉");
  });

  it("品牌／材質未知旁白都唔准出街，會喺硬閘擋返", async () => {
    const input = makeInput();
    const commentary = validOutput({
      body: `${validOutput().body}品牌未知，材質未提供，以實物為準。`,
    });
    const violations = detectUnsafeFacts(commentary, input);
    expect(violations).toEqual(expect.arrayContaining(["品牌未知", "材質未提供", "以實物為準"]));

    const fetchImpl = vi.fn(async () => chatResponse(commentary));
    await expect(
      generateGloGuideText(input, { fetchImpl, env: ENV, sleep: noSleep, maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "AI_VALIDATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("控制字元會被剝走再 validate（NFC 清理）", async () => {
    const dirty = validOutput({ title: "夏日\u0007返工咁著最醒" });
    const fetchImpl = vi.fn(async () => chatResponse(dirty));
    const result = await generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep });
    expect(result.title).toBe("夏日返工咁著最醒");
    expect(result.title).not.toMatch(/[\u0000-\u001F]/);
  });

  it("env fallback：直接重用現有 DEEPSEEK_API_KEY／DEEPSEEK_BASE／DEEPSEEK_MODEL", async () => {
    const env = {
      DEEPSEEK_BASE: "https://api.deepseek.com/v1/",
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_MODEL: "deepseek-chat",
    };
    expect(resolveGloGuideAiConfig(env)).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "deepseek-key",
      model: "deepseek-chat",
    });
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => chatResponse(validOutput()));
    await generateGloGuideText(makeInput(), { fetchImpl, env, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer deepseek-key" }),
      }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe("deepseek-chat");
  });

  it("env 優先次序：指南專用設定 > DEEPSEEK_* > OPENAI_*", () => {
    const config = resolveGloGuideAiConfig({
      GLO_GUIDE_AI_BASE_URL: "https://guide.example.com/v1",
      GLO_GUIDE_AI_API_KEY: "guide-key",
      GLO_GUIDE_AI_MODEL: "guide-model",
      DEEPSEEK_BASE: "https://api.deepseek.com/v1",
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_MODEL: "deepseek-chat",
      OPENAI_BASE_URL: "https://api.openai.com/v1/",
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-x",
    });
    expect(config).toEqual({
      baseUrl: "https://guide.example.com/v1",
      apiKey: "guide-key",
      model: "guide-model",
    });
  });

  it("env fallback：冇指南專用及 DEEPSEEK_* 就用 OPENAI_*", () => {
    const config = resolveGloGuideAiConfig({
      OPENAI_BASE_URL: "https://api.openai.com/v1/",
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-x",
    });
    expect(config).toEqual({ baseUrl: "https://api.openai.com/v1", apiKey: "openai-key", model: "gpt-x" });
  });

  it("冇 API key → throw AI_CONFIG_MISSING（唔會靜默 mock）", async () => {
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl: vi.fn(), env: {}, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "AI_CONFIG_MISSING" });
  });

  it("401 授權失敗 → 即刻 throw AI_AUTH，唔 retry", async () => {
    const fetchImpl = vi.fn(async () => chatJson("{}", 401));
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "AI_AUTH" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("5xx → retryable，用盡後 throw AI_HTTP", async () => {
    const fetchImpl = vi.fn(async () => chatJson("{}", 500));
    await expect(
      generateGloGuideText(makeInput(), { fetchImpl, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ code: "AI_HTTP", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
