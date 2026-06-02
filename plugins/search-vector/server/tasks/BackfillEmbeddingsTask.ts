import { Op, literal } from "sequelize";
import Logger from "@server/logging/Logger";
import { Document } from "@server/models";
import type { Props } from "@server/queues/tasks/base/CronTask";
import { CronTask, TaskInterval } from "@server/queues/tasks/base/CronTask";
import { embedDocument } from "../vector/embeddings";
import env from "../env";

/**
 * Cron task that backfills vector embeddings for all published documents that
 * do not yet have a row in the `document_embeddings` table for the currently
 * configured embedding model.
 *
 * The task is idempotent — `embedDocument` performs an upsert, so re-running
 * it never creates duplicate rows. Documents are processed sequentially to
 * avoid saturating the embedding API.
 */
export default class BackfillEmbeddingsTask extends CronTask {
  /**
   * Run once per day, spread over a 30-minute window to avoid thundering herd.
   */
  public get cron() {
    return {
      interval: TaskInterval.Day,
    };
  }

  /**
   * Find published, non-deleted, non-archived documents that lack an embedding
   * row (for the current model) and embed them up to `limit`.
   *
   * @param props - task properties including the batch limit and optional partition.
   */
  public async perform({ limit, partition }: Props): Promise<void> {
    const model = env.LITELLM_EMBEDDING_MODEL;

    Logger.info(
      "task",
      `BackfillEmbeddingsTask: backfilling up to ${limit} documents (model=${model})`
    );

    const documents = await Document.findAll({
      where: {
        publishedAt: { [Op.ne]: null },
        archivedAt: { [Op.eq]: null },
        // Only documents that do NOT already have an embedding for this model.
        id: {
          [Op.notIn]: literal(
            `(SELECT "documentId" FROM document_embeddings WHERE model = '${model.replace(/'/g, "''")}')`
          ),
        },
        ...this.getPartitionWhereClause("id", partition),
      },
      limit,
    });

    Logger.info(
      "task",
      `BackfillEmbeddingsTask: found ${documents.length} document(s) to embed`
    );

    for (const document of documents) {
      try {
        await embedDocument(document);
      } catch (err) {
        Logger.warn(
          `BackfillEmbeddingsTask: failed to embed document ${document.id}`,
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
    }
  }
}
