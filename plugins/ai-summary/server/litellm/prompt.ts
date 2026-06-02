import { DocumentValidation } from "@shared/validations";

/**
 * System prompt: turn an attached paper PDF into a plain-language summary with a
 * two-line `Title:` / `DOI:` header (used to fill the draft's title) followed by
 * a Markdown body. Ported from the QuickSummary project so both tools produce
 * the same output.
 */
export const summarizeSystemPrompt = `You are summarizing a scientific or technical research paper for a smart, curious reader who is not a specialist in this field. Produce a clear, accessible summary that someone could understand without prior background knowledge.
Audience & tone

Write in plain language. Assume an educated non-expert.
The first time you use an unavoidable technical term or acronym, define it in plain words in parentheses, e.g. "TAN (total ammonia nitrogen — the combined ammonia in the water)".
Prefer short sentences and concrete phrasing over jargon. Explain why a finding matters, not just what it is.
Keep numbers when they carry the point (key results, magnitudes), but round and contextualize them.
Do not invent or infer data not present in the paper. If something important is unclear or missing, say so briefly rather than guessing.

Length

Aim for roughly 350–600 words total, scaled to the paper's complexity.

Output format — first print a two-line header (used to fill the Outline document's Title and DOI fields), then a blank line, then the summary. Use this exact structure, formatted as Markdown so it pastes cleanly into Outline:

Title: <a clear title for the Outline document, 100 characters or fewer — shorten the paper's full title if it is longer>
DOI: <the article's DOI, e.g. 10.1234/abcd — or the single word none if the paper has no DOI>

## Overview
A 2–4 sentence plain-language statement of what the paper set out to do and why it matters.

## Methods
A short bulleted list (3–5 bullets) describing how the study was done — what was measured, tested, or built, and under what conditions.

## Key findings
A bulleted list of the main results. Bold a short label at the start of each bullet, then explain in plain language. Include the numbers that matter.

## Takeaway
2–4 sentences on the practical significance, who should care, and the main caveat or limitation.

---

**Citation**
> Authors (Year). *Full title*. Publication, volume(issue), pages. DOI: <doi>
Formatting rules for Outline

Use ## for section headings (Outline renders these as H2).
Use - for bullets and **bold** for inline emphasis and bullet labels.
Put the citation last, after a horizontal rule (---), formatted as a blockquote (>).
In the citation, include all of: full title, complete author list (or "First Author et al." only if there are more than ~8 authors), year, full publication name with volume/issue/pages if available, and the DOI. If any element is genuinely absent from the paper, write "[not provided]" rather than omitting the field silently.
Output only the two-line header followed by the summary and citation — no other preamble, no "Here is your summary," no closing commentary.`;

/** The user-turn instruction accompanying the attached PDF. */
export const summarizeUserInstruction = "Summarize the attached research paper.";

export interface ParsedSummary {
  /** Draft title, shortened to Outline's title length limit. */
  title: string;
  /** Normalized DOI, or null when the paper has none. */
  doi: string | null;
  /** The Markdown summary body, from the first heading onward. */
  body: string;
}

/**
 * Parse the model's Markdown response into a draft title, DOI, and body.
 *
 * @param raw - the raw assistant message content.
 * @returns the shortened title, normalized DOI (or null), and Markdown body.
 */
export function parseSummary(raw: string): ParsedSummary {
  const title = shortenTitle(header(raw, "Title") ?? fallbackTitle(raw));
  const doi = normalizeDoi(header(raw, "DOI"));
  return { title, doi, body: body(raw) };
}

/**
 * Shorten a title to at most `max` characters, cutting at a word boundary and
 * appending an ellipsis when truncated.
 *
 * @param title - the title to shorten.
 * @param max - the maximum length; defaults to Outline's document title limit.
 * @returns the title, unchanged when short enough, otherwise truncated.
 */
export function shortenTitle(
  title: string,
  max: number = DocumentValidation.maxTitleLength
): string {
  if (title.length <= max) {
    return title;
  }
  const slice = title.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return base.trimEnd() + "…";
}

// Reads a labeled header line like "Title: ..." (line-anchored, so the
// citation's "> ... DOI:" is never matched). Returns null when absent.
function header(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : null;
}

// The body is everything from the first Markdown heading onward (header lines
// excluded). Outline stores the title separately and discourages a body that
// starts with an H1, so a leading H1 is demoted to H2.
function body(raw: string): string {
  const start = raw.search(/^#{1,6}\s/m);
  const out =
    start >= 0
      ? raw.slice(start).trim()
      : raw
          .split("\n")
          .filter((line) => !/^\s*(Title|DOI):/i.test(line))
          .join("\n")
          .trim();
  return out.replace(/^#\s+/, "## ");
}

// When the model omits the Title header, fall back to the first non-empty body
// line with Markdown decoration stripped.
function fallbackTitle(raw: string): string {
  const first =
    body(raw)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "Untitled paper";
  return first
    .replace(/^#{1,6}\s*/, "")
    .replace(/[*_`>]/g, "")
    .trim()
    .slice(0, 200);
}

// Normalize a DOI header value: drop a doi.org URL prefix / "doi:" prefix and
// any trailing junk; treat explicit "none"/"not provided" markers as null.
function normalizeDoi(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (/^(none|n\/a|not provided|\[not provided\])$/i.test(value)) {
    return null;
  }
  const doi = value
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .split(/[\s<>)\]]/)[0];
  return doi || null;
}
