import type { MockInstance } from "vitest";
import { Document } from "@server/models";
import FileStorage from "@server/storage/files";
import DeleteAttachmentTask from "@server/queues/tasks/DeleteAttachmentTask";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import {
  buildUser,
  buildAttachment,
  buildDraftDocument,
} from "@server/test/factories";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";
import SummarizeDocumentTask from "./SummarizeDocumentTask";

// Spy on the real singletons (rather than vi.mock) because the plugin's server
// entry point is eagerly loaded by the test setup before module mocks hoist,
// which binds the real modules. Spies intercept the live methods regardless.
describe("SummarizeDocumentTask", () => {
  let scheduleSpy: MockInstance;
  let deleteSpy: MockInstance;

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
    deleteSpy = vi
      .spyOn(DeleteAttachmentTask.prototype, "schedule")
      .mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A standalone PDF upload. The factory auto-links a document, but the real
   * upload flow does not, so detach it to mirror reality.
   */
  async function buildSourcePdf(userId: string, teamId: string) {
    const attachment = await buildAttachment({
      teamId,
      userId,
      contentType: "application/pdf",
      acl: "private",
    });
    await attachment.update({ documentId: null });
    return attachment;
  }

  it("fills the draft, clears the lock, and deletes the source PDF", async () => {
    const user = await buildUser();
    const attachment = await buildSourcePdf(user.id, user.teamId);

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
    expect(document!.title).toEqual("Wetlands Report");
    expect(document!.text).toContain("## Summary");
    // The summary stands alone — no source-PDF link embedded.
    expect(document!.text).not.toContain("attachments.redirect");
    // The lock is cleared so the draft opens normally.
    expect(document!.sourceMetadata?.summarizing).toBeFalsy();

    // The source PDF is deleted (not orphaned) so it can neither be published
    // nor lingered indefinitely.
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: attachment.id })
    );

    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: document!.id, status: "completed" })
    );
  });

  it("creates the placeholder draft locked (summarizing) before completion", async () => {
    vi.spyOn(LiteLLMClient, "chat").mockRejectedValue(new Error("proxy down"));
    const user = await buildUser();
    const attachment = await buildSourcePdf(user.id, user.teamId);

    // perform throws when summarization fails, leaving the placeholder behind.
    await expect(
      new SummarizeDocumentTask().perform({
        attachmentId: attachment.id,
        userId: user.id,
        ip: "127.0.0.1",
      })
    ).rejects.toThrow();

    const document = await Document.unscoped().findOne({
      where: { createdById: user.id, publishedAt: null },
      order: [["createdAt", "DESC"]],
    });
    expect(document!.sourceMetadata?.summarizing).toBe(true);
  });

  it("schedules a failure notification when summarization fails", async () => {
    const user = await buildUser();
    const attachment = await buildSourcePdf(user.id, user.teamId);

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

  it("reuses an already-linked draft instead of creating a new one", async () => {
    const user = await buildUser();
    const existing = await buildDraftDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
      acl: "private",
    });
    await attachment.update({ documentId: existing.id });

    await new SummarizeDocumentTask().perform({
      attachmentId: attachment.id,
      userId: user.id,
      ip: "127.0.0.1",
    });

    const drafts = await Document.unscoped().findAll({
      where: { createdById: user.id, publishedAt: null },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toEqual(existing.id);
    expect(drafts[0].title).toEqual("Wetlands Report");
  });
});
