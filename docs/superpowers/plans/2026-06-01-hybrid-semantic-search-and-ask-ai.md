# Hybrid Semantic Search + Ask AI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Outline's keyword search with a **hybrid** (keyword + pgvector) semantic search provider, and add an inline **Ask AI** RAG answer (with citations) to search results.

**Architecture:** A new `plugins/search-vector` registers a `HybridSearchProvider` (selected by `SEARCH_PROVIDER=vector`) that composes the existing `PostgresSearchProvider` for the keyword half and **all permission filtering**, uses a `document_embeddings` (pgvector) table as a candidate generator for the vector half, fuses the two with Reciprocal Rank Fusion, and generates a grounded answer from the top docs. A shared `server/utils/LiteLLMClient` (promoted out of feature #1) provides chat + embeddings.

**Tech Stack:** TypeScript, Sequelize + **pgvector** (`vector(1536)`/HNSW), Koa, Bull (`CronTask`), Vitest, React/MobX (answer panel), OpenAI-compatible LiteLLM proxy.

**Spec:** `docs/superpowers/specs/2026-06-01-hybrid-semantic-search-and-ask-ai-design.md`

---

## Permission safety (read first — applies to every search task)

The vector half **never authorizes**. It does pgvector similarity to get **team-scoped candidate document IDs**, then calls `new PostgresSearchProvider().searchForUser(user, { documentIds: candidateIds, query: undefined, limit: candidateIds.length })` and keeps **only** the documents that call returns. Because that call runs Outline's exact `buildWhere` access logic, a user can never receive a vector hit for a document they can't see. Every permission test must prove this (cross-collection, no-membership, other-team, other-user's-draft must never appear).

## File structure

**Prerequisite (Task 0):** `docker-compose.yml` postgres → `pgvector/pgvector`; recreate + migrate `outline-test`.

**Core/shared (create/modify):**
- `server/env.ts` — add `LITELLM_BASE_URL`, `LITELLM_API_KEY` (core; plugins inherit)
- `server/utils/LiteLLMClient.ts` — NEW shared client (moved from ai-summary) + `embeddings()`
- `server/utils/BaseSearchProvider.ts` — add `answer?: string` to `SearchResponse`
- `server/models/DocumentEmbedding.ts` + migration — NEW pgvector table/model
- `server/models/index.ts` — export `DocumentEmbedding`
- `server/routes/api/documents/documents.ts` — thread `answer` into response + `SearchQuery.answer`
- `app/types.ts` + search scene — consume `answer`; render answer panel
- `plugins/ai-summary/...` — refactor to use the shared client + core env (keep #1 tests green)

**Plugin `plugins/search-vector/` (create):**
- `plugin.json` (`id: "vector"`), `server/index.ts`, `server/env.ts`
- `server/HybridSearchProvider.ts`
- `server/vector/embeddings.ts`, `server/vector/query.ts`, `server/vector/fusion.ts`
- `server/rag/prompt.ts`, `server/rag/answer.ts`
- `server/tasks/BackfillEmbeddingsTask.ts`
- collocated `*.test.ts`

**Confirmed facts (from extraction):**
- `SearchResponse` = `{ results: { ranking:number; context?:string; document:Document }[]; total:number }` (`server/utils/BaseSearchProvider.ts:11-22`).
- `PostgresSearchProvider` methods are public + composable; `searchForUser(user, options={})` (`:376`).
- `SearchOptions.documentIds?: string[]` filters to specific docs (with access applied).
- `SearchIndexProcessor` calls `Document.findByPk` then `provider.index(SearchableModel.Document, doc)` / `updateMetadata` / `remove(id, teamId)`; Postgres provider early-returns no-op.
- `DocumentHelper.toPlainText(document)` (`server/models/helpers/DocumentHelper.tsx:178`).
- `SearchQuery` has nullable `answer`/`score`; presenter already returns them; create call at `query && offset===0` (`documents.ts:1230`).
- Migrations: `CREATE EXTENSION` raw (`20240912222438`); `createTable` in `sequelize.transaction` + `addIndex` (`20260104155139`); raw SQL via `sequelize.query` with `:param` replacements + `::vector` casts.
- `CronTask` base: abstract `get cron()`; example `server/queues/tasks/CleanupDeletedTeamsTask.ts`; `server/services/cron.ts` schedules.

---

## Task 0: pgvector dev/test database (environment prerequisite)

**Files:** Modify `docker-compose.yml`

- [ ] **Step 1: Switch the Postgres image**
In `docker-compose.yml`, change the `postgres` service `image: postgres` → `image: pgvector/pgvector:pg16`.

- [ ] **Step 2: Recreate the containers and test DB**
(Compose v1 is broken on this host — use `docker run`, matching the existing dev setup.)
```bash
docker rm -f outline-postgres outline-redis 2>/dev/null
docker run -d --name outline-redis -p 127.0.0.1:6379:6379 redis
docker run -d --name outline-postgres -p 127.0.0.1:5432:5432 -e POSTGRES_USER=user -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=outline pgvector/pgvector:pg16
# wait for ready, then:
docker exec outline-postgres psql -U user -d outline -c 'CREATE DATABASE "outline-test";'
docker exec outline-postgres psql -U user -d "outline-test" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

- [ ] **Step 3: Verify pgvector + re-migrate**
```bash
docker exec outline-postgres psql -U user -d "outline-test" -c "SELECT '[1,2,3]'::vector;"   # expect a vector value, no error
NODE_ENV=test yarn db:migrate
yarn test server/models/User.test.ts   # sanity: harness still green
```
Expected: the `::vector` cast succeeds; migrations + sanity test pass.

- [ ] **Step 4: Commit**
```bash
git add docker-compose.yml
git commit -m "build(search): use pgvector postgres image for dev/test"
```

---

## Task 1: Promote the LiteLLM client to shared core + add embeddings()

**Files:**
- Modify: `server/env.ts` (add `LITELLM_BASE_URL`, `LITELLM_API_KEY`)
- Create: `server/utils/LiteLLMClient.ts` (move class from ai-summary; add `embeddings`)
- Create: `server/utils/LiteLLMClient.test.ts` (move/extend the existing client test)
- Modify: `plugins/ai-summary/server/env.ts` (drop the two inherited vars)
- Modify: `plugins/ai-summary/server/litellm/LiteLLMClient.ts` → re-export shared
- Modify: `plugins/ai-summary/server/tasks/SummarizeDocumentTask.ts` (import path)
- Delete/replace: `plugins/ai-summary/server/litellm/LiteLLMClient.test.ts`

- [ ] **Step 1: Move the two connection vars to core env**
In `server/env.ts`, near the other optional integration vars (after `FILE_STORAGE_*`), add:
```typescript
/**
 * Base URL of an OpenAI-compatible LiteLLM proxy used by AI features.
 */
@IsOptional()
@IsUrl({ require_tld: false })
public LITELLM_BASE_URL = this.toOptionalString(environment.LITELLM_BASE_URL);

/**
 * API key (virtual key) for the LiteLLM proxy. Secret; supports _FILE.
 */
@IsOptional()
@CannotUseWithout("LITELLM_BASE_URL")
public LITELLM_API_KEY = this.toOptionalString(environment.LITELLM_API_KEY);
```
Ensure `IsUrl`, `IsOptional`, `CannotUseWithout` are imported in `server/env.ts` (check existing imports; add if missing, mirroring `plugins/ai-summary/server/env.ts`).

- [ ] **Step 2: Move the client to `server/utils/LiteLLMClient.ts`**
`git mv plugins/ai-summary/server/litellm/LiteLLMClient.ts server/utils/LiteLLMClient.ts`. In the moved file, change `import env from "../env"` → `import env from "@server/env"`. The shared client must carry **no feature-specific prompts** — it exposes generic `chat()` + `embeddings()` (below), reading `LITELLM_BASE_URL`/`LITELLM_API_KEY` from core env and taking the `model` as a parameter. Feature #1's prompt constants stay in `plugins/ai-summary/server/litellm/prompt.ts` and are passed in by the caller (Step 3).

  Concretely, the shared client exposes two generic methods:
```typescript
import env from "@server/env";

const REQUEST_TIMEOUT_MS = 180_000;

type ChatFileParams = {
  model: string;
  systemPrompt: string;
  userText: string;
  file?: { filename: string; dataUrl: string };
  jsonObject?: boolean;
};

class LiteLLMClient {
  /** Chat completion with an optional PDF/file content part; returns the raw assistant content string. */
  public async chat(params: ChatFileParams): Promise<string> {
    const content: unknown[] = [{ type: "text", text: params.userText }];
    if (params.file) {
      content.push({
        type: "file",
        file: { filename: params.file.filename, file_data: params.file.dataUrl },
      });
    }
    const body = {
      model: params.model,
      ...(params.jsonObject ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content },
      ],
    };
    const json = await this.post("/chat/completions", body);
    return (
      (json as { choices?: { message?: { content?: string } }[] }).choices?.[0]
        ?.message?.content ?? ""
    );
  }

  /** Embed one or more strings; returns one vector per input, in order. */
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
```

- [ ] **Step 3: Update feature #1 to use the shared client (keep its behavior)**
- In `plugins/ai-summary/server/tasks/SummarizeDocumentTask.ts`, change the import to `import LiteLLMClient from "@server/utils/LiteLLMClient"`, and replace the old `LiteLLMClient.summarize({ buffer, fileName })` call with:
```typescript
const raw = await LiteLLMClient.chat({
  model: env.LITELLM_SUMMARY_MODEL!,
  systemPrompt: summarizeSystemPrompt,
  userText: summarizeUserInstruction,
  file: { filename: fileName, dataUrl: `data:application/pdf;base64,${buffer.toString("base64")}` },
  jsonObject: true,
});
const { title, summaryMarkdown } = parseSummaryResponse(raw);
```
  importing `summarizeSystemPrompt`, `summarizeUserInstruction`, `parseSummaryResponse` from `../litellm/prompt` and `env` from `../env`.
- `plugins/ai-summary/server/litellm/LiteLLMClient.ts` is now gone; delete the old `plugins/ai-summary/server/litellm/LiteLLMClient.test.ts` (its assertions move to the shared test).
- `plugins/ai-summary/server/env.ts`: remove the `LITELLM_BASE_URL` and `LITELLM_API_KEY` declarations (now inherited from core `Environment`); keep `LITELLM_SUMMARY_MODEL` (with `@CannotUseWithout("LITELLM_BASE_URL")`) and the `@Public AI_SUMMARY_ENABLED` computed flag (it still reads `this.LITELLM_BASE_URL` etc., now inherited).

- [ ] **Step 4: Write the shared client test** — `server/utils/LiteLLMClient.test.ts`:
```typescript
import env from "@server/env";
import LiteLLMClient from "./LiteLLMClient";

describe("LiteLLMClient", () => {
  const fetchMock = vi.fn();
  const original = { base: env.LITELLM_BASE_URL, key: env.LITELLM_API_KEY };

  beforeEach(() => {
    env.LITELLM_BASE_URL = "https://proxy.test/v1";
    env.LITELLM_API_KEY = "sk-test";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    env.LITELLM_BASE_URL = original.base;
    env.LITELLM_API_KEY = original.key;
    vi.unstubAllGlobals();
  });

  it("chat() posts a file part and returns content", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
    });
    const out = await LiteLLMClient.chat({
      model: "gpt-5", systemPrompt: "s", userText: "u",
      file: { filename: "a.pdf", dataUrl: "data:application/pdf;base64,Zm9v" },
      jsonObject: true,
    });
    expect(out).toEqual("hi");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toEqual("https://proxy.test/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content.find((p: { type: string }) => p.type === "file")).toBeTruthy();
  });

  it("embeddings() returns one vector per input", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
    });
    const out = await LiteLLMClient.embeddings(["a", "b"], "text-embedding-3-small");
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toEqual("https://proxy.test/v1/embeddings");
  });

  it("throws on non-ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(LiteLLMClient.embeddings(["a"], "m")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 5: Run + verify (and keep feature #1 green)**
```bash
yarn test server/utils/LiteLLMClient.test.ts
yarn test plugins/ai-summary/
yarn tsc --noEmit
```
Expected: all pass. (If `LITELLM_SUMMARY_MODEL!` non-null assertion is disallowed, guard it instead.)

- [ ] **Step 6: Commit**
```bash
git add server/env.ts server/utils/LiteLLMClient.ts server/utils/LiteLLMClient.test.ts plugins/ai-summary
git commit -m "refactor(ai): promote LiteLLM client to shared core + add embeddings()"
```

---

## Task 2: `document_embeddings` model + migration (pgvector)

**Files:**
- Create: `server/migrations/20260601100000-create-document-embeddings.js`
- Create: `server/models/DocumentEmbedding.ts`
- Modify: `server/models/index.ts`
- Test: `server/models/DocumentEmbedding.test.ts`

- [ ] **Step 1: Write the migration**
```javascript
"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable("document_embeddings", {
        id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
        documentId: { type: Sequelize.UUID, allowNull: false, references: { model: "documents", key: "id" }, onDelete: "CASCADE" },
        teamId: { type: Sequelize.UUID, allowNull: false, references: { model: "teams", key: "id" }, onDelete: "CASCADE" },
        model: { type: Sequelize.STRING, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE document_embeddings ADD COLUMN embedding vector(1536) NOT NULL;`,
        { transaction }
      );
      await queryInterface.addIndex("document_embeddings", ["documentId", "model"], { unique: true, transaction });
      await queryInterface.addIndex("document_embeddings", ["teamId"], { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX document_embeddings_hnsw_idx ON document_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=200);`,
        { transaction }
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("document_embeddings", { transaction });
    });
  },
};
```

- [ ] **Step 2: Run the migration**
```bash
NODE_ENV=test yarn db:migrate
docker exec outline-postgres psql -U user -d "outline-test" -c "\d document_embeddings"
```
Expected: table exists with an `embedding vector(1536)` column + the hnsw index.

- [ ] **Step 3: Write the model** — `server/models/DocumentEmbedding.ts` (mirror `DocumentInsight.ts`; the `embedding` column is read/written via raw SQL, not normal attributes, so it is intentionally not declared as a typed attribute):
```typescript
import { BelongsTo, Column, DataType, ForeignKey, Table } from "sequelize-typescript";
import Document from "./Document";
import Team from "./Team";
import IdModel from "./base/IdModel";
import Fix from "./decorators/Fix";

@Table({ tableName: "document_embeddings", modelName: "documentEmbedding" })
@Fix
class DocumentEmbedding extends IdModel {
  /** Embedding model that produced the stored vector (e.g. text-embedding-3-small). */
  @Column(DataType.STRING)
  model: string;

  @BelongsTo(() => Document, "documentId")
  document: Document;

  @ForeignKey(() => Document)
  @Column(DataType.UUID)
  documentId: string;

  @BelongsTo(() => Team, "teamId")
  team: Team;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;
}

export default DocumentEmbedding;
```
Add to `server/models/index.ts`: `export { default as DocumentEmbedding } from "./DocumentEmbedding";` (alphabetical position).

- [ ] **Step 4: Test the model + a round-trip embedding upsert via raw SQL** — `server/models/DocumentEmbedding.test.ts`:
```typescript
import { DocumentEmbedding } from "@server/models";
import { sequelize } from "@server/storage/database";
import { buildDocument } from "@server/test/factories";

describe("DocumentEmbedding", () => {
  it("upserts and reads back a vector via raw SQL", async () => {
    const doc = await buildDocument();
    const vec = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;
    await sequelize.query(
      `INSERT INTO document_embeddings (id, "documentId", "teamId", model, embedding, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), :documentId, :teamId, :model, :embedding::vector, now(), now())`,
      { replacements: { documentId: doc.id, teamId: doc.teamId, model: "test-model", embedding: vec } }
    );
    const row = await DocumentEmbedding.findOne({ where: { documentId: doc.id } });
    expect(row?.model).toEqual("test-model");
  });
});
```

