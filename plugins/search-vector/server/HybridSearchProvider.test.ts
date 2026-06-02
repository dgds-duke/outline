import LiteLLMClient from "@server/utils/LiteLLMClient";
import {
  buildUser,
  buildDocument,
  buildCollection,
} from "@server/test/factories";
import { sequelize } from "@server/storage/database";
import env from "./env";
import HybridSearchProvider from "./HybridSearchProvider";

/**
 * Insert (or upsert) a fixed embedding for a document so it becomes a vector
 * candidate. The vector value is irrelevant to these tests — what matters is
 * that the document is returned as a team-scoped candidate so we can assert the
 * permission fence around it.
 */
async function embed(documentId: string, teamId: string) {
  await sequelize.query(
    `INSERT INTO document_embeddings (id,"documentId","teamId",model,embedding,"createdAt","updatedAt")
     VALUES (gen_random_uuid(),:d,:t,'test-model',:e::vector,now(),now())
     ON CONFLICT ("documentId",model) DO UPDATE SET embedding=EXCLUDED.embedding`,
    {
      replacements: {
        d: documentId,
        t: teamId,
        e: `[${Array.from({ length: 1536 }, () => 0.01).join(",")}]`,
      },
    }
  );
}

describe("HybridSearchProvider", () => {
  const provider = new HybridSearchProvider();
  let previousAnswerModel: string | undefined;

  beforeEach(() => {
    // generateAnswer is a no-op unless an answer model is configured; the
    // shared test env does not set one, so enable it here for the happy path.
    previousAnswerModel = env.LITELLM_ANSWER_MODEL;
    env.LITELLM_ANSWER_MODEL = "test-answer-model";
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([
      Array.from({ length: 1536 }, () => 0.01),
    ]);
    vi.spyOn(LiteLLMClient, "chat").mockResolvedValue("an answer");
  });

  afterEach(() => {
    env.LITELLM_ANSWER_MODEL = previousAnswerModel;
    vi.restoreAllMocks();
  });

  it("PERMISSION: never returns a vector hit in a collection the user cannot access", async () => {
    const user = await buildUser();
    const owner = await buildUser({ teamId: user.teamId });
    // A private collection (permission: null) owned by someone else with no
    // membership for `user`, so it is excluded from user.collectionIds().
    const privateCollection = await buildCollection({
      teamId: user.teamId,
      userId: owner.id,
      permission: null,
    });
    const secret = await buildDocument({
      teamId: user.teamId,
      collectionId: privateCollection.id,
      userId: owner.id,
      title: "secret wetlands memo",
    });
    await embed(secret.id, user.teamId);

    const res = await provider.searchForUser(user, { query: "wetlands" });
    expect(res.results.map((r) => r.document.id)).not.toContain(secret.id);
  });

  it("PERMISSION: never returns another team's vector hit", async () => {
    const user = await buildUser();
    // A document on a completely different team.
    const other = await buildDocument({ title: "other team wetlands" });
    await embed(other.id, other.teamId);

    const res = await provider.searchForUser(user, { query: "wetlands" });
    expect(res.results.map((r) => r.document.id)).not.toContain(other.id);
  });

  it("returns an accessible doc and an answer at offset 0", async () => {
    const user = await buildUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const doc = await buildDocument({
      teamId: user.teamId,
      collectionId: collection.id,
      userId: user.id,
      title: "wetlands permitting",
    });
    await embed(doc.id, user.teamId);

    const res = await provider.searchForUser(user, { query: "wetlands" });
    expect(res.results.map((r) => r.document.id)).toContain(doc.id);
    expect(res.answer).toEqual("an answer");
  });

  it("surfaces a vector-only hit (no keyword match) once it passes the access filter", async () => {
    const user = await buildUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    // Title/text deliberately do NOT contain the query term, so the lexical
    // half cannot find it — only the vector candidate path can surface it.
    const doc = await buildDocument({
      teamId: user.teamId,
      collectionId: collection.id,
      userId: user.id,
      title: "riparian zone guidance",
      text: "guidance about shoreline buffers",
    });
    await embed(doc.id, user.teamId);

    const res = await provider.searchForUser(user, {
      query: "wetlands permitting",
    });
    expect(res.results.map((r) => r.document.id)).toContain(doc.id);
  });

  it("degrades to keyword-only results when query embedding fails", async () => {
    vi.spyOn(LiteLLMClient, "embeddings").mockRejectedValue(
      new Error("proxy down")
    );
    const user = await buildUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const doc = await buildDocument({
      teamId: user.teamId,
      collectionId: collection.id,
      userId: user.id,
      title: "wetlands permitting",
    });
    await embed(doc.id, user.teamId);

    // Must not throw; the keyword half still finds the document.
    const res = await provider.searchForUser(user, { query: "wetlands" });
    expect(res.results.map((r) => r.document.id)).toContain(doc.id);
  });

  it("returns results without an answer when answer generation fails", async () => {
    vi.spyOn(LiteLLMClient, "chat").mockRejectedValue(
      new Error("answer model down")
    );
    const user = await buildUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const doc = await buildDocument({
      teamId: user.teamId,
      collectionId: collection.id,
      userId: user.id,
      title: "wetlands permitting",
    });
    await embed(doc.id, user.teamId);

    const res = await provider.searchForUser(user, { query: "wetlands" });
    expect(res.results.map((r) => r.document.id)).toContain(doc.id);
    expect(res.answer).toBeUndefined();
  });
});
