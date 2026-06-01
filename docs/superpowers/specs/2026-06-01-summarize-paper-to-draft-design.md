# Feature #1 — "Summarize a paper" → AI draft

- **Date:** 2026-06-01
- **Status:** Approved design, ready for implementation planning
- **Project:** Outline fork for Duke's Environmental Law & Policy Clinic (ELPC)
- **Scope:** This spec covers feature #1 only. Feature #2 (semantic/vector search) is a separate, later spec → plan → build cycle.

## 1. Goal & context

Clinic students need to turn an academic paper (PDF) into a structured, searchable wiki entry without leaving Outline. This feature adds an in-app action that uploads a paper, sends it to **Duke's LiteLLM proxy** (OpenAI-compatible, GPT-5.x vision model) for summarization, and creates a **draft** in the uploader's *My Drafts* using a fixed section template, with the original PDF attached for provenance. The student reviews/edits the draft and publishes it into a collection themselves.

The work is packaged as a self-contained Outline plugin (`plugins/ai-summary`) plus a small number of minimal core edits (a new notification type and a new attachment upload preset). It reuses Outline's existing primitives end-to-end: presigned upload (`uploadFile`), the Bull/Redis task queue (`BaseTask`), `documentCreator`, the `Attachment`↔`Document` link, and the `Notification` → websocket pipeline.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Entry point | In-app, **Settings → Import** via `Hook.Imports` | Most self-contained surface; mirrors the Notion import plugin; no command/menu core edits. |
| Summary output | **Fixed structured template**: Citation / Summary / Key Findings / Methodology / Relevance to the clinic | Predictable, skimmable, good structure for future semantic search. |
| Extraction | **Send the PDF directly to GPT-5.x vision** via the proxy | Sidesteps Outline's lack of a PDF importer; handles scanned case law; no local OCR needed. |
| Draft location | Uploader's **My Drafts** (unpublished), source PDF **attached** | Provenance preserved; student controls publishing. |
| Wait UX | **Async** background task; **notify when ready** (in-app notification → draft) | Vision summarization exceeds the HTTP request timeout. |
| Config | `LITELLM_*` **env vars** | Single self-hosted clinic instance; secrets stay server-side. |
| Max upload | **25 MB**, configurable via `AI_SUMMARY_MAX_FILE_SIZE` | Covers most papers incl. figures. |

## 3. Non-goals (v1)

- Non-PDF inputs (`.docx`, images, `.txt`). PDF-only for v1; others are a future extension.
- Local OCR / local text extraction (we rely on the vision model).
- Per-team or per-user configurable prompt (the template is a code constant, isolated in one file).
- Email notification (in-app notification only; email is a future option).
- Publishing the draft automatically or selecting a destination collection at upload time.

## 4. Architecture

### 4.1 Plugin files to create

```
plugins/ai-summary/
  plugin.json                         # id, name, priority, description
  server/
    index.ts                          # registers Hook.API + Hook.Task iff env configured
    env.ts                            # LITELLM_* + AI_SUMMARY_MAX_FILE_SIZE + @Public enabled flag
    api/
      aiSummary.ts                    # Koa router: POST /api/aiSummary.create
      schema.ts                       # zod schema for the route
    tasks/
      SummarizeDocumentTask.ts        # the worker: read file -> LiteLLM -> draft -> link -> notify
      DraftSummarizedNotificationsTask.ts  # creates the "ready"/"failed" Notification
    litellm/
      LiteLLMClient.ts                # OpenAI-compatible client (chat completions w/ PDF; embeddings-ready)
      prompt.ts                       # fixed 5-section template + JSON response contract
    aiSummary.test.ts                 # collocated server tests
  client/
    index.tsx                         # PluginManager.add({ type: Hook.Imports, ... })
    SummarizePaper.tsx                # upload dialog (uploadFile -> client.post)
```

### 4.2 Core files to modify (minimal, follow existing patterns)

