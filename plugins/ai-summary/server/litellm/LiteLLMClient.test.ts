import LiteLLMClient from "./LiteLLMClient";

vi.mock("../env", () => ({
  default: {
    LITELLM_BASE_URL: "https://proxy.test/v1",
    LITELLM_API_KEY: "sk-test",
    LITELLM_SUMMARY_MODEL: "gpt-5-test",
  },
}));

describe("LiteLLMClient.summarize", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts the PDF as a file part and returns the parsed summary", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ title: "T", summaryMarkdown: "## Summary\nx" }),
            },
          },
        ],
      }),
    });

    const result = await LiteLLMClient.summarize({
      buffer: Buffer.from("%PDF-1.7 fake"),
      fileName: "paper.pdf",
    });

    expect(result).toEqual({ title: "T", summaryMarkdown: "## Summary\nx" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toEqual("https://proxy.test/v1/chat/completions");
    expect(init.headers.Authorization).toEqual("Bearer sk-test");
    const sent = JSON.parse(init.body);
    expect(sent.model).toEqual("gpt-5-test");
    expect(sent.response_format).toEqual({ type: "json_object" });
    const filePart = sent.messages[1].content.find((p: { type: string }) => p.type === "file");
    expect(filePart.file.filename).toEqual("paper.pdf");
    expect(filePart.file.file_data).toContain("data:application/pdf;base64,");
  });

  it("throws when the proxy returns a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(
      LiteLLMClient.summarize({ buffer: Buffer.from("x"), fileName: "a.pdf" })
    ).rejects.toThrow(/500/);
  });

  it("propagates a network error from fetch", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      LiteLLMClient.summarize({ buffer: Buffer.from("x"), fileName: "a.pdf" })
    ).rejects.toThrow(/fetch failed/);
  });
});
