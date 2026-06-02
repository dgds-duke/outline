import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import type Document from "@server/models/Document";
import env from "../env";
import { answerSystemPrompt } from "./prompt";

/**
 * Generate a grounded answer for a query from the top retrieved documents.
 *
 * @param query the user's search/question text.
 * @param documents the top-ranked documents to ground the answer in.
 * @returns the answer markdown, or null when no answer model is configured or there are no sources.
 */
export async function generateAnswer(
  query: string,
  documents: Document[]
): Promise<string | null> {
  const model = env.LITELLM_ANSWER_MODEL;
  if (!model || documents.length === 0) {
    return null;
  }
  const sources = documents
    .map((doc, i) => `[${i + 1}] ${doc.title}\n${DocumentHelper.toPlainText(doc).slice(0, 4000)}`)
    .join("\n\n");
  return LiteLLMClient.chat({
    model,
    systemPrompt: answerSystemPrompt,
    userText: `Question: ${query}\n\nSources:\n${sources}`,
  });
}
