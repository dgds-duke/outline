import env from "@server/env";
import LiteLLMClient from "./LiteLLMClient";

describe("LiteLLMClient", () => {
  const fetchMock = vi.fn();
  const original = { base: env.LITELLM_BASE_URL, key: env.LITELLM_API_KEY };
  beforeEach(() => {
    env.LITELLM_BASE_URL = "https://proxy.test/v1";
    env.LITELLM_API_KEY = "sk-test";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    env.LITELLM_BASE_URL = original.base;
    env.LITELLM_API_KEY = original.key;
    vi.unstubAllGlobals();
  });

  it("chat() posts a file part and returns content", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
    });
    const out = await LiteLLMClient.chat({
      model: "gpt-5",
      systemPrompt: "s",
      userText: "u",
      file: { filename: "a.pdf", dataUrl: "data:application/pdf;base64,Zm9v" },
      jsonObject: true,
    });
    expect(out).toEqual("hi");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toEqual("https://proxy.test/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(
      body.messages[1].content.find((p: { type: string }) => p.type === "file")
    ).toBeTruthy();
  });

  it("embeddings() returns one vector per input", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      }),
    });
    const out = await LiteLLMClient.embeddings(["a", "b"], "text-embedding-3-small");
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(fetchMock.mock.calls[0][0]).toEqual("https://proxy.test/v1/embeddings");
  });

  it("throws on non-ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(LiteLLMClient.embeddings(["a"], "m")).rejects.toThrow(/500/);
  });

  it("chat() works without a file part", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "answer" } }] }),
    });
    const out = await LiteLLMClient.chat({ model: "gpt-5", systemPrompt: "s", userText: "u" });
    expect(out).toEqual("answer");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(
      body.messages[1].content.some((p: { type: string }) => p.type === "file")
    ).toBe(false);
    expect(body.response_format).toBeUndefined();
  });

  it("propagates a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(LiteLLMClient.embeddings(["a"], "m")).rejects.toThrow(/fetch failed/);
  });
});
