import { SearchableModel } from "@shared/types";
import Logger from "@server/logging/Logger";
import { DocumentEmbedding } from "@server/models";
import type Collection from "@server/models/Collection";
import type Comment from "@server/models/Comment";
import Document from "@server/models/Document";
import type Team from "@server/models/Team";
import type User from "@server/models/User";
import type {
  SearchOptions,
  SearchResponse,
} from "@server/utils/BaseSearchProvider";
import { BaseSearchProvider } from "@server/utils/BaseSearchProvider";
import PostgresSearchProvider from "../../search-postgres/server/PostgresSearchProvider";
import { generateAnswer } from "./rag/answer";
import { embedDocument, embedQuery } from "./vector/embeddings";
import { reciprocalRankFusion } from "./vector/fusion";
import { vectorCandidates } from "./vector/query";

/** Maximum number of vector candidates to retrieve before access filtering. */
const CANDIDATE_LIMIT = 100;

/** Number of top fused documents to ground the AI answer in. */
const ANSWER_TOP_K = 5;

/** Default page size when none is supplied. */
const DEFAULT_LIMIT = 25;

type FusedResult = {
  ranking: number;
  context?: string;
  document: Document;
};

/**
 * Hybrid search provider combining PostgreSQL keyword search with pgvector
 * semantic search, optionally producing a grounded AI answer.
 *
 * The vector half performs NO authorization. It only generates team-scoped
 * candidate document ids, which are then routed through
 * `PostgresSearchProvider.searchForUser({ documentIds })` so that Outline's
 * exact access rules (collection access, doc/group memberships, drafts, status)
 * are applied. Only documents that call returns are ever surfaced — a vector
 * match can therefore never reveal a document the user is not allowed to see.
 *
 * All other operations (team search, title search, collection search) delegate
 * directly to the lexical provider.
 */
export default class HybridSearchProvider extends BaseSearchProvider {
  public id = "vector";

  private lexical = new PostgresSearchProvider();

  /**
   * Perform a hybrid keyword + vector search scoped to a user's accessible
   * documents, with an optional grounded answer on the first page.
   *
   * @param user - the user performing the search.
   * @param options - search options.
   * @returns search results with ranking, context, and an optional answer.
   */
  public async searchForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    if (!options.query) {
      return this.lexical.searchForUser(user, options);
    }

    // Keyword half — already permission-correct, ranked, and snippeted. Fetch
    // the full candidate set at offset 0 (NOT the caller's page) so fusion sees
    // the complete lexical ranking. The fused list is paginated exactly once
    // below; paginating here as well would double-paginate (page 2+ would slice
    // an already-sliced list and drop/misalign results).
    const lexical = await this.lexical.searchForUser(user, {
      ...options,
      limit: CANDIDATE_LIMIT,
      offset: 0,
    });

