import LiteLLMClient from "@server/utils/LiteLLMClient";
import { buildDocument } from "@server/test/factories";
import env from "../env";
import { generateAnswer } from "./answer";

describe("generateAnswer", () => {
  it("returns null when no answer model is configured", async () => {
    const prev = env.LITELLM_ANSWER_MODEL;
    env.LITELLM_ANSWER_MODEL = undefined;
    const doc = await buildDocument();
    expect(await generateAnswer("q", [doc])).toBeNull();
    env.LITELLM_ANSWER_MODEL = prev;
  });

  it("returns null when there are no documents", async () => {
    const prev = env.LITELLM_ANSWER_MODEL;
    env.LITELLM_ANSWER_MODEL = "gpt-5";
    expect(await generateAnswer("q", [])).toBeNull();
    env.LITELLM_ANSWER_MODEL = prev;
  });

  it("builds a grounded prompt with sources and returns the answer", async () => {
    const prev = env.LITELLM_ANSWER_MODEL;
    env.LITELLM_ANSWER_MODEL = "gpt-5";
    const chat = vi.spyOn(LiteLLMClient, "chat").mockResolvedValue("Under the CWA ... [1]");
    const doc = await buildDocument({ title: "Wetlands" });
    const out = await generateAnswer("can a state regulate?", [doc]);
    expect(out).toEqual("Under the CWA ... [1]");
    const params = chat.mock.calls[0][0];
    expect(params.systemPrompt.toLowerCase()).toContain("only");   // grounded
    expect(params.userText).toContain("Wetlands");                 // source title included
    expect(params.userText).toContain("can a state regulate?");    // question included
    expect(params.model).toEqual("gpt-5");
    vi.restoreAllMocks();
    env.LITELLM_ANSWER_MODEL = prev;
  });
});
