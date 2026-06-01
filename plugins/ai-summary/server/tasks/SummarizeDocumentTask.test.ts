import { Attachment, Document } from "@server/models";
import { buildUser, buildAttachment } from "@server/test/factories";
import SummarizeDocumentTask from "./SummarizeDocumentTask";

vi.mock("@server/storage/files", () => ({
  default: { getFileBuffer: vi.fn(async () => Buffer.from("%PDF fake")) },
}));

vi.mock("../litellm/LiteLLMClient", () => ({
  default: {
    summarize: vi.fn(async () => ({
      title: "Wetlands Report",
      summaryMarkdown: "## Summary\nfindings",
    })),
  },
}));

describe("SummarizeDocumentTask", () => {
  it("creates a draft in My Drafts and links the source attachment", async () => {
    const user = await buildUser();
    const attachment = await buildAttachment({
      teamId: user.teamId,
      userId: user.id,
      contentType: "application/pdf",
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
  });
});