    // Vector half — team-scoped candidates that are then access-filtered by
    // routing their ids back through the lexical provider (the single permission
    // fence: ids the access filter drops are never surfaced). On any embedding
    // or proxy failure we degrade to keyword-only results rather than failing
    // the whole search.
    let vectorIds: string[] = [];
    const accessibleById = new Map<string, Document>();
    try {
      const queryVector = await embedQuery(options.query);
      let candidateIds = (
        await vectorCandidates(user.teamId, queryVector, CANDIDATE_LIMIT)
      ).map((candidate) => candidate.documentId);

      // Honour a caller-supplied documentIds scope for the vector half too.
      if (options.documentIds) {
        const scope = new Set(options.documentIds);
        candidateIds = candidateIds.filter((id) => scope.has(id));
      }

      if (candidateIds.length) {
        const accessible = await this.lexical.searchForUser(user, {
          ...options,
          query: undefined,
          documentIds: candidateIds,
          limit: candidateIds.length,
          offset: 0,
        });
        for (const result of accessible.results) {
          accessibleById.set(result.document.id, result.document);
        }
        // Preserve vector similarity order, keeping only access-permitted ids.
        vectorIds = candidateIds.filter((id) => accessibleById.has(id));
      }
    } catch (err) {
      Logger.warn("Vector search half failed; degrading to keyword-only", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fuse the two ranked id lists into a single ranking.
    const lexicalById = new Map(
      lexical.results.map((result) => [result.document.id, result])
    );
    const fusedIds = reciprocalRankFusion([
      lexical.results.map((result) => result.document.id),
      vectorIds,
    ]);

    const fused: FusedResult[] = [];
    fusedIds.forEach((id, index) => {
      const lex = lexicalById.get(id);
      const document = lex?.document ?? accessibleById.get(id);
      if (!document) {
        return;
      }
      fused.push({
        ranking: lex?.ranking ?? 1 / (index + 1),
        context: lex?.context,
        document,
      });
    });

    const limit = options.limit ?? DEFAULT_LIMIT;
    const offset = options.offset ?? 0;
    const page = fused.slice(offset, offset + limit);

    // Ask AI on the first page only; a generation failure must never fail the
    // search — results are returned without an answer.
    let answer: string | undefined;
    if (offset === 0) {
      try {
        const generated = await generateAnswer(
          options.query,
          fused.slice(0, ANSWER_TOP_K).map((result) => result.document)
        );
        answer = generated ?? undefined;
      } catch (err) {
        Logger.warn(
          "Answer generation failed; returning results without an answer",
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
    }

    // `total` is the fused candidate count (keyword results + access-permitted
    // vector candidates, capped by CANDIDATE_LIMIT), not a corpus-wide count.
    return { results: page, total: fused.length, answer };
  }

  /**
   * Perform a keyword search scoped to a team (used for shared document search).
   * No vector search or answer is performed for anonymous/shared contexts.
   *
   * @param team - the team to search within.
   * @param options - search options.
   * @returns keyword search results.
   */
  public async searchForTeam(
    team: Team,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    return this.lexical.searchForTeam(team, options);
  }

  /**
   * Search document titles for a user. Delegates to the lexical provider.
   *
   * @param user - the user performing the search.
   * @param options - search options.
   * @returns matching documents.
   */
  public searchTitlesForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<Document[]> {
    return this.lexical.searchTitlesForUser(user, options);
  }

  /**
   * Search collections for a user. Delegates to the lexical provider.
   *
   * @param user - the user performing the search.
   * @param options - search options.
   * @returns matching collections.
   */
  public searchCollectionsForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<Collection[]> {
    return this.lexical.searchCollectionsForUser(user, options);
  }

  /**
   * Index a searchable item by generating and storing its embedding. Only
   * published documents are embedded; other models and unpublished documents
   * are ignored.
   *
   * @param model - the type of model being indexed.
   * @param item - the model instance to index.
   */
  public async index(
    model: SearchableModel,
    item: Document | Collection | Comment
  ): Promise<void> {
    if (model !== SearchableModel.Document || !(item instanceof Document)) {
      return;
    }
    if (!item.publishedAt) {
      return;
    }
    await embedDocument(item);
  }

  /**
   * Remove a document's embeddings from the vector index.
   *
   * @param _model - the type of model being removed (unused).
   * @param id - the id of the document to remove.
   * @param _teamId - the team id the item belongs to (unused).
   */
  public async remove(
    _model: SearchableModel,
    id: string,
    _teamId: string
  ): Promise<void> {
    await DocumentEmbedding.destroy({ where: { documentId: id } });
  }

  /**
   * No-op — access and metadata are enforced at query time via the lexical
   * provider, so there is no separate metadata to maintain.
   *
   * @param _model - the type of model being updated (unused).
   * @param _id - the id of the item to update (unused).
   * @param _metadata - the metadata fields to update (unused).
   */
  public async updateMetadata(
    _model: SearchableModel,
    _id: string,
    _metadata: Record<string, unknown>
  ): Promise<void> {
    // Access/metadata enforced at query time via the lexical provider.
  }
}
