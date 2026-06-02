import LiteLLMClient from "@server/utils/LiteLLMClient";
import { DocumentEmbedding } from "@server/models";
import { buildDocument, buildDraftDocument } from "@server/test/factories";
import BackfillEmbeddingsTask from "./BackfillEmbeddingsTask";

describe("BackfillEmbeddingsTask", () => {
  beforeEach(() =>
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([
      Array.from({ length: 1536 }, () => 0.01),
    ])
  );
  afterEach(() => vi.restoreAllMocks());

  it("embeds published docs lacking an embedding, skips drafts and already-embedded", async () => {
    const published = await buildDocument();
    const draft = await buildDraftDocument({ teamId: published.teamId });

    await new BackfillEmbeddingsTask().perform({
      limit: 1000,
      partition: { partitionIndex: 0, partitionCount: 1 },
    });

    expect(
      await DocumentEmbedding.count({ where: { documentId: published.id } })
    ).toEqual(1);
    expect(
      await DocumentEmbedding.count({ where: { documentId: draft.id } })
    ).toEqual(0);

    // Running again does not duplicate (already embedded → skipped via NOT IN).
    await new BackfillEmbeddingsTask().perform({
      limit: 1000,
      partition: { partitionIndex: 0, partitionCount: 1 },
    });
    expect(
      await DocumentEmbedding.count({ where: { documentId: published.id } })
    ).toEqual(1);
  });
});
