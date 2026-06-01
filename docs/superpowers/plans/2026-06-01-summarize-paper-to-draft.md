# Summarize-a-Paper → AI Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-Outline "Summarize a paper (AI)" action that uploads a PDF, sends it to Duke's LiteLLM proxy (OpenAI-compatible, GPT-5.x vision) for a structured summary, and creates a draft in the uploader's *My Drafts* with the source PDF attached, notifying them when it's ready.

**Architecture:** A self-contained `plugins/ai-summary` plugin (server `Hook.API` + `Hook.Task`, client `Hook.Imports`) plus three minimal core edits (a new `AttachmentPreset`, a new `NotificationEventType`, and one core env var). Long-running summarization runs as a background Bull task; the draft is created via the existing `documentCreator` command; the "ready/failed" ping uses Outline's persisted `Notification` → websocket pipeline.

**Tech Stack:** TypeScript, Koa (koa-router), Sequelize, Bull/Redis queue, Zod validation, React + MobX (client), Vitest tests, OpenAI-compatible HTTP (global `fetch`).

**Spec:** `docs/superpowers/specs/2026-06-01-summarize-paper-to-draft-design.md`

---

## File Structure

**Create (plugin):**
- `plugins/ai-summary/plugin.json` — manifest (id/name/description/priority)
- `plugins/ai-summary/server/env.ts` — `LITELLM_*` env + derived `@Public AI_SUMMARY_ENABLED`
- `plugins/ai-summary/server/index.ts` — conditional `Hook.API` + `Hook.Task` registration
- `plugins/ai-summary/server/litellm/prompt.ts` — fixed 5-section template + response parser
- `plugins/ai-summary/server/litellm/prompt.test.ts`
- `plugins/ai-summary/server/litellm/LiteLLMClient.ts` — OpenAI-compatible client (PDF → summary)
- `plugins/ai-summary/server/litellm/LiteLLMClient.test.ts`
- `plugins/ai-summary/server/tasks/SummarizeDocumentTask.ts` — the worker
- `plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts`
- `plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.ts` — the notification creator
- `plugins/ai-summary/server/api/schema.ts` — Zod schema for the route
- `plugins/ai-summary/server/api/aiSummary.ts` — `POST /api/aiSummary.create`
- `plugins/ai-summary/server/api/aiSummary.test.ts`
- `plugins/ai-summary/client/index.tsx` — `Hook.Imports` registration (gated on `AI_SUMMARY_ENABLED`)
- `plugins/ai-summary/client/SummarizePaper.tsx` — the action Button + upload dialog

**Modify (core):**
- `shared/types.ts` — add `AttachmentPreset.AISummarySource`, `NotificationEventType.DraftSummarized` + default, extend `NotificationData`
- `server/env.ts` — add `AI_SUMMARY_MAX_FILE_SIZE`
- `server/models/helpers/AttachmentHelper.ts` — preset → size/acl cases
- `server/models/helpers/AttachmentHelper.test.ts` — test new preset (create if absent)
- `app/models/Notification.ts` — `path` + `eventText` cases for the new type

**Confirmed import paths (use verbatim):**
```typescript
import documentCreator from "@server/commands/documentCreator";
import { createContext } from "@server/context";
import { User, Attachment, Notification } from "@server/models";
import FileStorage from "@server/storage/files";
import { sequelize } from "@server/storage/database";
import { BaseTask, TaskPriority } from "@server/queues/tasks/base/BaseTask";
```

---

## Task 1: Core enum + env + AttachmentHelper for the source-PDF preset

**Files:**
- Modify: `shared/types.ts` (the `AttachmentPreset` enum)
- Modify: `server/env.ts` (add `AI_SUMMARY_MAX_FILE_SIZE`)
- Modify: `server/models/helpers/AttachmentHelper.ts` (`presetToMaxUploadSize`, `presetToAcl`)
- Test: `server/models/helpers/AttachmentHelper.test.ts` (create if it does not exist)

- [ ] **Step 1: Write the failing test**

Create or append to `server/models/helpers/AttachmentHelper.test.ts`:

```typescript
import { AttachmentPreset } from "@shared/types";
import env from "@server/env";
import { AttachmentHelper } from "./AttachmentHelper";

describe("AttachmentHelper – AISummarySource preset", () => {
  it("uses the AI summary max size", () => {
    expect(AttachmentHelper.presetToMaxUploadSize(AttachmentPreset.AISummarySource)).toEqual(
      env.AI_SUMMARY_MAX_FILE_SIZE
    );
  });

  it("is private", () => {
    expect(AttachmentHelper.presetToAcl(AttachmentPreset.AISummarySource)).toEqual("private");
  });

  it("never expires", () => {
    expect(AttachmentHelper.presetToExpiry(AttachmentPreset.AISummarySource)).toBeUndefined();
  });
});
```

