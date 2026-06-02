import { SearchableModel } from "@shared/types";
import { DocumentEmbedding } from "@server/models";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { buildDocument, buildDraftDocument } from "@server/test/factories";
import HybridSearchProvider from "./HybridSearchProvider";

describe("HybridSearchProvider.index/remove", () => {
  const provider = new HybridSearchProvider();

  beforeEach(() => {
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([
      Array.from({ length: 1536 }, () => 0.01),
    ]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("embeds a published document and skips drafts", async () => {
    const published = await buildDocument();
    await provider.index(SearchableModel.Document, published);
    expect(
      await DocumentEmbedding.count({ where: { documentId: published.id } })
    ).toEqual(1);

    const draft = await buildDraftDocument({ teamId: published.teamId });
    await provider.index(SearchableModel.Document, draft);
    expect(
      await DocumentEmbedding.count({ where: { documentId: draft.id } })
    ).toEqual(0);
  });

  it("remove deletes the embedding", async () => {
    const doc = await buildDocument();
    await provider.index(SearchableModel.Document, doc);
    await provider.remove(SearchableModel.Document, doc.id, doc.teamId);
    expect(
      await DocumentEmbedding.count({ where: { documentId: doc.id } })
    ).toEqual(0);
  });
});
