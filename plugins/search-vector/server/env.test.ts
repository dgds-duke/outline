import { validate } from "class-validator";
import { SearchVectorPluginEnvironment } from "./env";

/**
 * The semantic-search plugin is optional. Its env is loaded unconditionally at
 * server startup, so it must never fail validation (which would exit the whole
 * process) just because LiteLLM is not configured — it should degrade to
 * keyword search instead. This guards against re-introducing a required-by
 * constraint on the LiteLLM model fields.
 */
describe("SearchVectorPluginEnvironment", () => {
  const LITELLM_KEYS = [
    "LITELLM_BASE_URL",
    "LITELLM_API_KEY",
    "LITELLM_EMBEDDING_MODEL",
    "LITELLM_ANSWER_MODEL",
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(LITELLM_KEYS.map((key) => [key, process.env[key]]));
    // The base Environment constructor schedules a validation that calls
    // process.exit(1) on error; stub it so a regression fails as an assertion
    // rather than killing the test runner.
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const key of LITELLM_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.restoreAllMocks();
  });

  it("validates (boots) when LiteLLM is not configured", async () => {
    for (const key of LITELLM_KEYS) {
      delete process.env[key];
    }

    const env = new SearchVectorPluginEnvironment();
    const errors = await validate(env);

    // No validation error may reference the optional LiteLLM model fields.
    expect(errors.filter((error) => LITELLM_KEYS.includes(error.property))).toEqual(
      []
    );
    // The embedding model still resolves to its default, ready for when LiteLLM
    // is later configured.
    expect(env.LITELLM_EMBEDDING_MODEL).toEqual("text-embedding-3-small");
    // The feature reports itself disabled to the client.
    expect(env.AI_SEARCH_ENABLED).toEqual(false);
  });
});
