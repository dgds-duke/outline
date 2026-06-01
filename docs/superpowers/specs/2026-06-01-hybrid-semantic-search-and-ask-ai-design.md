# Feature #2 — Hybrid semantic search + Ask AI

- **Date:** 2026-06-01
- **Status:** Approved design, ready for implementation planning
- **Project:** Outline fork for Duke's Environmental Law & Policy Clinic (ELPC)
- **Builds on:** Feature #1 (`plugins/ai-summary`) — reuses the LiteLLM proxy client.

## 1. Goal & context

Replace Outline's keyword-only search with **semantic, meaning-aware search** over the clinic's wiki, and add an **"Ask AI" answer box** that synthesizes a cited answer from the most relevant documents. Both are delivered in one combined build.

The clinic's content is dominated by the **structured AI summaries** produced by feature #1 (short, a few hundred words each). Search must understand concepts ("wetland mitigation banking") *and* exact terms a legal researcher relies on ("Clean Water Act §404", a docket number) — hence a **hybrid** of vector similarity and keyword search. Answers must be **grounded in and cite the wiki**, never invent law.

This is packaged as a new search-provider plugin (`plugins/search-vector`) selected via `SEARCH_PROVIDER`, plus a `document_embeddings` table (pgvector), a shared LiteLLM client (promoted out of feature #1), and a small extension of the `documents.search` response to carry the answer.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Semantic **ranking + Ask AI**, one combined spec | User chose to design/build both together. |
| Vector store | **pgvector** — `vector(1536)` column + HNSW index | The proper, scalable tool; Duke controls the Postgres. |
| Matching | **Hybrid**: keyword (existing tsvector provider) + vector, **Reciprocal Rank Fusion** | Legal content needs exact-term precision AND concepts. |
| Granularity | **Whole-document** embeddings; doc-level citations | Fits the short summaries; simplest data model. |
| Ask AI trigger | **Inline** with each full search, **offset 0 only** | One request; guarded to control cost/latency. |
| What to embed | **Published documents only** | Drafts stay findable via the keyword half; cleaner permissions, less churn. |
| LiteLLM client | **Promote to shared** `server/utils/LiteLLMClient.ts`; `LITELLM_BASE_URL`/`LITELLM_API_KEY` to core `server/env.ts` (model names stay per-feature); add `embeddings()`; refactor feature #1 to import it | One source of truth for the proxy. |
| Embedding model | `text-embedding-3-small` (1536 dims), via `LITELLM_EMBEDDING_MODEL` | Cheap, sufficient; dimension must match the `vector(n)` column. |
| Answer model | GPT-5.x via the proxy (reuse the chat client) | Same proxy as feature #1. |

## 3. Non-goals (v1)

- Chunked/passage-level embeddings (whole-doc only; chunking is a future quality upgrade).
- Embedding drafts, comments, or collections (documents only; titles/collections keep using the keyword provider).
- Answer **streaming** (v1 returns results+answer together; streaming is a follow-up to mask latency).
- An external vector database (pgvector in the existing Postgres).
- Generating answers on as-you-type title search, anonymous/shared search, or pagination (offset > 0).
- Cross-team semantic search (strict team isolation, as today).

## 4. Architecture

A new **`plugins/search-vector`** plugin registers a `Hook.SearchProvider` whose value is a **`HybridSearchProvider`** instance (`id: "vector"`), activated when `SEARCH_PROVIDER=vector`. It **composes the existing `PostgresSearchProvider`** for the keyword half and the permission filtering, and adds a pgvector similarity half, fusing the two. Indexing, the search route, pagination, the result presenter, and search-history recording are all unchanged except for one additive `answer` field.

### 4.1 The permission fence (most important property)

A vector match must **never** surface a document the user cannot already see. Two layers guarantee this:

1. The **keyword half is `PostgresSearchProvider`** — already permission-perfect; its results are inherently safe.
2. The **vector half is constrained to the exact set of document IDs the user may access.** Before the similarity query, the provider computes the accessible-document set using Outline's *own* access logic (the same `User.collectionIds()` + document/group membership + draft rules that `PostgresSearchProvider.buildWhere` uses), and the pgvector query is `… WHERE "documentId" IN (<accessible ids>) AND "teamId" = :teamId`. No parallel auth logic is invented.

> Implementation note (verify in planning): the cleanest reuse is to run the vector similarity over `document_embeddings` joined to a permission-filtered `documents` subquery built from the *same* `buildWhere`/access query the Postgres provider uses, rather than re-deriving access. Confirm whether `PostgresSearchProvider`'s access where-clause can be reused directly or should be extracted into a small shared helper (`accessibleDocumentScope(user, options)`).

### 4.2 Components

**Create — `plugins/search-vector/`:**

| File | Role |
|---|---|
| `plugin.json` | manifest, `id: "vector"` (must equal `provider.id`) |
| `server/index.ts` | register `Hook.SearchProvider` (provider instance) + `Hook.Task` (backfill); gated on `SEARCH_PROVIDER==="vector"` + LiteLLM configured |
| `server/env.ts` | `LITELLM_EMBEDDING_MODEL` (default `text-embedding-3-small`; must be 1536-dim to match the column), `LITELLM_ANSWER_MODEL` (default the chat model), `@Public AI_SEARCH_ENABLED` |
| `server/HybridSearchProvider.ts` | extends `BaseSearchProvider`; composes `PostgresSearchProvider`; implements `searchForUser`/`searchForTeam` (hybrid + answer), delegates `searchTitlesForUser`/`searchCollectionsForUser` to lexical, implements `index`/`remove`/`updateMetadata` |
| `server/vector/embeddings.ts` | `embedDocument(document)`: `DocumentHelper.toPlainText` → `LiteLLMClient.embeddings()` → upsert `DocumentEmbedding`; `embedQuery(text)` for searches |
| `server/vector/query.ts` | the pgvector cosine query (raw SQL via `sequelize.query`), constrained to accessible doc IDs; returns `{documentId, similarity}[]` |
| `server/vector/fusion.ts` | Reciprocal Rank Fusion of lexical + vector result lists → ranked doc order |
| `server/rag/answer.ts` | `generateAnswer(query, topDocs)`: build a grounded prompt from the top-k fused docs → `LiteLLMClient.chat` → `{ answer, citedDocumentIds }` |
| `server/rag/prompt.ts` | the RAG system prompt (answer only from provided sources; cite; say "not found" when unsupported) |
| `server/tasks/BackfillEmbeddingsTask.ts` | `CronTask` (and/or one-off) that embeds published docs missing/stale embeddings, in batches |
| `*.test.ts` | collocated tests |

**Create/modify — core & shared:**

| File | Change |
|---|---|
| `server/models/DocumentEmbedding.ts` + migration | new table; `CREATE EXTENSION vector`; `documentId`/`teamId` FKs (cascade), `embedding vector(1536)`, `model`, timestamps; **HNSW** index `vector_cosine_ops`; unique `(documentId, model)` |
| `server/utils/LiteLLMClient.ts` (new, shared) | move feature #1's client here; add `embeddings(input): Promise<number[][]>` (POST `${base}/embeddings`); keep `summarize`/chat |
| `server/env.ts` | move `LITELLM_BASE_URL`/`LITELLM_API_KEY` here from the ai-summary plugin env (+ a shared model var) so both plugins read them |
| `plugins/ai-summary/server/env.ts` + client/usage | refactor to consume the shared client + core env; `AI_SUMMARY_ENABLED` derives from core LiteLLM config |
| `server/utils/BaseSearchProvider.ts` | add `answer?: string` (and `answerDocumentIds?: string[]`) to `SearchResponse` |
| `server/routes/api/documents/documents.ts` | `documents.search`: pass `response.answer` into the API response; record it in `SearchQuery.answer` at offset 0 |
| `app/types.ts`, `app/scenes/Search/*`, search store | render an **AI answer panel** (reusing the existing enterprise i18n strings: "AI answers", "Search or ask a question", "AI generated answer…") above results; consume the new `answer` field |
| `docker-compose.yml` | postgres image → `pgvector/pgvector` |
| `.env.sample`, `.env.test` | `SEARCH_PROVIDER`, `LITELLM_EMBEDDING_MODEL`; test DB uses the pgvector image |

## 5. Data model — `document_embeddings`

One row per published document (per embedding model). pgvector `vector(1536)`; HNSW index with `vector_cosine_ops`. `documentId`+`teamId` FKs with `ON DELETE CASCADE`. Unique `(documentId, model)` so re-embedding upserts. Stored in a **separate table** (not on `documents`) to keep the core schema clean and allow model/version changes. Migration creates the extension (`CREATE EXTENSION IF NOT EXISTS vector`, mirroring the existing `unaccent`/`pg_trgm` extension migrations).

> Sequelize has no native `vector` type — the column is created via raw SQL (`Sequelize.literal("vector(1536)")` / raw `ALTER`), and similarity queries use `sequelize.query` with the `<=>` cosine-distance operator. The model maps `embedding` as a string/`TEXT`-ish attribute that we set/read via raw SQL, not via normal Sequelize `create`.

## 6. Indexing pipeline

- **On write:** `SearchIndexProcessor` already calls `provider.index(model, item)` / `remove` / `updateMetadata` for non-Postgres providers on document events (publish, delayed-update, archive, delete, move). `HybridSearchProvider.index()` re-embeds **published** documents and upserts; `remove()` deletes the embedding; `updateMetadata()` is a no-op for the vector half (permission/metadata is enforced at query time). Re-embed only when the text changed (compare a hash) to limit LLM calls; rely on the debounced `documents.update.delayed` event.
- **Backfill:** `BackfillEmbeddingsTask` (CronTask) embeds published docs that have no current embedding (e.g., after enabling the feature or importing content), in batches with the embeddings API.
- **Text source:** `DocumentHelper.toPlainText(document)` (the same helper the Postgres provider uses for snippets) prefixed with the title.

> Verify in planning: the exact `SearchIndexProcessor` event list + the precise `index()/remove()/updateMetadata()` call signatures, and the `CronTask` base + cron registration.

## 7. Search & ranking flow

`documents.search` → `SearchProviderManager.getProvider()` (now the hybrid) → `searchForUser(user, options)`:

1. Compute `accessibleScope` (permission fence, §4.1).
2. **Lexical:** `PostgresSearchProvider.searchForUser(user, options)` → ranked list A (already scoped + snippeted).
3. **Vector:** `embedQuery(options.query)` → pgvector cosine over `document_embeddings` constrained to `accessibleScope` → ranked list B (`{documentId, similarity}`).
4. **Fuse:** Reciprocal Rank Fusion of A and B → a single ranked document order; hydrate documents; carry lexical snippets/context where present; apply the existing popularity boost convention. Page by `limit/offset`; `total` = fused distinct count.
5. **Ask AI (offset 0, authenticated, query present, configured):** take the top-k fused docs → `generateAnswer` → `{ answer, citedDocumentIds }`. On failure/timeout, omit the answer.
6. Return `SearchResponse { results, total, answer? }`.

`searchForTeam` (shared/anonymous) = hybrid ranking **without** answer generation. `searchTitlesForUser` / `searchCollectionsForUser` delegate to `PostgresSearchProvider` (titles/collections don't need vectors).

## 8. Ask AI (RAG) details

- **Retrieve → generate → cite:** the prompt instructs the model to answer **only** from the supplied documents, cite them by reference, and explicitly say when the wiki doesn't contain the answer (no outside law, no hallucination). Each supplied doc carries its id/title so citations map back to real documents (`answerDocumentIds`).
- **Response shape:** `answer` (markdown) + the cited document ids; the route returns these and persists `answer` to `SearchQuery.answer` (column exists). The client renders an answer panel with clickable source links above the ranked results.
- **Latency/cost guards:** only at offset 0 on authenticated full-search; configurable; designed so streaming can be added later without changing the contract.

## 9. Shared LiteLLM client refactor

Move feature #1's `plugins/ai-summary/server/litellm/*` to a shared `server/utils/LiteLLMClient.ts`; move only the connection config — `LITELLM_BASE_URL` and `LITELLM_API_KEY` — to core `server/env.ts`. **Model names stay per-feature** (ai-summary keeps `LITELLM_SUMMARY_MODEL`; search-vector adds `LITELLM_EMBEDDING_MODEL` + `LITELLM_ANSWER_MODEL`), passed to the client per call. Add `embeddings(inputs: string[], model: string): Promise<number[][]>` (POST `${base}/embeddings`, OpenAI-compatible). Refactor `ai-summary` to import the shared client and derive `AI_SUMMARY_ENABLED` from the core connection config + its summary model. Keep feature #1 tests green (adjust import paths/mocks).

## 10. Config, gating & deployment

- `SEARCH_PROVIDER=vector` activates the hybrid provider (unset/`postgres` = stock search; the plugin loads but isn't selected → fully safe to ship dark).
- Embedding + answer require the LiteLLM config (shared core env). `@Public AI_SEARCH_ENABLED` gates the client answer-panel UI.
- **Deployment requirement:** the Postgres must have the `vector` extension. Dev/test use the `pgvector/pgvector` image; production Postgres must run `CREATE EXTENSION vector` (documented in `.env.sample`/README note).
- Embedding dimension is fixed by the model and must equal the `vector(n)` column; changing models requires a migration + re-backfill.

## 11. Error handling

- Embeddings API failure at index time → log + Bull retry; the doc is simply absent from the vector half until it succeeds — **keyword search still finds it**, so search never breaks.
- Answer generation failure/timeout → results returned **without** an answer.
- pgvector missing at startup → the provider/migration fails loudly with a clear message; `SEARCH_PROVIDER` unset remains safe.
- A query embedding failure → fall back to lexical-only results for that search (degrade, don't error).

## 12. Security & correctness

- **Permission fence (§4.1) is the headline requirement** — covered by dedicated tests (a vector hit must never leak a doc across collection, membership, team, or draft boundaries).
- Team isolation in every embedding query (`teamId` filter + accessible-id constraint).
- The RAG prompt is grounded and instructed not to answer beyond the provided (already access-filtered) sources, so the answer cannot reveal content the user couldn't retrieve.
- Proxy key stays server-only (core env), never `@Public`, never logged.

## 13. Testing

- **Permission-correctness (critical):** mirror `PostgresSearchProvider`'s access tests for the vector path — cross-collection, no-membership, other-team, other-user's-draft must never appear.
- Rank-fusion ordering (RRF) on known inputs.
- `embeddings.ts` upsert/remove + `index()/remove()` behavior (LiteLLM mocked, real pgvector test DB).
- Backfill task embeds only published docs missing embeddings.
- `generateAnswer` assembles a grounded prompt and returns citations (LLM mocked); `documents.search` carries `answer` and records `SearchQuery.answer` at offset 0 only.
- Shared `LiteLLMClient.embeddings()` request shape (mocked fetch); feature #1 tests still green after the refactor.
- Mock external LiteLLM in `__mocks__`; never call the real proxy in tests.

## 14. Open questions / verify during planning

- Exact reuse mechanism for the access filter (reuse `PostgresSearchProvider.buildWhere` vs extract `accessibleDocumentScope` helper).
- `SearchIndexProcessor` exact events + `index()/remove()/updateMetadata()` signatures; `CronTask` base + registration.
- `DocumentHelper.toPlainText` signature; whether to include the title and which fields.
- Precise `documents.search` response object and where to inject `answer`; client search store/scene wiring + which existing component renders the answer panel.
- pgvector availability for the test harness (the `pgvector/pgvector` image) and how raw `vector` columns round-trip through Sequelize in queries.
- RRF constant (k≈60) and how the existing popularity boost composes with fused ranks.
- Re-embed change-detection (text hash) location.

## 15. Key reference files (from exploration)

- Provider contract: `server/utils/BaseSearchProvider.ts`, `server/utils/SearchProviderManager.ts`, `server/utils/PluginManager.ts`, `plugins/search-postgres/server/index.ts`.
- Permission filtering to reuse: `plugins/search-postgres/server/PostgresSearchProvider.ts` (`buildWhere` ~607-791, `searchForUser` ~376-464), `server/models/User.ts` `collectionIds()`, `server/models/Document.ts` withMembership scope.
- Search route/answer: `server/routes/api/documents/documents.ts` `documents.search` (~1090-1246), `server/models/SearchQuery.ts` (`answer` column), `server/presenters/searchQuery.ts`.
- pgvector/migrations: `server/migrations/20240912222438-add-unaccent-extension.js`, `server/migrations/20160711071958-search-index.js`, `server/models/DocumentInsight.ts` (related-table pattern), `server/models/base/IdModel.ts`.
- LiteLLM client (to promote): `plugins/ai-summary/server/litellm/LiteLLMClient.ts`, `plugins/ai-summary/server/env.ts`.
- Enterprise AI-answer UI strings: `plugins/enterprise/client/translations.tsx`; gated toggle `app/scenes/Settings/Features.tsx`.
