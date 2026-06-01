import { buildUser, buildAttachment } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import SummarizeDocumentTask from "../tasks/SummarizeDocumentTask";

const server = getTestServer();

describe("#aiSummary.create", () => {
  it("schedules summarization for a PDF the user owns", async () => {
    const spy = vi
      .spyOn(SummarizeDocumentTask.prototype, "schedule")
      .mockResolvedValue({} as never);
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
    });

    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: attachment.id },
    });

    expect(res.status).toEqual(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: attachment.id, userId: user.id })
    );
    spy.mockRestore();
  });

  it("rejects a non-PDF attachment", async () => {
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "image/png",
    });
    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: attachment.id },
    });
    expect(res.status).toEqual(400);
  });

  it("rejects an attachment from another team", async () => {
    const user = await buildUser();
    const other = await buildUser();
    const attachment = await buildAttachment({
      teamId: other.teamId,
      userId: other.id,
      contentType: "application/pdf",
    });
    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: attachment.id },
    });
    expect(res.status).toEqual(403);
  });

  it("requires authentication", async () => {
    const res = await server.post("/api/aiSummary.create", {
      body: { attachmentId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toEqual(401);
  });
});