- [ ] **Step 5: Run + commit**
```bash
yarn test server/models/DocumentEmbedding.test.ts && yarn tsc --noEmit
git add server/migrations/20260601100000-create-document-embeddings.js server/models/DocumentEmbedding.ts server/models/index.ts server/models/DocumentEmbedding.test.ts
git commit -m "feat(search): add document_embeddings pgvector table + model"
```

---

## Task 3: `SearchResponse.answer` field

**Files:** Modify `server/utils/BaseSearchProvider.ts`

- [ ] **Step 1: Add the field**
In the `SearchResponse` interface (`:11-22`), add after `total`:
```typescript
  /** Optional AI-generated answer for the query (populated only on the first page). */
  answer?: string;
```

- [ ] **Step 2: Verify + commit**
```bash
yarn tsc --noEmit
git add server/utils/BaseSearchProvider.ts
git commit -m "feat(search): add optional answer to SearchResponse"
```

---

## Task 4: search-vector plugin scaffold (manifest + env)

**Files:** Create `plugins/search-vector/plugin.json`, `server/env.ts`, `server/index.ts`

- [ ] **Step 1: Manifest** — `plugins/search-vector/plugin.json`:
```json
{ "id": "vector", "name": "Hybrid semantic search", "priority": 0, "description": "Hybrid keyword + vector search with an AI answer." }
```