| File | Change |
|---|---|
| `shared/types.ts` | Add `NotificationEventType.DraftSummarized = "documents.summarize_completed"` + its `NotificationEventDefaults` entry (`true`); add `AttachmentPreset.AISummarySource`. |
| `server/models/helpers/AttachmentHelper.ts` | Add cases for the new preset: max size = `AI_SUMMARY_MAX_FILE_SIZE` (default 25 MB), ACL = private, expiry = none. |
| `app/models/Notification.ts` | Add `path` routing (→ `documentPath(this.document)` on success; settings/none on failure) and `eventText` (via `t()`) for the new type. |

Notes:
- Translations are **not** hand-edited — `t()` calls in code are auto-extracted (per repo convention).
- Adding a `NotificationEventType` may also require a label/grouping in the notification-settings UI; confirm during planning.

### 4.3 Environment variables (`plugins/ai-summary/server/env.ts`)

| Var | Purpose | Notes |
|---|---|---|
| `LITELLM_BASE_URL` | Proxy base, e.g. `https://litellm.duke.edu/v1` | required to enable plugin |
| `LITELLM_API_KEY` | Virtual key | secret, `_FILE` supported, never `@Public`, never logged; required |
| `LITELLM_SUMMARY_MODEL` | Vision-capable chat model id (GPT-5.x) | required |
| `AI_SUMMARY_MAX_FILE_SIZE` | Max upload bytes | default 25 MB |
| `AI_SUMMARY_ENABLED` (`@Public`, derived) | Client gate for showing the action | true when base URL + key + model present |

Pattern: extend the `Environment` class with class-validator decorators (`plugins/slack/server/env.ts` is the template). The plugin registers in `server/index.ts` only when `LITELLM_BASE_URL` and `LITELLM_API_KEY` are set (`plugins/storage/server/index.ts` is the conditional-registration template).

## 5. End-to-end data flow

```
Student: Settings → Import → "Summarize a paper (AI)" → picks paper.pdf
  │
  │ uploadFile(file, { preset: AttachmentPreset.AISummarySource })   (app/utils/files.ts)
  │   → POST /attachments.create (presigned) → PUT straight to S3/local; documentId = null
  ▼
client.post("/aiSummary.create", { attachmentId })   // ApiClient prefixes /api
  ▼
aiSummary.create:
  • auth: member who can create documents (authorizeDocumentCreate); not viewers
  • validate: attachment belongs to caller's team, contentType === "application/pdf", size ≤ cap
  • schedule SummarizeDocumentTask({ attachmentId, userId, ip })
  • respond 200 { success: true }      → client toast: "Summarizing… we'll notify you"
  ▼ (Bull task queue — background, TaskPriority.Background)
SummarizeDocumentTask.perform():
  1. load Attachment + User (rejectOnEmpty)
  2. buffer = FileStorage.getFileBuffer(attachment.key)
  3. { title, summaryMarkdown } = LiteLLMClient.summarize(buffer, fileName)
        → POST {LITELLM_BASE_URL}/chat/completions
          model = LITELLM_SUMMARY_MODEL,
          messages: [ system(template), user([ text(instructions), file(pdf base64) ]) ],
          response_format: json
  4. body = "> **Source:** [paper.pdf](/api/attachments.redirect?id=<id>)\n\n" + summaryMarkdown
  5. sequelize.transaction(t):
        draft = documentCreator(
          createContext({ user, ip, transaction: t }),
          { title: title || fileNameWithoutExt, text: body, publish: false,
            sourceMetadata: { fileName, mimeType } })          ← My Drafts (no collectionId)
        attachment.update({ documentId: draft.id }, { transaction: t })
  6. schedule DraftSummarizedNotificationsTask({ documentId: draft.id, userId, status: "completed" })
  • on final failure (onFailed): schedule DraftSummarizedNotificationsTask({ userId, status: "failed", fileName })
  ▼
Notification.create(...) → @AfterCreate → Event "notifications.create"
  → WebsocketsProcessor emits to room user-${userId}
  ▼
Student sees "Your summary draft is ready" → clicks → opens draft → review & publish
```