> Note: if `AttachmentHelper` is a default export in this file, adjust the import to match the existing one used elsewhere in the repo (`grep "AttachmentHelper" server/models/helpers/AttachmentHelper.ts`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test server/models/helpers/AttachmentHelper.test.ts`
Expected: FAIL — `AttachmentPreset.AISummarySource` is `undefined` and `env.AI_SUMMARY_MAX_FILE_SIZE` does not exist.

- [ ] **Step 3a: Add the enum value**

In `shared/types.ts`, add to the `AttachmentPreset` enum (currently `DocumentAttachment`/`WorkspaceImport`/`Import`/`Avatar`/`Emoji`):

```typescript
export enum AttachmentPreset {
  DocumentAttachment = "documentAttachment",
  WorkspaceImport = "workspaceImport",
  Import = "import",
  Avatar = "avatar",
  Emoji = "emoji",
  AISummarySource = "aiSummarySource",
}
```

- [ ] **Step 3b: Add the core env var**

In `server/env.ts`, next to `FILE_STORAGE_IMPORT_MAX_SIZE`, add (mirrors that pattern; `26214400` = 25 MB):

```typescript
@IsNumber()
public AI_SUMMARY_MAX_FILE_SIZE =
  this.toOptionalNumber(environment.AI_SUMMARY_MAX_FILE_SIZE) ?? 26214400;
```

Ensure `IsNumber` is already imported in `server/env.ts` (it is — used by the existing size vars).

- [ ] **Step 3c: Add the AttachmentHelper cases**

In `server/models/helpers/AttachmentHelper.ts`:

`presetToMaxUploadSize` — add a case before the `Avatar`/`DocumentAttachment`/`default` group:

```typescript
case AttachmentPreset.AISummarySource:
  return env.AI_SUMMARY_MAX_FILE_SIZE;
```

`presetToAcl` — add a case before `default`:

```typescript
case AttachmentPreset.AISummarySource:
  return "private";
```

`presetToExpiry` — no change needed; `AISummarySource` falls through to `default: return undefined`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test server/models/helpers/AttachmentHelper.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts server/env.ts server/models/helpers/AttachmentHelper.ts server/models/helpers/AttachmentHelper.test.ts
git commit -m "feat(ai-summary): add AISummarySource attachment preset + AI_SUMMARY_MAX_FILE_SIZE"
```

---

## Task 2: Core notification type for "draft ready / failed"

**Files:**
- Modify: `shared/types.ts` (`NotificationEventType`, `NotificationEventDefaults`, `NotificationData`)
- Modify: `app/models/Notification.ts` (`path` getter + `eventText`)
- Test: `server/models/User.test.ts` (append a focused test) — verifies enum + defaults wiring

`Notification.event` is a plain `STRING` column (confirmed) — **no DB migration needed.**

- [ ] **Step 1: Write the failing test**

Append to `server/models/User.test.ts`:

```typescript
import { NotificationEventType } from "@shared/types";
import { buildUser } from "@server/test/factories";

describe("subscribedToEventType – DraftSummarized", () => {
  it("defaults to subscribed", async () => {
    const user = await buildUser();
    expect(user.subscribedToEventType(NotificationEventType.DraftSummarized)).toBe(true);
  });
});
```

> If `server/models/User.test.ts` already imports `buildUser`/`NotificationEventType`, don't duplicate the imports — add only the `describe` block.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test server/models/User.test.ts`
Expected: FAIL — `NotificationEventType.DraftSummarized` is `undefined`.

- [ ] **Step 3a: Add the enum value + default**

In `shared/types.ts`, add to `NotificationEventType` (after `RequestDocumentAccess`):

```typescript
DraftSummarized = "drafts.summarized",
```

Add to `NotificationEventDefaults`:

```typescript
[NotificationEventType.DraftSummarized]: true,
```

Extend `NotificationData`:

```typescript
export type NotificationData = {
  emoji?: string;
  status?: "completed" | "failed";
  fileName?: string;
};
```

- [ ] **Step 3b: Add the client routing + label**

In `app/models/Notification.ts`, in the `path` computed getter add a case before `default`:

```typescript
case NotificationEventType.DraftSummarized: {
  return this.document ? documentPath(this.document) : "";
}
```

In `eventText(t)` add a case before `default`:

```typescript
case NotificationEventType.DraftSummarized:
  return this.data?.status === "failed"
    ? t("could not be summarized")
    : t("summarized a draft from");
```

> `documentPath` is already imported in this file (used by other cases). Do not hand-edit locale JSON — the `t()` strings are auto-extracted.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test server/models/User.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts app/models/Notification.ts server/models/User.test.ts
git commit -m "feat(ai-summary): add DraftSummarized notification type + client routing"
```

---

## Task 3: Plugin scaffold (manifest + env)

**Files:**
- Create: `plugins/ai-summary/plugin.json`
- Create: `plugins/ai-summary/server/env.ts`
- Create: `plugins/ai-summary/server/index.ts`

This task is configuration/scaffolding (no behavioral logic yet), so it has a smoke check rather than a unit test.

- [ ] **Step 1: Create the manifest**

`plugins/ai-summary/plugin.json`:

```json
{
  "id": "ai-summary",
  "name": "AI Summary",
  "priority": 30,
  "description": "Summarize uploaded papers into structured drafts using an LLM."
}
```

- [ ] **Step 2: Create the plugin env**

`plugins/ai-summary/server/env.ts`:

```typescript
import { IsBoolean, IsOptional, IsUrl } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";

class AiSummaryPluginEnvironment extends Environment {
  /** Base URL of the OpenAI-compatible LiteLLM proxy, e.g. https://litellm.duke.edu/v1 */
  @IsOptional()
  @IsUrl({ require_tld: false })
  public LITELLM_BASE_URL = this.toOptionalString(environment.LITELLM_BASE_URL);

  /** Virtual API key for the proxy (secret; supports LITELLM_API_KEY_FILE). */
  @IsOptional()
  public LITELLM_API_KEY = this.toOptionalString(environment.LITELLM_API_KEY);

  /** A vision-capable chat model id on the proxy (e.g. a GPT-5.x model). */
  @IsOptional()
  public LITELLM_SUMMARY_MODEL = this.toOptionalString(
    environment.LITELLM_SUMMARY_MODEL
  );

  /** Whether the summarize-a-paper feature is fully configured (exposed to the client). */
  @Public
  @IsBoolean()
  public AI_SUMMARY_ENABLED = !!(
    this.LITELLM_BASE_URL &&
    this.LITELLM_API_KEY &&
    this.LITELLM_SUMMARY_MODEL
  );
}

export default new AiSummaryPluginEnvironment();
```

> Field-initialization order matters: `AI_SUMMARY_ENABLED` is declared last so the three `LITELLM_*` fields are already set when it is computed.

- [ ] **Step 3: Create a placeholder server entry**

`plugins/ai-summary/server/index.ts` (registers nothing yet; importing it registers the `@Public` env flag):

```typescript
import "./env";
```

- [ ] **Step 4: Verify type-check passes**

Run: `yarn tsc --noEmit`
Expected: PASS (no type errors from the new files).

- [ ] **Step 5: Commit**

```bash
git add plugins/ai-summary/plugin.json plugins/ai-summary/server/env.ts plugins/ai-summary/server/index.ts
git commit -m "feat(ai-summary): scaffold plugin manifest and env"
```

---

## Task 4: LiteLLM client + prompt

**Files:**
- Create: `plugins/ai-summary/server/litellm/prompt.ts`
- Test: `plugins/ai-summary/server/litellm/prompt.test.ts`
- Create: `plugins/ai-summary/server/litellm/LiteLLMClient.ts`
- Test: `plugins/ai-summary/server/litellm/LiteLLMClient.test.ts`

- [ ] **Step 1: Write the failing test for the response parser**

`plugins/ai-summary/server/litellm/prompt.test.ts`:

```typescript
import { parseSummaryResponse } from "./prompt";

describe("parseSummaryResponse", () => {
  it("parses a clean JSON object", () => {
    const out = parseSummaryResponse(
      JSON.stringify({ title: "A Paper", summaryMarkdown: "## Summary\nhi" })
    );
    expect(out.title).toEqual("A Paper");
    expect(out.summaryMarkdown).toContain("## Summary");
  });

  it("strips code fences before parsing", () => {
    const out = parseSummaryResponse(
      "```json\n" + JSON.stringify({ title: "X", summaryMarkdown: "body" }) + "\n```"
    );
    expect(out.title).toEqual("X");
    expect(out.summaryMarkdown).toEqual("body");
  });

  it("returns null title when missing", () => {
    const out = parseSummaryResponse(JSON.stringify({ summaryMarkdown: "body" }));
    expect(out.title).toBeNull();
    expect(out.summaryMarkdown).toEqual("body");
  });

  it("throws when summaryMarkdown is missing", () => {
    expect(() => parseSummaryResponse(JSON.stringify({ title: "X" }))).toThrow();
  });

  it("throws on empty content", () => {
    expect(() => parseSummaryResponse(undefined)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test plugins/ai-summary/server/litellm/prompt.test.ts`
Expected: FAIL — module not found / `parseSummaryResponse` undefined.

- [ ] **Step 3: Implement the prompt module**

`plugins/ai-summary/server/litellm/prompt.ts`:

```typescript
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
```

- [ ] **Step 4: Run the parser test to verify it passes**

Run: `yarn test plugins/ai-summary/server/litellm/prompt.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for the client**

`plugins/ai-summary/server/litellm/LiteLLMClient.test.ts`:

```typescript
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
});
```

- [ ] **Step 6: Run the client test to verify it fails**

Run: `yarn test plugins/ai-summary/server/litellm/LiteLLMClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the client**

`plugins/ai-summary/server/litellm/LiteLLMClient.ts`:

```typescript
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
```

> The PDF `file` content-part shape (`{ type: "file", file: { filename, file_data } }`) is OpenAI's documented format for chat-completions document input. **Verify it against Duke's actual proxy/model** before first real use; if the proxy expects the Responses API `input_file` shape instead, adjust only this file.

- [ ] **Step 8: Run the client test to verify it passes**

Run: `yarn test plugins/ai-summary/server/litellm/LiteLLMClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add plugins/ai-summary/server/litellm
git commit -m "feat(ai-summary): add LiteLLM client and summary prompt"
```

---

## Task 5: SummarizeDocumentTask (the worker)

**Files:**
- Create: `plugins/ai-summary/server/tasks/SummarizeDocumentTask.ts`
- Test: `plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts`
- Modify: `plugins/ai-summary/server/index.ts` (register the task)

Depends on Task 6's `DraftSummarizedNotificationsTask`, so this task references it; create a minimal version first if implementing strictly top-down, or implement Task 6 before Task 5. The plan implements them in 5→6 order with the notification task stubbed in Step 3 and completed in Task 6.

- [ ] **Step 1: Write the failing test**

`plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts`:

```typescript
import { Attachment, Document } from "@server/models";
import { buildUser, buildAttachment } from "@server/test/factories";
import SummarizeDocumentTask from "./SummarizeDocumentTask";

vi.mock("@server/storage/files", () => ({
  default: { getFileBuffer: vi.fn(async () => Buffer.from("%PDF fake")) },
}));

vi.mock("../litellm/LiteLLMClient", () => ({
  default: {
    summarize: vi.fn(async () => ({
      title: "Wetlands Report",
      summaryMarkdown: "## Summary\nfindings",
    })),
  },
}));

describe("SummarizeDocumentTask", () => {
  it("creates a draft in My Drafts and links the source attachment", async () => {
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
    });

    await new SummarizeDocumentTask().perform({
      attachmentId: attachment.id,
      userId: user.id,
      ip: "127.0.0.1",
    });

    const document = await Document.findOne({
      where: { createdById: user.id },
      order: [["createdAt", "DESC"]],
    });
    expect(document).toBeTruthy();
    expect(document!.publishedAt).toBeNull();
    expect(document!.collectionId).toBeNull();
    expect(document!.title).toEqual("Wetlands Report");
    expect(document!.text).toContain("attachments.redirect");
    expect(document!.text).toContain("## Summary");

    const reloaded = await Attachment.findByPk(attachment.id);
    expect(reloaded!.documentId).toEqual(document!.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the task**

`plugins/ai-summary/server/tasks/SummarizeDocumentTask.ts`:

```typescript
import documentCreator from "@server/commands/documentCreator";
import { createContext } from "@server/context";
import { Attachment, User } from "@server/models";
import { BaseTask, TaskPriority } from "@server/queues/tasks/base/BaseTask";
import { sequelize } from "@server/storage/database";
import FileStorage from "@server/storage/files";
import LiteLLMClient from "../litellm/LiteLLMClient";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";

type Props = {
  attachmentId: string;
  userId: string;
  ip: string;
};

/** Extract the original file name from an attachment storage key. */
function fileNameFromKey(key: string): string {
  return key.split("/").pop() || "document.pdf";
}

/** Strip a trailing file extension for use as a fallback title. */
function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/**
 * Background task: read an uploaded PDF, summarize it via the LiteLLM proxy,
 * create an unpublished draft in the uploader's My Drafts with the source
 * attached, and notify the uploader.
 */
export default class SummarizeDocumentTask extends BaseTask<Props> {
  public async perform({ attachmentId, userId, ip }: Props) {
    const attachment = await Attachment.findByPk(attachmentId, {
      rejectOnEmpty: true,
    });
    const user = await User.findByPk(userId, { rejectOnEmpty: true });

    const fileName = fileNameFromKey(attachment.key);
    const buffer = await FileStorage.getFileBuffer(attachment.key);

    const { title, summaryMarkdown } = await LiteLLMClient.summarize({
      buffer,
      fileName,
    });

    const sourceLine = `> **Source:** [${fileName}](${Attachment.getRedirectUrl(
      attachment.id
    )})\n\n`;
    const text = sourceLine + summaryMarkdown;

    const document = await sequelize.transaction(async (transaction) => {
      const created = await documentCreator(
        createContext({ user, ip, transaction }),
        {
          title: title ?? stripExtension(fileName),
          text,
          publish: false,
          sourceMetadata: { fileName, mimeType: attachment.contentType },
        }
      );
      await attachment.update({ documentId: created.id }, { transaction });
      return created;
    });

    await new DraftSummarizedNotificationsTask().schedule({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      status: "completed",
      fileName,
    });
  }

  public async onFailed({ attachmentId, userId }: Props) {
    const [attachment, user] = await Promise.all([
      Attachment.findByPk(attachmentId),
      User.findByPk(userId),
    ]);
    if (!user) {
      return;
    }
    await new DraftSummarizedNotificationsTask().schedule({
      userId: user.id,
      teamId: user.teamId,
      documentId: null,
      status: "failed",
      fileName: attachment ? fileNameFromKey(attachment.key) : "your file",
    });
  }

  public get options() {
    return {
      priority: TaskPriority.Background,
      attempts: 3,
      backoff: { type: "exponential" as const, delay: 60 * 1000 },
    };
  }
}
```

- [ ] **Step 4: Register the task**

Update `plugins/ai-summary/server/index.ts`:

```typescript
import { PluginManager, Hook } from "@server/utils/PluginManager";
import env from "./env";
import SummarizeDocumentTask from "./tasks/SummarizeDocumentTask";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      type: Hook.Task,
      value: SummarizeDocumentTask,
    },
  ]);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts`
Expected: PASS. (Requires Task 6's `DraftSummarizedNotificationsTask` to exist — implement Task 6 if the import fails to resolve, then re-run.)

- [ ] **Step 6: Commit**

```bash
git add plugins/ai-summary/server/tasks/SummarizeDocumentTask.ts plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts plugins/ai-summary/server/index.ts
git commit -m "feat(ai-summary): add SummarizeDocumentTask"
```

---

## Task 6: DraftSummarizedNotificationsTask

**Files:**
- Create: `plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.ts`
- Test: `plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.test.ts`
- Modify: `plugins/ai-summary/server/index.ts` (register the task)

- [ ] **Step 1: Write the failing test**

`plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.test.ts`:

```typescript
import { NotificationEventType } from "@shared/types";
import { Notification } from "@server/models";
import { buildUser, buildDocument } from "@server/test/factories";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";

describe("DraftSummarizedNotificationsTask", () => {
  it("creates a completed notification linked to the draft", async () => {
    const user = await buildUser();
    const document = await buildDocument({ userId: user.id, teamId: user.teamId });

    await new DraftSummarizedNotificationsTask().perform({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      status: "completed",
      fileName: "paper.pdf",
    });

    const notification = await Notification.findOne({ where: { userId: user.id } });
    expect(notification).toBeTruthy();
    expect(notification!.event).toEqual(NotificationEventType.DraftSummarized);
    expect(notification!.documentId).toEqual(document.id);
  });

  it("creates a failed notification with no document", async () => {
    const user = await buildUser();

    await new DraftSummarizedNotificationsTask().perform({
      userId: user.id,
      teamId: user.teamId,
      documentId: null,
      status: "failed",
      fileName: "broken.pdf",
    });

    const notification = await Notification.findOne({ where: { userId: user.id } });
    expect(notification).toBeTruthy();
    expect(notification!.documentId).toBeNull();
    expect(notification!.data).toMatchObject({ status: "failed", fileName: "broken.pdf" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the task**

`plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.ts`:

```typescript
import { NotificationEventType } from "@shared/types";
import { Notification, User } from "@server/models";
import { BaseTask, TaskPriority } from "@server/queues/tasks/base/BaseTask";

type Props = {
  userId: string;
  teamId: string;
  documentId: string | null;
  status: "completed" | "failed";
  fileName: string;
};

/**
 * Creates the persisted "draft summarized" notification for the requesting
 * user. Creation auto-emits over the user's websocket channel via the
 * Notification model's AfterCreate hook.
 */
export default class DraftSummarizedNotificationsTask extends BaseTask<Props> {
  public async perform({ userId, teamId, documentId, status, fileName }: Props) {
    const user = await User.findByPk(userId);
    if (!user || !user.subscribedToEventType(NotificationEventType.DraftSummarized)) {
      return;
    }

    await Notification.create({
      event: NotificationEventType.DraftSummarized,
      userId,
      actorId: userId,
      teamId,
      documentId,
      data: { status, fileName },
    });
  }

  public get options() {
    return {
      priority: TaskPriority.Background,
      attempts: 5,
      backoff: { type: "exponential" as const, delay: 60 * 1000 },
    };
  }
}
```

- [ ] **Step 4: Register the task**

Update `plugins/ai-summary/server/index.ts` to also register it:

```typescript
import { PluginManager, Hook } from "@server/utils/PluginManager";
import env from "./env";
import DraftSummarizedNotificationsTask from "./tasks/DraftSummarizedNotificationsTask";
import SummarizeDocumentTask from "./tasks/SummarizeDocumentTask";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      type: Hook.Task,
      value: SummarizeDocumentTask,
    },
    {
      type: Hook.Task,
      value: DraftSummarizedNotificationsTask,
    },
  ]);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.test.ts`
Expected: PASS (2 tests). Also re-run Task 5's test now that the dependency exists:
Run: `yarn test plugins/ai-summary/server/tasks/SummarizeDocumentTask.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.ts plugins/ai-summary/server/tasks/DraftSummarizedNotificationsTask.test.ts plugins/ai-summary/server/index.ts
git commit -m "feat(ai-summary): add DraftSummarizedNotificationsTask"
```

---

## Task 7: API route `aiSummary.create`

**Files:**
- Create: `plugins/ai-summary/server/api/schema.ts`
- Create: `plugins/ai-summary/server/api/aiSummary.ts`
- Test: `plugins/ai-summary/server/api/aiSummary.test.ts`
- Modify: `plugins/ai-summary/server/index.ts` (register `Hook.API`)

- [ ] **Step 1: Write the failing test**

`plugins/ai-summary/server/api/aiSummary.test.ts`:

```typescript
import { buildUser, buildAttachment } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import SummarizeDocumentTask from "../tasks/SummarizeDocumentTask";

const server = getTestServer();

describe("#aiSummary.create", () => {
  it("schedules summarization for a PDF the user owns", async () => {
    const spy = vi.spyOn(SummarizeDocumentTask.prototype, "schedule").mockResolvedValue({} as never);
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
    });

    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: attachment.id },
    });

    expect(res.status).toEqual(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: attachment.id, userId: user.id })
    );
    spy.mockRestore();
  });

  it("rejects a non-PDF attachment", async () => {
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "image/png",
    });

    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: attachment.id },
    });
    expect(res.status).toEqual(400);
  });

  it("rejects an attachment from another team", async () => {
    const user = await buildUser();
    const other = await buildUser();
    const attachment = await buildAttachment({
      teamId: other.teamId,
      userId: other.id,
      contentType: "application/pdf",
    });

    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: attachment.id },
    });
    expect(res.status).toEqual(403);
  });

  it("requires authentication", async () => {
    const res = await server.post("/api/aiSummary.create", undefined, {
      body: { attachmentId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toEqual(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test plugins/ai-summary/server/api/aiSummary.test.ts`
Expected: FAIL — route not mounted (404/no handler) because the plugin API isn't registered yet.

- [ ] **Step 3: Create the schema**

`plugins/ai-summary/server/api/schema.ts`:

```typescript
import { z } from "zod";
import { BaseSchema } from "@server/routes/api/schema";

export const AiSummaryCreateSchema = BaseSchema.extend({
  body: z.object({
    attachmentId: z.string().uuid(),
  }),
});

export type AiSummaryCreateReq = z.infer<typeof AiSummaryCreateSchema>;
```

- [ ] **Step 4: Create the route**

`plugins/ai-summary/server/api/aiSummary.ts`:

```typescript
import Router from "koa-router";
import { AuthorizationError, ValidationError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { Attachment } from "@server/models";
import { rateLimiter } from "@server/routes/api/middlewares/rateLimiter";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import SummarizeDocumentTask from "../tasks/SummarizeDocumentTask";
import * as T from "./schema";

const router = new Router();

router.post(
  "aiSummary.create",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(T.AiSummaryCreateSchema),
  async (ctx: APIContext<T.AiSummaryCreateReq>) => {
    const { attachmentId } = ctx.input.body;
    const { user } = ctx.state.auth;

    const attachment = await Attachment.findByPk(attachmentId, {
      rejectOnEmpty: true,
    });

    if (attachment.teamId !== user.teamId) {
      throw AuthorizationError();
    }
    if (attachment.contentType !== "application/pdf") {
      throw ValidationError("Only PDF attachments can be summarized");
    }

    await new SummarizeDocumentTask().schedule({
      attachmentId: attachment.id,
      userId: user.id,
      ip: ctx.ip,
    });

    ctx.body = { success: true };
  }
);

export default router;
```

> `ctx.ip` is provided by the Koa context. If type-checking complains, use `ctx.request.ip`. Document-creation authorization happens inside `documentCreator` within the task; the route enforces team ownership + PDF type and fails fast.

- [ ] **Step 5: Register the route**

Update `plugins/ai-summary/server/index.ts` to add the API hook (spread `config` so the manifest id/name attach to the API plugin):

```typescript
import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import aiSummary from "./api/aiSummary";
import env from "./env";
import DraftSummarizedNotificationsTask from "./tasks/DraftSummarizedNotificationsTask";
import SummarizeDocumentTask from "./tasks/SummarizeDocumentTask";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      ...config,
      type: Hook.API,
      value: aiSummary,
    },
    {
      type: Hook.Task,
      value: SummarizeDocumentTask,
    },
    {
      type: Hook.Task,
      value: DraftSummarizedNotificationsTask,
    },
  ]);
}
```

> The route tests need the plugin enabled. Ensure the test environment sets `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_SUMMARY_MODEL` (add them to the test env file, e.g. `.env.test`, or stub `./env` in the test). If plugins are loaded once at server boot, add these three vars to the test environment rather than per-test.

- [ ] **Step 6: Run the test to verify it passes**

Run: `yarn test plugins/ai-summary/server/api/aiSummary.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add plugins/ai-summary/server/api plugins/ai-summary/server/index.ts
git commit -m "feat(ai-summary): add aiSummary.create route"
```

---

## Task 8: Client — Settings → Import entry + upload dialog

**Files:**
- Create: `plugins/ai-summary/client/SummarizePaper.tsx`
- Create: `plugins/ai-summary/client/index.tsx`

Client UI here mirrors `plugins/notion/client/Imports.tsx` (a `<Button>` that opens a modal via the `dialogs` store) and `app/scenes/Settings/components/DropToImport.tsx` (the Dropzone + `uploadFile`). Frontend behavior is verified manually (Step 4); the repo's settings-import plugins are not unit-tested, so we follow that precedent rather than invent a brittle render test.

- [ ] **Step 1: Create the dialog + action component**

`plugins/ai-summary/client/SummarizePaper.tsx`:

```typescript
import { observer } from "mobx-react";
import { useState } from "react";
import Dropzone from "react-dropzone";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AttachmentPreset } from "@shared/types";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";
import { uploadFile } from "~/utils/files";

function SummarizePaperDialog({ onSubmit }: { onSubmit: () => void }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [isWorking, setWorking] = useState(false);

  const handleFiles = (files: File[]) => {
    if (files.length > 1) {
      toast.error(t("Please choose a single file"));
      return;
    }
    setFile(files[0]);
  };

  const handleStart = async () => {
    if (!file) {
      return;
    }
    setWorking(true);
    try {
      const attachment = await uploadFile(file, {
        name: file.name,
        preset: AttachmentPreset.AISummarySource,
      });
      await client.post("/aiSummary.create", { attachmentId: attachment.id });
      onSubmit();
      toast.message(file.name, {
        description: t("Summarizing… we'll notify you when your draft is ready"),
      });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Flex gap={8} column>
      <Text as="p" type="secondary">
        {t("Upload a PDF and an AI draft summary will be created in your drafts.")}
      </Text>
      <Dropzone accept="application/pdf" onDropAccepted={handleFiles} disabled={isWorking}>
        {({ getRootProps, getInputProps }) => (
          <div {...getRootProps()} tabIndex={-1}>
            <input {...getInputProps()} />
            <Button neutral disabled={isWorking}>
              {file ? file.name : t("Choose a PDF")}…
            </Button>
          </div>
        )}
      </Dropzone>
      <Flex justify="flex-end">
        <Button disabled={!file || isWorking} onClick={handleStart}>
          {isWorking ? `${t("Uploading")}…` : t("Summarize")}
        </Button>
      </Flex>
    </Flex>
  );
}

export const SummarizePaper = observer(() => {
  const { t } = useTranslation();
  const { dialogs } = useStores();

  const handleOpen = () => {
    dialogs.openModal({
      title: t("Summarize a paper"),
      content: (
        <SummarizePaperDialog onSubmit={() => dialogs.closeAllModals()} />
      ),
    });
  };

  return (
    <Button type="button" onClick={handleOpen} neutral>
      {t("Upload")}…
    </Button>
  );
});
```

> Smart-quote note (repo convention): keep the curly apostrophe in "we'll" exactly as written — do not replace smart quotes with straight quotes.

- [ ] **Step 2: Register the import entry (gated)**

`plugins/ai-summary/client/index.tsx`:

```typescript
import { t } from "i18next";
import { SparklesIcon } from "outline-icons";
import * as React from "react";
import env from "@shared/env";
import { Hook, PluginManager } from "~/utils/PluginManager";
import config from "../plugin.json";
import { SummarizePaper } from "./SummarizePaper";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      ...config,
      type: Hook.Imports,
      value: {
        title: "Summarize a paper",
        subtitle: t("Upload a PDF and get an AI draft summary"),
        icon: <SparklesIcon />,
        action: <SummarizePaper />,
      },
    },
  ]);
}
```

> Confirm `SparklesIcon` exists in `outline-icons` (`grep -r "SparklesIcon" node_modules/outline-icons/`); if not, use an existing icon such as `NewDocumentIcon`. `env` here is `@shared/env`, which reads `window.env` on the client — `AI_SUMMARY_ENABLED` is injected by the plugin's `@Public` field.

- [ ] **Step 3: Type-check and lint**

Run: `yarn tsc --noEmit && yarn lint`
Expected: PASS. Fix any type/lint errors in the two new client files (especially the `Uploading…` template-literal note above).

- [ ] **Step 4: Manual verification**

1. Set `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_SUMMARY_MODEL` in `.env`.
2. Run the app (`yarn dev` or the project's run command).
3. Go to **Settings → Import**; confirm a "Summarize a paper" entry appears.
4. Click **Upload…**, choose a PDF, click **Summarize**; confirm the toast appears.
5. Wait for the background task; confirm a draft appears in **My Drafts** with the five sections and a "Source" link, and that a notification arrives.
6. Unset the env vars, restart; confirm the entry disappears.

- [ ] **Step 5: Commit**

```bash
git add plugins/ai-summary/client
git commit -m "feat(ai-summary): add Settings > Import entry and upload dialog"
```

---

## Task 9: Documentation, full checks, and branch wrap-up

**Files:**
- Modify: `.env.sample` (document the new env vars)

- [ ] **Step 1: Document env vars**

Append to `.env.sample` (follow the file's existing comment style):

```bash
# AI summarize-a-paper (Duke LiteLLM proxy, OpenAI-compatible)
# LITELLM_BASE_URL=https://litellm.example.edu/v1
# LITELLM_API_KEY=sk-...
# LITELLM_SUMMARY_MODEL=gpt-5
# AI_SUMMARY_MAX_FILE_SIZE=26214400
```

- [ ] **Step 2: Run the full plugin test suite + type/lint**

Run:
```bash
yarn test plugins/ai-summary
yarn test server/models/helpers/AttachmentHelper.test.ts
yarn test server/models/User.test.ts
yarn tsc --noEmit
yarn lint
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add .env.sample
git commit -m "docs(ai-summary): document LiteLLM env vars in .env.sample"
```

- [ ] **Step 4: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide how to integrate (PR vs merge) the `feat/ai-summarize-to-draft` branch.

---

## Self-Review

**Spec coverage:**
- In-app Settings → Import entry → Task 8. ✓
- Fixed 5-section template → Task 4 (`prompt.ts`). ✓
- PDF → vision model via proxy → Task 4 (`LiteLLMClient`). ✓
- Draft in My Drafts + source attached → Task 5. ✓
- Async background task → Tasks 5/6. ✓
- Notify when ready (+ failure) → Tasks 2/6. ✓
- `LITELLM_*` env + 25 MB cap → Tasks 1/3. ✓
- Auth / PDF-only / rate limit / team isolation → Task 7. ✓
- Testing strategy (unit + integration, mocked externals) → Tasks 1,2,4,5,6,7. ✓

**Placeholder scan:** No `TBD`/`TODO`/"add error handling" left. The two explicit "verify against the real proxy/icon" notes are genuine external-dependency confirmations, not deferred work.

**Type consistency:** `AttachmentPreset.AISummarySource`, `NotificationEventType.DraftSummarized`, `LiteLLMClient.summarize({buffer,fileName})`, `SummarizeDocumentTask` Props `{attachmentId,userId,ip}`, and `DraftSummarizedNotificationsTask` Props `{userId,teamId,documentId,status,fileName}` are used identically across Tasks 4–7. The route schedules `SummarizeDocumentTask` with `{attachmentId,userId,ip}` matching the task's Props.

**Known sequencing note:** Task 5 imports `DraftSummarizedNotificationsTask` (Task 6). Implement Task 6 before re-running Task 5's test (called out in Task 5 Step 5).
