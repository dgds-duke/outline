import type { MockInstance } from "vitest";
import { Attachment, Document } from "@server/models";
import FileStorage from "@server/storage/files";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import { buildUser, buildAttachment } from "@server/test/factories";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";
import SummarizeDocumentTask from "./SummarizeDocumentTask";

// Spy on the real singletons (rather than vi.mock) because the plugin's server
// entry point is eagerly loaded by the test setup before module mocks hoist,
// which binds the real modules. Spies intercept the live methods regardless.
describe("SummarizeDocumentTask", () => {
  let scheduleSpy: MockInstance;

  beforeEach(() => {
    vi.spyOn(FileStorage, "getFileBuffer").mockResolvedValue(
      Buffer.from("%PDF fake")
    );
    vi.spyOn(LiteLLMClient, "chat").mockResolvedValue(
      "Title: Wetlands Report\nDOI: none\n\n## Summary\nfindings"
    );
    scheduleSpy = vi
      .spyOn(DraftSummarizedNotificationsTask.prototype, "schedule")
      .mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a draft in My Drafts and links the source attachment", async () => {
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
      acl: "private",
    });

    await new SummarizeDocumentTask().perform({
      attachmentId: attachment.id,
      userId: user.id,
      ip: "127.0.0.1",
    });

    const document = await Document.unscoped().findOne({
      where: { createdById: user.id, publishedAt: null },
      order: [["createdAt", "DESC"]],
    });
    expect(document).toBeTruthy();
    expect(document!.publishedAt).toBeNull();
    expect(document!.collectionId).toBeNull();
    expect(document!.title).toEqual("Wetlands Report");
    expect(document!.text).toContain("attachments.redirect");
    expect(document!.text).toContain("## Summary");

    const reloaded = await Attachment.findByPk(attachment.id);
    expect(reloaded!.documentId).toEqual(document!.id);

    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: document!.id, status: "completed" })
    );
  });

  it("schedules a failure notification when summarization fails", async () => {
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
      acl: "private",
    });

    await new SummarizeDocumentTask().onFailed({
      attachmentId: attachment.id,
      userId: user.id,
      ip: "127.0.0.1",
    });

    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: null,
        status: "failed",
        fileName: attachment.name,
      })
    );
  });
});
