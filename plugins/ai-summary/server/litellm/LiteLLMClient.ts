import env from "../env";
import {
  parseSummaryResponse,
  summarizeSystemPrompt,
  summarizeUserInstruction,
} from "./prompt";

type SummarizeParams = {
  /** Raw bytes of the source PDF. */
  buffer: Buffer;
  /** Original file name, used as the file part's filename. */
  fileName: string;
};

/**
 * Thin OpenAI-compatible client for Duke's LiteLLM proxy.
 *
 * Sends a PDF as a `file` content part to the chat-completions endpoint and
 * returns a structured summary. Designed to grow an `embeddings()` method for
 * the later semantic-search feature.
 */
class LiteLLMClient {
  /**
   * Summarize a PDF into a title and structured markdown.
   *
   * @param params the source buffer and file name.
   * @returns the parsed title (or null) and summary markdown.
   * @throws if the proxy is unreachable, returns a non-ok status, or returns an unparseable body.
   */
  public async summarize({ buffer, fileName }: SummarizeParams): Promise<{
    title: string | null;
    summaryMarkdown: string;
  }> {
    const dataUrl = `data:application/pdf;base64,${buffer.toString("base64")}`;

    const response = await fetch(`${env.LITELLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LITELLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LITELLM_SUMMARY_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: summarizeSystemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: summarizeUserInstruction },
              { type: "file", file: { filename: fileName, file_data: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LiteLLM request failed: ${response.status} ${detail}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseSummaryResponse(json.choices?.[0]?.message?.content);
  }
}

export default new LiteLLMClient();