- [ ] **Step 2: Env** — `plugins/search-vector/server/env.ts` (mirror `plugins/ai-summary/server/env.ts`; LITELLM base/key inherited from core):
```typescript
import { IsBoolean, IsOptional } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class SearchVectorPluginEnvironment extends Environment {
  /** Embedding model id; must produce 1536-dim vectors to match the column. */
  @IsOptional()
  @CannotUseWithout("LITELLM_BASE_URL")
  public LITELLM_EMBEDDING_MODEL =
    this.toOptionalString(environment.LITELLM_EMBEDDING_MODEL) ??
    "text-embedding-3-small";

  /** Chat model used to generate the Ask AI answer. */
  @IsOptional()
  @CannotUseWithout("LITELLM_BASE_URL")
  public LITELLM_ANSWER_MODEL = this.toOptionalString(
    environment.LITELLM_ANSWER_MODEL
  );

  /** Whether semantic search + Ask AI are configured (exposed to the client). */
  @Public
  @IsBoolean()
  public AI_SEARCH_ENABLED = !!(
    this.LITELLM_BASE_URL &&
    this.LITELLM_API_KEY &&
    environment.SEARCH_PROVIDER === "vector"
  );
}

export default new SearchVectorPluginEnvironment();
```

- [ ] **Step 3: Registration** — `plugins/search-vector/server/index.ts`:
```typescript
import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import HybridSearchProvider from "./HybridSearchProvider";
import BackfillEmbeddingsTask from "./tasks/BackfillEmbeddingsTask";
import "./env";

PluginManager.add([
  { ...config, type: Hook.SearchProvider, value: new HybridSearchProvider() },
  { type: Hook.Task, value: BackfillEmbeddingsTask },
]);
```
> The provider is always registered (cheap); it only becomes *active* when `SEARCH_PROVIDER=vector`. (Create stub `HybridSearchProvider`/`BackfillEmbeddingsTask` in the next tasks; until they exist this file won't compile — implement Tasks 5–9 before running the plugin, or temporarily comment the imports.)

- [ ] **Step 4: tsc (after Tasks 5–9 exist) + commit** — commit with the provider (Task 8) to avoid a broken intermediate import, OR create empty default-export stubs now. Recommended: create stubs now so each task compiles:
```typescript
// plugins/search-vector/server/HybridSearchProvider.ts (stub, replaced in Task 8)
import { BaseSearchProvider } from "@server/utils/BaseSearchProvider";
export default class HybridSearchProvider extends BaseSearchProvider { id = "vector"; /* methods added in Task 8 */ }
```
Then `yarn tsc --noEmit` will flag missing abstract methods — acceptable until Task 8. Commit scaffolding together with Task 8 if needed:
```bash
git add plugins/search-vector/plugin.json plugins/search-vector/server/env.ts plugins/search-vector/server/index.ts
git commit -m "feat(search): scaffold search-vector plugin"
```

---

## Task 5: embeddings module (embed document + query)

**Files:** Create `plugins/search-vector/server/vector/embeddings.ts` + test

- [ ] **Step 1: Failing test** — `embeddings.test.ts`:
```typescript
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { DocumentEmbedding } from "@server/models";
import { buildDocument } from "@server/test/factories";
import { embedDocument, embedQuery } from "./embeddings";

describe("embeddings", () => {
  beforeEach(() => {
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([
      Array.from({ length: 1536 }, () => 0.01),
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("embedDocument upserts a row", async () => {
    const doc = await buildDocument();
    await embedDocument(doc);
    const row = await DocumentEmbedding.findOne({ where: { documentId: doc.id } });
    expect(row).toBeTruthy();
    // re-embed updates, not duplicates
    await embedDocument(doc);
    expect(await DocumentEmbedding.count({ where: { documentId: doc.id } })).toEqual(1);
  });

  it("embedQuery returns a vector literal string", async () => {
    const vec = await embedQuery("hello");
    expect(vec.startsWith("[")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `yarn test plugins/search-vector/server/vector/embeddings.test.ts`

- [ ] **Step 3: Implement** — `embeddings.ts`:
```typescript
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { sequelize } from "@server/storage/database";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import type Document from "@server/models/Document";
import env from "../env";

/** Format a number[] as a pgvector literal, e.g. "[0.1,0.2,...]". */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Embed the query string and return a pgvector literal for use in raw SQL. */
export async function embedQuery(query: string): Promise<string> {
  const [vector] = await LiteLLMClient.embeddings([query], env.LITELLM_EMBEDDING_MODEL);
  return toVectorLiteral(vector);
}

/** Embed a document's title + plain text and upsert the row (one per document+model). */
export async function embedDocument(document: Document): Promise<void> {
  const text = `${document.title}\n\n${DocumentHelper.toPlainText(document)}`.slice(0, 30000);
  const [vector] = await LiteLLMClient.embeddings([text], env.LITELLM_EMBEDDING_MODEL);
  await sequelize.query(
    `INSERT INTO document_embeddings (id, "documentId", "teamId", model, embedding, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), :documentId, :teamId, :model, :embedding::vector, now(), now())
     ON CONFLICT ("documentId", model)
     DO UPDATE SET embedding = EXCLUDED.embedding, "updatedAt" = now()`,
    {
      replacements: {
        documentId: document.id,
        teamId: document.teamId,
        model: env.LITELLM_EMBEDDING_MODEL,
        embedding: toVectorLiteral(vector),
      },
    }
  );
}
```
> Confirm `DocumentHelper` import shape (named vs default) against `server/models/helpers/DocumentHelper.tsx`.

- [ ] **Step 4: Run → PASS; commit**
```bash
yarn test plugins/search-vector/server/vector/embeddings.test.ts && yarn tsc --noEmit
git add plugins/search-vector/server/vector/embeddings.ts plugins/search-vector/server/vector/embeddings.test.ts
git commit -m "feat(search): document/query embedding helpers"
```

---

## Task 6: pgvector candidate query

**Files:** Create `plugins/search-vector/server/vector/query.ts` + test

- [ ] **Step 1: Failing test** — `query.test.ts` (insert two embeddings, assert ordering by similarity, team-scoped):
```typescript
import { sequelize } from "@server/storage/database";
import { buildDocument } from "@server/test/factories";
import { vectorCandidates } from "./query";

async function insert(documentId: string, teamId: string, vec: number[]) {
  await sequelize.query(
    `INSERT INTO document_embeddings (id,"documentId","teamId",model,embedding,"createdAt","updatedAt")
     VALUES (gen_random_uuid(),:documentId,:teamId,'test-model',:e::vector,now(),now())`,
    { replacements: { documentId, teamId, e: `[${vec.join(",")}]` } }
  );
}

describe("vectorCandidates", () => {
  it("returns team-scoped doc ids ordered by similarity", async () => {
    const near = await buildDocument();
    const far = await buildDocument({ teamId: near.teamId });
    const other = await buildDocument(); // different team
    const q = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    await insert(near.id, near.teamId, q);
    await insert(far.id, near.teamId, Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0)));
    await insert(other.id, other.teamId, q);

    const out = await vectorCandidates(near.teamId, `[${q.join(",")}]`, 10);
    const ids = out.map((c) => c.documentId);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(other.id); // team isolation
    expect(ids[0]).toEqual(near.id); // most similar first
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `query.ts`:
```typescript
import { sequelize } from "@server/storage/database";
import { QueryTypes } from "sequelize";

export type VectorCandidate = { documentId: string; similarity: number };

/**
 * Team-scoped vector nearest-neighbours. Returns candidate document ids ordered
 * by cosine similarity. NO permission filtering here — callers MUST pass these
 * ids through PostgresSearchProvider.searchForUser({ documentIds }) to apply access.
 */
export async function vectorCandidates(
  teamId: string,
  queryVector: string,
  limit: number
): Promise<VectorCandidate[]> {
  return sequelize.query<VectorCandidate>(
    `SELECT "documentId", 1 - (embedding <=> :queryVector::vector) AS similarity
     FROM document_embeddings
     WHERE "teamId" = :teamId
     ORDER BY embedding <=> :queryVector::vector
     LIMIT :limit`,
    { replacements: { teamId, queryVector, limit }, type: QueryTypes.SELECT }
  );
}
```

- [ ] **Step 4: Run → PASS; commit**
```bash
yarn test plugins/search-vector/server/vector/query.test.ts && yarn tsc --noEmit
git add plugins/search-vector/server/vector/query.ts plugins/search-vector/server/vector/query.test.ts
git commit -m "feat(search): pgvector candidate query (team-scoped)"
```

---

## Task 7: Reciprocal Rank Fusion

**Files:** Create `plugins/search-vector/server/vector/fusion.ts` + test

- [ ] **Step 1: Failing test** — `fusion.test.ts`:
```typescript
import { reciprocalRankFusion } from "./fusion";

describe("reciprocalRankFusion", () => {
  it("ranks a doc appearing high in both lists first", () => {
    const lexical = ["a", "b", "c"];
    const vector = ["c", "a", "d"];
    const fused = reciprocalRankFusion([lexical, vector]);
    expect(fused[0]).toEqual("a"); // appears in both, near top of each
    expect(fused).toContain("d");
    expect(new Set(fused).size).toEqual(fused.length); // deduped
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `fusion.ts`:
```typescript
const K = 60;

/**
 * Reciprocal Rank Fusion of several ranked id lists into one deduped ranking.
 *
 * @param lists ranked id lists (best first).
 * @returns a single id list ordered by fused score (best first).
 */
export function reciprocalRankFusion(lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (K + index + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
```

- [ ] **Step 4: Run → PASS; commit**
```bash
yarn test plugins/search-vector/server/vector/fusion.test.ts
git add plugins/search-vector/server/vector/fusion.ts plugins/search-vector/server/vector/fusion.test.ts
git commit -m "feat(search): reciprocal rank fusion"
```

---

## Task 8: RAG answer generation

**Files:** Create `plugins/search-vector/server/rag/prompt.ts`, `server/rag/answer.ts` + test

- [ ] **Step 1: Failing test** — `answer.test.ts`:
```typescript
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { buildDocument } from "@server/test/factories";
import { generateAnswer } from "./answer";

describe("generateAnswer", () => {
  it("builds a grounded prompt and returns the answer text", async () => {
    const chat = vi.spyOn(LiteLLMClient, "chat").mockResolvedValue("Under the CWA, ... [1]");
    const doc = await buildDocument({ title: "Wetlands" });
    const out = await generateAnswer("can a state regulate?", [doc]);
    expect(out).toContain("CWA");
    const params = chat.mock.calls[0][0];
    expect(params.systemPrompt.toLowerCase()).toContain("only");   // grounded instruction
    expect(params.userText).toContain("Wetlands");                 // sources included
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `prompt.ts`:
```typescript
export const answerSystemPrompt = `You are a research assistant for an Environmental Law and Policy Clinic.
Answer the user's question using ONLY the provided wiki sources. Cite sources inline as [n].
If the sources do not contain the answer, say so plainly — never invent law, citations, or facts.`;
```
`answer.ts`:
```typescript
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
 * @returns the answer markdown, or null if no answer model is configured.
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
```

- [ ] **Step 4: Run → PASS; commit**
```bash
yarn test plugins/search-vector/server/rag/answer.test.ts && yarn tsc --noEmit
git add plugins/search-vector/server/rag
git commit -m "feat(search): grounded RAG answer generation"
```

---

## Task 9: HybridSearchProvider (the core)

**Files:** Create/replace `plugins/search-vector/server/HybridSearchProvider.ts` + test

- [ ] **Step 1: Failing tests** — `HybridSearchProvider.test.ts` (the **permission-correctness** tests are the point):
```typescript
import { SearchableModel } from "@shared/types";
import { DocumentEmbedding } from "@server/models";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { sequelize } from "@server/storage/database";
import { buildUser, buildDocument, buildCollection } from "@server/test/factories";
import HybridSearchProvider from "./HybridSearchProvider";

async function embed(doc: { id: string; teamId: string }) {
  await sequelize.query(
    `INSERT INTO document_embeddings (id,"documentId","teamId",model,embedding,"createdAt","updatedAt")
     VALUES (gen_random_uuid(),:d,:t,'test-model',:e::vector,now(),now())
     ON CONFLICT ("documentId",model) DO UPDATE SET embedding=EXCLUDED.embedding`,
    { replacements: { d: doc.id, t: doc.teamId, e: `[${Array.from({ length: 1536 }, () => 0.01).join(",")}]` } }
  );
}

describe("HybridSearchProvider", () => {
  const provider = new HybridSearchProvider();
  beforeEach(() => {
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([Array.from({ length: 1536 }, () => 0.01)]);
    vi.spyOn(LiteLLMClient, "chat").mockResolvedValue("an answer");
  });
  afterEach(() => vi.restoreAllMocks());

  it("never returns a vector hit the user cannot access (private collection)", async () => {
    const user = await buildUser();
    const otherCollection = await buildCollection({ teamId: user.teamId, permission: null }); // private, no membership
    const secret = await buildDocument({ teamId: user.teamId, collectionId: otherCollection.id, title: "secret" });
    await embed(secret);

    const res = await provider.searchForUser(user, { query: "secret" });
    expect(res.results.map((r) => r.document.id)).not.toContain(secret.id);
  });

  it("returns an accessible doc and includes an answer at offset 0", async () => {
    const user = await buildUser();
    const collection = await buildCollection({ teamId: user.teamId });
    const doc = await buildDocument({ teamId: user.teamId, collectionId: collection.id, userId: user.id, title: "wetlands" });
    await embed(doc);
    const res = await provider.searchForUser(user, { query: "wetlands" });
    expect(res.results.map((r) => r.document.id)).toContain(doc.id);
    expect(res.answer).toEqual("an answer");
  });
});
```
> `buildCollection` permission semantics: confirm how to create a private collection with no access for `user` (a separate `buildUser` owning it, or `permission: null` + no membership). Adjust so `secret` is genuinely inaccessible to `user`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `HybridSearchProvider.ts`:
```typescript
import type { SearchableModel } from "@shared/types";
import { StatusFilter } from "@shared/types";
import PostgresSearchProvider from "@server/../plugins/search-postgres/server/PostgresSearchProvider";
import { BaseSearchProvider, SearchOptions, SearchResponse } from "@server/utils/BaseSearchProvider";
import type Collection from "@server/models/Collection";
import type Document from "@server/models/Document";
import type Team from "@server/models/Team";
import type User from "@server/models/User";
import { generateAnswer } from "./rag/answer";
import { embedDocument, embedQuery } from "./vector/embeddings";
import { reciprocalRankFusion } from "./vector/fusion";
import { vectorCandidates } from "./vector/query";

const CANDIDATE_LIMIT = 100;
const ANSWER_TOP_K = 5;

export default class HybridSearchProvider extends BaseSearchProvider {
  public id = "vector";

  private lexical = new PostgresSearchProvider();

  public async searchForUser(user: User, options: SearchOptions = {}): Promise<SearchResponse> {
    if (!options.query) {
      return this.lexical.searchForUser(user, options);
    }

    // 1. keyword half (permission-correct + ranked + snippets)
    const lexical = await this.lexical.searchForUser(user, options);

    // 2. vector candidates (team-scoped only)
    const queryVector = await embedQuery(options.query);
    const candidates = await vectorCandidates(user.teamId, queryVector, CANDIDATE_LIMIT);

    // 3. apply EXACT access rules to candidates via the lexical provider
    const accessible = candidates.length
      ? await this.lexical.searchForUser(user, {
          ...options,
          query: undefined,
          documentIds: candidates.map((c) => c.documentId),
          limit: candidates.length,
          offset: 0,
        })
      : { results: [], total: 0 };
    const accessibleById = new Map(accessible.results.map((r) => [r.document.id, r.document]));
    const vectorIds = candidates.map((c) => c.documentId).filter((id) => accessibleById.has(id));

    // 4. fuse keyword + vector orderings
    const lexicalIds = lexical.results.map((r) => r.document.id);
    const fusedIds = reciprocalRankFusion([lexicalIds, vectorIds]);

    // 5. hydrate fused results (prefer lexical context/ranking; fall back to accessible doc)
    const lexicalById = new Map(lexical.results.map((r) => [r.document.id, r]));
    const fused = fusedIds.map((id, index) => {
      const lex = lexicalById.get(id);
      const document = lex?.document ?? accessibleById.get(id)!;
      return { ranking: lex?.ranking ?? 1 / (index + 1), context: lex?.context, document };
    });

    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const page = fused.slice(offset, offset + limit);

    // 6. Ask AI on the first page only
    let answer: string | undefined;
    if (offset === 0) {
      answer =
        (await generateAnswer(options.query, fused.slice(0, ANSWER_TOP_K).map((r) => r.document))) ??
        undefined;
    }

    return { results: page, total: fused.length, answer };
  }

  public async searchForTeam(team: Team, options: SearchOptions = {}): Promise<SearchResponse> {
    // Team/shared search: keyword only (no answer generation for anonymous/shared).
    return this.lexical.searchForTeam(team, options);
  }

  public searchTitlesForUser(user: User, options: SearchOptions = {}): Promise<Document[]> {
    return this.lexical.searchTitlesForUser(user, options);
  }

  public searchCollectionsForUser(user: User, options: SearchOptions = {}): Promise<Collection[]> {
    return this.lexical.searchCollectionsForUser(user, options);
  }

  public async index(model: SearchableModel, item: Document | Collection | Comment): Promise<void> {
    // Embed published documents only; ignore collections/comments/drafts.
    const document = item as Document;
    if (model !== "document" || !document.publishedAt) {
      return;
    }
    await embedDocument(document);
  }

  public async remove(_model: SearchableModel, id: string): Promise<void> {
    await DocumentEmbedding.destroy({ where: { documentId: id } });
  }

  public async updateMetadata(): Promise<void> {
    // Access/metadata is enforced at query time via the lexical provider; no-op.
  }
}
```
> Verify: (a) the import path/style for `PostgresSearchProvider` (it's a sibling plugin — confirm the alias resolves; if not, import via a relative path or `@server`-mapped path); (b) `BaseSearchProvider` exports `SearchOptions`/`SearchResponse` as named types; (c) `Comment`/`Collection` type imports; (d) `SearchableModel` values are string literals (`"document"`).

- [ ] **Step 4: Wire registration** — replace the Task 4 stub `HybridSearchProvider` with this; ensure `plugins/search-vector/server/index.ts` imports it.

- [ ] **Step 5: Run → PASS** (`yarn test plugins/search-vector/server/HybridSearchProvider.test.ts`) **+ tsc + commit**
```bash
git add plugins/search-vector/server/HybridSearchProvider.ts plugins/search-vector/server/HybridSearchProvider.test.ts plugins/search-vector/server/index.ts
git commit -m "feat(search): HybridSearchProvider (keyword+vector+answer, permission-safe)"
```

---

## Task 10: index-on-write wiring + backfill task

**Files:** Create `plugins/search-vector/server/tasks/BackfillEmbeddingsTask.ts` + test. (Index-on-write already happens: `SearchIndexProcessor` calls `provider.index()` for non-Postgres providers — verify it does NOT early-return for our provider; if it gates on `provider.id === "postgres"`, our `"vector"` provider passes through.)

- [ ] **Step 1: Failing test** — `BackfillEmbeddingsTask.test.ts`:
```typescript
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { DocumentEmbedding } from "@server/models";
import { buildDocument, buildDraftDocument } from "@server/test/factories";
import BackfillEmbeddingsTask from "./BackfillEmbeddingsTask";

describe("BackfillEmbeddingsTask", () => {
  beforeEach(() => vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([Array.from({ length: 1536 }, () => 0.01)]));
  afterEach(() => vi.restoreAllMocks());

  it("embeds published docs missing an embedding, skips drafts", async () => {
    const published = await buildDocument(); // factory publishes by default
    const draft = await buildDraftDocument({ teamId: published.teamId });
    await new BackfillEmbeddingsTask().perform({ limit: 100, partition: { index: 0, count: 1 } });
    expect(await DocumentEmbedding.count({ where: { documentId: published.id } })).toEqual(1);
    expect(await DocumentEmbedding.count({ where: { documentId: draft.id } })).toEqual(0);
  });
});
```
> Confirm the exact `CronTask.perform` Props shape (`{ limit, partition }`) and `buildDraftDocument` from `server/test/factories`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — mirror `server/queues/tasks/CleanupDeletedTeamsTask.ts` (the concrete `CronTask` example): a daily cron that finds published documents with no current `document_embeddings` row and calls `embedDocument` in batches, honouring the partition window. Use `Document.findAll` joined/anti-joined against `document_embeddings`. Keep batches small to limit embedding API load; `log()` how many were embedded.

- [ ] **Step 4: Run → PASS; commit**
```bash
yarn test plugins/search-vector/server/tasks/BackfillEmbeddingsTask.test.ts && yarn tsc --noEmit
git add plugins/search-vector/server/tasks/BackfillEmbeddingsTask.ts plugins/search-vector/server/tasks/BackfillEmbeddingsTask.test.ts
git commit -m "feat(search): backfill embeddings cron task"
```

---

## Task 11: thread the answer through documents.search

**Files:** Modify `server/routes/api/documents/documents.ts`, `app/types.ts`

- [ ] **Step 1: Failing test** — add to the existing documents search test (or a new `documents.search.answer.test.ts`): with `SEARCH_PROVIDER=vector` and LiteLLM stubbed, a `documents.search` POST returns `body.answer` and a `SearchQuery` row with a non-null `answer`. (If wiring the provider in a route test is heavy, assert at minimum that the handler passes `response.answer` into `ctx.body.answer` and `SearchQuery.create`.)

- [ ] **Step 2–3: Implement** — In the `documents.search` handler:
  - capture the provider response: `const response = await provider.searchForUser(...)` (it already does; keep `total`, `results`).
  - add `answer: response.answer` to `ctx.body` (alongside `pagination`, `data`, `policies`).
  - extend the `SearchQuery.create({...})` call (at `query && offset === 0`) with `answer: response.answer ?? null`.
  - `app/types.ts`: the search *response* gains `answer?: string` (response-level, not per `SearchResult`). Update the client fetch type accordingly.

- [ ] **Step 4: Run → PASS; commit**
```bash
yarn tsc --noEmit && yarn test server/routes/api/documents
git add server/routes/api/documents/documents.ts app/types.ts
git commit -m "feat(search): return + persist the Ask AI answer from documents.search"
```

---

## Task 12: client answer panel

**Files:** Modify the search results scene (`app/scenes/Search/*`), the search store/hook, reuse `plugins/enterprise/client/translations.tsx` strings.

- [ ] **Step 1: Render the answer panel** — In the search results scene, when the search response includes `answer` and the public `AI_SEARCH_ENABLED` flag is true, render an answer panel **above** the result list: a labelled card ("AI generated answer based on related documents") showing the markdown answer; results render below as today. Reuse the existing enterprise i18n strings. Gate on `import env from "@shared/env"; env.AI_SEARCH_ENABLED`.
> No automated UI test (consistent with feature #1's client); gate is `yarn tsc --noEmit` + `yarn lint` + read-the-code review. Confirm the exact search scene component + store wiring during implementation.

- [ ] **Step 2: tsc + lint + commit**
```bash
yarn tsc --noEmit && yarn lint
git add app/
git commit -m "feat(search): render Ask AI answer panel above results"
```

---

## Task 13: docs, env samples, full verification

**Files:** Modify `.env.sample`, `.env.test`

- [ ] **Step 1: Document env** — append to `.env.sample`:
```bash
# Semantic search + Ask AI (requires LITELLM_* above and pgvector in Postgres)
# SEARCH_PROVIDER=vector
# LITELLM_EMBEDDING_MODEL=text-embedding-3-small
# LITELLM_ANSWER_MODEL=gpt-5
```
Add `SEARCH_PROVIDER=vector` to `.env.test` so the provider activates in route tests (and `LITELLM_*` already present from feature #1).

- [ ] **Step 2: Full verification**
```bash
yarn test plugins/search-vector
yarn test plugins/ai-summary
yarn test server/utils/LiteLLMClient.test.ts server/models/DocumentEmbedding.test.ts server/routes/api/documents
yarn tsc --noEmit
yarn lint
```
Expected: all pass; lint clean for new files.

- [ ] **Step 3: Commit**
```bash
git add .env.sample .env.test
git commit -m "docs(search): document SEARCH_PROVIDER + embedding/answer model env"
```

- [ ] **Step 4: Finish the branch** — use `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:** pgvector store (T0,T2) ✓ · shared LiteLLM client + embeddings (T1) ✓ · `SearchResponse.answer` (T3) ✓ · plugin + gating (T4) ✓ · embeddings/index (T5,T10) ✓ · vector candidate query (T6) ✓ · RRF (T7) ✓ · RAG answer + citations + grounding (T8) ✓ · HybridSearchProvider + **permission fence** (T9) ✓ · backfill (T10) ✓ · route answer threading + SearchQuery (T11) ✓ · client panel (T12) ✓ · docs/env/checks (T13) ✓ · published-only embeddings (T9 index + T10 backfill) ✓.

**Placeholder scan:** The "verify/confirm" notes are genuine integration confirmations (import paths, factory semantics, `SearchIndexProcessor` early-return), not deferred work. No `TODO`/`TBD`.

**Type consistency:** `vectorCandidates(teamId, queryVector, limit) → {documentId, similarity}[]`, `embedQuery → string` (pgvector literal), `embedDocument(document) → void`, `reciprocalRankFusion(string[][]) → string[]`, `generateAnswer(query, Document[]) → string|null`, `SearchResponse.answer?: string`, `LiteLLMClient.chat(params)`/`embeddings(inputs, model)` — used consistently across T5–T11.

**Known sequencing:** T4's `index.ts` imports `HybridSearchProvider` (T9) and `BackfillEmbeddingsTask` (T10) — use the stub note in T4 Step 3, or implement T5–T10 before running the plugin (commit the registration with T9/T10). T9's permission tests are the acceptance gate for the whole feature.
