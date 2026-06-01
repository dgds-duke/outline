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
      {
        replacements: {
          documentId: doc.id,
          teamId: doc.teamId,
          model: "test-model",
          embedding: vec,
        },
      }
    );
    const row = await DocumentEmbedding.findOne({
      where: { documentId: doc.id },
    });
    expect(row?.model).toEqual("test-model");
    expect(row?.teamId).toEqual(doc.teamId);
  });
});
