/** System prompt enforcing the fixed five-section template for clinic summaries. */
export const summarizeSystemPrompt = `You are a research assistant for an Environmental Law and Policy Clinic.
You will receive the full content of an academic paper, report, or legal document as a PDF.
Produce a structured summary for a searchable internal wiki.

Respond with a SINGLE JSON object (no markdown code fences) with exactly these keys:
- "title": a concise, descriptive title for the wiki entry (use the document's own title if identifiable).
- "summaryMarkdown": a Markdown string containing EXACTLY these five second-level headings, in this order:

## Citation
A full bibliographic citation (authors, year, title, publication or court, and DOI/URL if present).

## Summary
2-4 plain-language paragraphs covering the document's purpose, argument, and conclusions.

## Key Findings
A bulleted list of the most important findings, holdings, or recommendations.

## Methodology
A short description of the methods, data, or legal reasoning used. Write "Not applicable" if none.

## Relevance to the clinic
2-4 sentences on relevance to environmental law and policy practice.

Do not include any text outside the JSON object.`;

/** The user-turn instruction accompanying the attached PDF. */
export const summarizeUserInstruction =
  "Summarize the attached document following the required structure.";

/**
 * Parse the model's JSON response into a title and the summary markdown.
 *
 * @param content the raw assistant message content.
 * @returns the parsed title (or null) and the summary markdown.
 * @throws if the content is empty or has no summaryMarkdown.
 */
export function parseSummaryResponse(content: string | undefined): {
  title: string | null;
  summaryMarkdown: string;
} {
  if (!content) {
    throw new Error("Empty response from LiteLLM");
  }

  let parsed: { title?: unknown; summaryMarkdown?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    const stripped = content
      .replace(/^\s*```(?:json)?/i, "")
      .replace(/```\s*$/, "")
      .trim();
    parsed = JSON.parse(stripped);
  }

  const summaryMarkdown =
    typeof parsed.summaryMarkdown === "string" ? parsed.summaryMarkdown.trim() : "";
  if (!summaryMarkdown) {
    throw new Error("LiteLLM response missing summaryMarkdown");
  }

  const title =
    typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : null;

  return { title, summaryMarkdown };
}