## 6. Component detail

### 6.1 Client — `client/index.tsx` + `SummarizePaper.tsx`

Register with `PluginManager.add({ id, type: Hook.Imports, name, description, value: { title, subtitle, icon, action } })` (template: `plugins/notion/client/index.tsx`; render location: `app/scenes/Settings/Import.tsx`). The `action` element opens a dialog with a file input/Dropzone (template: `app/scenes/Settings/components/DropToImport.tsx`), calls `uploadFile(file, { preset: AttachmentPreset.AISummarySource, onProgress })` (`app/utils/files.ts`), then `client.post("/aiSummary.create", { attachmentId })` (`~/utils/ApiClient`), then shows a success toast. The entry is hidden when `AI_SUMMARY_ENABLED` (public env) is false.

### 6.2 Server route — `api/aiSummary.ts`

`POST /api/aiSummary.create`. Authenticated; `rateLimiter` middleware applied. zod schema validates `attachmentId` (UUID). Loads the attachment, checks team ownership + `contentType === "application/pdf"`, authorizes document creation, schedules the task, returns `{ success: true }`. Router exported as the plugin's `Hook.API` value (template: `plugins/webhooks/server/api/webhookSubscriptions.ts`).

### 6.3 `SummarizeDocumentTask` (extends `BaseTask`)

Background-priority task. Follows the two-context pattern from `server/queues/tasks/DocumentImportTask.ts` (createContext outside the transaction for prep; createContext with the transaction for `documentCreator`). Uses `FileStorage.getFileBuffer`, `LiteLLMClient`, `documentCreator`, and `attachment.update`. Bull retry attempts kept small (LLM failures are often non-transient); `onFailed` schedules the failure notification. No new DB table — state lives in the Attachment (already persisted) and the resulting Document/Notification.

### 6.4 `DraftSummarizedNotificationsTask` (extends `BaseTask`)

Template: `server/queues/tasks/DocumentPublishedNotificationsTask.ts`. Checks `user.subscribedToEventType(NotificationEventType.DraftSummarized)`, then `Notification.create({ event: DraftSummarized, userId, actorId: userId, teamId, documentId, data: { status, fileName } })`. The `@AfterCreate` hook auto-emits over the websocket — no manual socket emit. `documentId` is null on failure (the client `path`/`eventText` branch on `data.status`).

### 6.5 `LiteLLMClient` + `prompt.ts`

Thin OpenAI-compatible client over `fetch` to `${LITELLM_BASE_URL}/chat/completions`, `Authorization: Bearer ${LITELLM_API_KEY}`. The PDF is sent as a `file` content part with a base64 data URL (OpenAI Chat Completions document-input shape); the prompt requests a JSON object `{ title, summaryMarkdown }` (`response_format` JSON / json_schema) so we get a clean title and a body already in the five sections. Defensive parse with fallbacks (title → filename). `prompt.ts` holds the fixed template as a single constant. The client is structured so feature #2 can add an `embeddings()` method against `${LITELLM_BASE_URL}/embeddings`.

> Implementation check: confirm the exact PDF content-part shape the proxy/model accepts (Chat Completions `file` part vs. Responses API `input_file`) against Duke's proxy before finalizing.

### 6.6 Attachment preset & link

Add `AttachmentPreset.AISummarySource` (`shared/types.ts`) with `AttachmentHelper` cases: max = `AI_SUMMARY_MAX_FILE_SIZE`, ACL = private, **expiry = none** (the built-in `Import` preset expires in 24h — unsuitable for a permanently-attached source). The client uploads with this preset; the task sets `attachment.documentId` after the draft is created and embeds the private redirect link `/api/attachments.redirect?id=<id>` at the top of the body (`Attachment.getRedirectUrl`).

## 7. Data model

No new tables. Reuses `Attachment` (source file, then linked via `documentId`), `Document` (the draft), and `Notification` (the ready/failed ping). The schema-adjacent changes are two new enum values:

