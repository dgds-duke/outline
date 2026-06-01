import { DocumentEmbedding } from "@server/models";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { buildDocument } from "@server/test/factories";
import { embedDocument, embedQuery } from "./embeddings";

describe("embeddings", () => {
  beforeEach(() => {
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([
      Array.from({ length: 1536 }, () => 0.01),
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("embedDocument upserts a single row (re-embed updates, not duplicates)", async () => {
    const doc = await buildDocument();
    await embedDocument(doc);
    expect(await DocumentEmbedding.count({ where: { documentId: doc.id } })).toEqual(1);
    await embedDocument(doc);
    expect(await DocumentEmbedding.count({ where: { documentId: doc.id } })).toEqual(1);
  });

  it("embedQuery returns a pgvector literal string", async () => {
    const vec = await embedQuery("hello");
    expect(vec.startsWith("[")).toBe(true);
    expect(vec.endsWith("]")).toBe(true);
  });
});
