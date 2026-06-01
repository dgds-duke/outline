import { QueryTypes } from "sequelize";
import { sequelize } from "@server/storage/database";

export type VectorCandidate = { documentId: string; similarity: number };

/**
 * Team-scoped vector nearest-neighbours over document_embeddings. Returns
 * candidate document ids ordered by cosine similarity (highest first).
 *
 * NOTE: this performs NO permission filtering — callers MUST pass the returned
 * ids through PostgresSearchProvider.searchForUser({ documentIds }) to apply
 * document-level access rules before showing them to a user.
 *
 * @param teamId the team to scope candidates to.
 * @param queryVector the query embedding as a pgvector literal (e.g. "[0.1,...]").
 * @param limit the maximum number of candidates to return.
 * @returns candidate document ids with cosine similarity, best first.
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