- `AttachmentPreset.AISummarySource` — **never persisted as a column** (the preset is a client-supplied hint used to derive key/ACL/size); no migration.
- `NotificationEventType.DraftSummarized` — confirm during planning whether `Notification.event` is a plain string column (no migration) or a Postgres `ENUM` type (would need an `ALTER TYPE … ADD VALUE` migration). Most Outline enum columns are strings, but verify before assuming.

## 8. Error handling & edge cases

| Case | Behavior |
|---|---|
| Upload exceeds cap | Rejected at `attachments.create` (preset max). |
| Non-PDF | Rejected at `aiSummary.create` validation (PDF-only v1). |
| LLM error / timeout | Bull retries a small number of times; on final failure → failure notification + structured log; attachment retained for retry. |
| Empty/low-quality summary | Draft still created (fail-open; human reviews before publishing). |
| Model returns no title | Fallback to the filename (minus extension). |
| Proxy not configured | Plugin not registered; client action hidden. |

No silent failures: every terminal failure produces a user-visible notification and a log line.

## 9. Security

- Proxy key is server-only, `_FILE`-loadable, never `@Public`, never logged.
- `aiSummary.create` is authenticated, rate-limited, authorizes document creation, and verifies the attachment belongs to the caller's team.
- Source attachments are private (ACL) and served via the access-checked `attachments.redirect` route.
- Follows repo guidance: validate input with the schema/validation middleware; thin route, logic in the task/client.

## 10. Testing

- **Unit (collocated `.test.ts`, Vitest):**
  - `LiteLLMClient` request construction (mocked `fetch`): correct URL, auth header, model, message shape, JSON response parsing + fallbacks.
  - `prompt.ts` template assembly.
  - Body assembly: source-link prepend + title fallback.
- **Integration (server):**
  - `aiSummary.create`: rejects non-PDF / oversized / unauthorized; schedules the task on the happy path.
  - `SummarizeDocumentTask.perform()` with `LiteLLMClient` + `FileStorage` mocked (`__mocks__`): asserts a draft exists with `publishedAt: null` and no collection, `attachment.documentId` set, notification task scheduled. Uses `buildUser` / `buildAttachment` factories.
- Mock external dependencies (LiteLLM, storage) in `__mocks__`; do not call the real proxy in tests.

## 11. Open questions / future work

- **Surface upgrade:** a command-palette / "+ New" action in addition to Settings → Import, for greater student discoverability (deferred; Settings → Import chosen for v1).
- **Input formats:** `.docx` (reuse mammoth → text), images, and OCR fallback for scanned PDFs that the chosen path doesn't already cover.
- **Failure notification modeling:** single `DraftSummarized` type with `data.status` (chosen) vs. a dedicated failure type — revisit if the notification-settings UI needs distinct toggles.
- **Email notification** as an opt-in addition (template precedent: `ExportSuccessEmail`).
- **Shared LiteLLM client:** likely extracted to a shared location when feature #2 (semantic search) reuses it for embeddings.

## 12. Key reference files (verified)

- Plugin contract: `server/utils/PluginManager.ts`, `app/utils/PluginManager.ts`, `plugins/notion/client/index.tsx`, `plugins/storage/server/index.ts`, `plugins/slack/server/env.ts`.
- Upload: `app/utils/files.ts` (`uploadFile`), `server/routes/api/attachments/attachments.ts`, `server/models/helpers/AttachmentHelper.ts`, `server/models/Attachment.ts`.
- Draft creation: `server/commands/documentCreator.ts`, `server/queues/tasks/DocumentImportTask.ts`, `server/context.ts` (`createContext`), `server/models/Document.ts` (`isDraft`).
- Notifications: `shared/types.ts` (`NotificationEventType`/defaults), `server/models/Notification.ts`, `server/queues/processors/WebsocketsProcessor.ts`, `server/queues/tasks/DocumentPublishedNotificationsTask.ts`, `app/models/Notification.ts`.
- Tasks: `server/queues/tasks/base/BaseTask.ts`, `server/queues/index.ts`.
