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
    expect(ids).not.toContain(other.id);   // team isolation
    expect(ids[0]).toEqual(near.id);       // most similar first
    expect(out[0].similarity).toBeGreaterThan(out[1]?.similarity ?? -Infinity);
  });
});
