import env from "@server/env";

/** Abort the proxy request if it has not responded within this window. */
const REQUEST_TIMEOUT_MS = 180_000;

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
    const content: unknown[] = [{ type: "text", text: params.userText }];
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
   * @returns an array of float vectors, one per input string.
   * @throws if the proxy returns a non-ok status, times out, or returns an unexpected count.
   */
  public async embeddings(inputs: string[], model: string): Promise<number[][]> {
    const json = (await this.post("/embeddings", { model, input: inputs })) as {
      data?: { embedding: number[] }[];
    };
    const vectors = (json.data ?? []).map((d) => d.embedding);
    if (vectors.length !== inputs.length) {
      throw new Error("LiteLLM embeddings returned an unexpected count");
    }
    return vectors;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
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
