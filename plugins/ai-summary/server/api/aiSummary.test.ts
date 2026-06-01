import type { MockInstance } from "vitest";
import {
  buildUser,
  buildViewer,
  buildGuestUser,
  buildAttachment,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import SummarizeDocumentTask from "../tasks/SummarizeDocumentTask";

const server = getTestServer();

describe("#aiSummary.create", () => {
  let scheduleSpy: MockInstance;

  beforeEach(() => {
    scheduleSpy = vi
      .spyOn(SummarizeDocumentTask.prototype, "schedule")
      .mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules summarization for a PDF the user owns", async () => {
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
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: attachment.id, userId: user.id })
    );
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

  it("rejects an attachment owned by another user in the same team", async () => {
    const user = await buildUser();
    const other = await buildUser({ teamId: user.teamId });
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

  it("rejects a viewer who cannot create documents", async () => {
    const viewer = await buildViewer();
    const attachment = await buildAttachment({
      teamId: viewer.teamId,
      userId: viewer.id,
      contentType: "application/pdf",
    });
    const res = await server.post("/api/aiSummary.create", viewer, {
      body: { attachmentId: attachment.id },
    });
    expect(res.status).toEqual(403);
  });

  it("rejects a guest who cannot create documents", async () => {
    const guest = await buildGuestUser();
    const attachment = await buildAttachment({
      teamId: guest.teamId,
      userId: guest.id,
      contentType: "application/pdf",
    });
    const res = await server.post("/api/aiSummary.create", guest, {
      body: { attachmentId: attachment.id },
    });
    expect(res.status).toEqual(403);
  });

  it("returns 404 for an unknown attachment", async () => {
    const user = await buildUser();
    const res = await server.post("/api/aiSummary.create", user, {
      body: { attachmentId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toEqual(404);
  });

  it("requires authentication", async () => {
    const res = await server.post("/api/aiSummary.create", {
      body: { attachmentId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toEqual(401);
  });
});
