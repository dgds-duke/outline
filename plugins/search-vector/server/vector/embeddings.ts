import type Document from "@server/models/Document";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { sequelize } from "@server/storage/database";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import env from "../env";

/** Format a number[] as a pgvector literal, e.g. "[0.1,0.2,...]". */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Embed the query string and return a pgvector literal for use in raw SQL.
 *
 * @param query - the search query text.
 * @returns the query embedding as a pgvector literal string.
 */
export async function embedQuery(query: string): Promise<string> {
  const [vector] = await LiteLLMClient.embeddings(
    [query],
    env.LITELLM_EMBEDDING_MODEL
  );
  return toVectorLiteral(vector);
}

/**
 * Embed a document's title + plain text and upsert the embedding row
 * (one per document + model).
 *
 * @param document - the document to embed.
 * @returns a promise that resolves once the embedding is stored.
 */
export async function embedDocument(document: Document): Promise<void> {
  const text = `${document.title}\n\n${DocumentHelper.toPlainText(document)}`.slice(0, 30000);
  const [vector] = await LiteLLMClient.embeddings(
    [text],
    env.LITELLM_EMBEDDING_MODEL
  );
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
