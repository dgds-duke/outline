import LiteLLMClient from "@server/utils/LiteLLMClient";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import serverEnv from "@server/env";
import { SearchQuery } from "@server/models";
import { sequelize } from "@server/storage/database";
import {
  buildUser,
  buildDocument,
  buildCollection,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import vectorEnv from "plugins/search-vector/server/env";

const server = getTestServer();

describe("#documents.search (vector provider answer)", () => {
  let prevProvider: string;
  let prevAnswerModel: string | undefined;

  beforeEach(() => {
    prevProvider = serverEnv.SEARCH_PROVIDER;
    prevAnswerModel = vectorEnv.LITELLM_ANSWER_MODEL;
    serverEnv.SEARCH_PROVIDER = "vector";
    vectorEnv.LITELLM_ANSWER_MODEL = "test-answer-model";
    SearchProviderManager.reset();
    vi.spyOn(LiteLLMClient, "embeddings").mockResolvedValue([
      Array.from({ length: 1536 }, () => 0.01),
    ]);
    vi.spyOn(LiteLLMClient, "chat").mockResolvedValue("the AI answer");
  });

  afterEach(() => {
    serverEnv.SEARCH_PROVIDER = prevProvider;
    vectorEnv.LITELLM_ANSWER_MODEL = prevAnswerModel;
    SearchProviderManager.reset();
    vi.restoreAllMocks();
  });

  it("returns an answer and persists it to SearchQuery", async () => {
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
    await sequelize.query(
      `INSERT INTO document_embeddings (id,"documentId","teamId",model,embedding,"createdAt","updatedAt")
       VALUES (gen_random_uuid(),:d,:t,'test-model',:e::vector,now(),now())`,
      {
        replacements: {
          d: doc.id,
          t: user.teamId,
          e: `[${Array.from({ length: 1536 }, () => 0.01).join(",")}]`,
        },
      }
    );

    const res = await server.post("/api/documents.search", user, {
      body: { query: "wetlands" },
    });
    expect(res.status).toEqual(200);
    const body = await res.json();
    expect(body.answer).toEqual("the AI answer");
    // The cited source ids are threaded through for client-side citation links.
    expect(body.answerDocumentIds).toContain(doc.id);

    const sq = await SearchQuery.findOne({
      where: { teamId: user.teamId },
      order: [["createdAt", "DESC"]],
    });
    expect(sq?.answer).toEqual("the AI answer");
  });
});
