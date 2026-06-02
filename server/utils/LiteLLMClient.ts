import env from "@server/env";

/** Abort the proxy request if it has not responded within this window. */
const REQUEST_TIMEOUT_MS = 180_000;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } };

type ChatParams = {
  model: string;
  systemPrompt: string;
  userText: string;
  file?: { filename: string; dataUrl: string };
  jsonObject?: boolean;
};

/**
 * Thin OpenAI-compatible client for a LiteLLM proxy.
 *
 * Provides chat-completions and embeddings via the shared LITELLM_BASE_URL /
 * LITELLM_API_KEY environment variables.
 */
class LiteLLMClient {
  /**
   * Chat completion with an optional file/PDF content part; returns the raw assistant content.
   *
   * @param params model, prompts, optional file attachment, and response-format flag.
   * @returns the raw assistant message content string.
   * @throws if the proxy is unreachable, returns a non-ok status, or times out.
   */
  public async chat(params: ChatParams): Promise<string> {
    const content: ContentPart[] = [{ type: "text", text: params.userText }];
    if (params.file) {
      content.push({
        type: "file",
        file: { filename: params.file.filename, file_data: params.file.dataUrl },
      });
    }
    const json = (await this.post("/chat/completions", {
      model: params.model,
      ...(params.jsonObject ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content },
      ],
    })) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Embed one or more strings; returns one vector per input, in order.
   *
   * @param inputs the strings to embed.
   * @param model the embedding model identifier.
   * @param dimensions the required output dimension; sent to the proxy (the
   *   OpenAI `text-embedding-3-*` models support truncation) and validated
   *   against the response so a mismatch fails loudly instead of silently.
   * @returns an array of float vectors, one per input string.
   * @throws if the proxy returns a non-ok status, times out, returns an
   *   unexpected count, or returns vectors of the wrong dimension.
   */
  public async embeddings(
    inputs: string[],
    model: string,
    dimensions?: number
  ): Promise<number[][]> {
    const json = (await this.post("/embeddings", {
      model,
      input: inputs,
      ...(dimensions ? { dimensions } : {}),
    })) as {
      data?: { embedding: number[] }[];
    };
    const vectors = (json.data ?? []).map((d) => d.embedding);
    if (vectors.length !== inputs.length) {
      throw new Error("LiteLLM embeddings returned an unexpected count");
    }
    if (dimensions && vectors.some((vector) => vector.length !== dimensions)) {
      const got = vectors[0]?.length;
      throw new Error(
        `LiteLLM embedding model "${model}" returned ${got}-dimension vectors, ` +
          `but ${dimensions} are required. Use a model that supports ${dimensions} ` +
          `dimensions (e.g. a text-embedding-3-* model, which can be truncated).`
      );
    }
    return vectors;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    if (!env.LITELLM_BASE_URL || !env.LITELLM_API_KEY) {
      throw new Error("LITELLM_BASE_URL and LITELLM_API_KEY must be configured");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.LITELLM_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LITELLM_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`LiteLLM request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LiteLLM request failed: ${response.status} ${detail}`);
    }
    return response.json();
  }
}

export default new LiteLLMClient();
