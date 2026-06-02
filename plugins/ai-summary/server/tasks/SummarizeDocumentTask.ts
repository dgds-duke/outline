import type { SourceMetadata } from "@shared/types";
import documentCreator from "@server/commands/documentCreator";
import documentUpdater from "@server/commands/documentUpdater";
import { createContext } from "@server/context";
import { Attachment, Document, User } from "@server/models";
import DeleteAttachmentTask from "@server/queues/tasks/DeleteAttachmentTask";
import { BaseTask, TaskPriority } from "@server/queues/tasks/base/BaseTask";
import { sequelize } from "@server/storage/database";
import FileStorage from "@server/storage/files";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import env from "../env";
import {
  parseSummary,
  shortenTitle,
  summarizeSystemPrompt,
  summarizeUserInstruction,
} from "../litellm/prompt";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";

type Props = {
  attachmentId: string;
  userId: string;
  ip: string;
};

/**
 * Background task: read an uploaded PDF and summarize it via the LiteLLM proxy.
 *
 * A placeholder draft is created up front (marked `summarizing` so the client
 * shows an in-progress state instead of opening the collaborative editor) and
 * linked to the source attachment, so the uploader sees it in My Drafts
 * immediately. The draft is then filled in with the finished summary, or marked
 * failed. The source PDF is unlinked once done so publishing the summary never
 * exposes the uploaded file. Creating the draft once (reused on retry) keeps the
 * task idempotent.
 */
export default class SummarizeDocumentTask extends BaseTask<Props> {
  /**
   * Summarize the attachment and fill in its draft.
   *
   * @param props the source attachment id, the requesting user id, and the request ip.
   * @returns a promise that resolves once the draft is updated and a notification scheduled.
   */
  public async perform({ attachmentId, userId, ip }: Props) {
    const attachment = await Attachment.findByPk(attachmentId, {
      rejectOnEmpty: true,
    });
    const user = await User.findByPk(userId, { rejectOnEmpty: true });
    const fileName = attachment.name;
    const document = await this.ensureDraft(attachment, user, ip);

    const model = env.LITELLM_SUMMARY_MODEL;
    if (!model) {
      throw new Error("LITELLM_SUMMARY_MODEL is not configured");
    }
    const buffer = await FileStorage.getFileBuffer(attachment.key);
    const raw = await LiteLLMClient.chat({
      model,
      systemPrompt: summarizeSystemPrompt,
      userText: summarizeUserInstruction,
      file: {
        filename: fileName,
        dataUrl: `data:application/pdf;base64,${buffer.toString("base64")}`,
      },
    });
    const { title, body } = parseSummary(raw);

    await sequelize.transaction(async (transaction) => {
      // Clear the "summarizing" lock so the finished draft opens normally.
      document.sourceMetadata = {
        fileName,
        mimeType: attachment.contentType,
      };
      await documentUpdater(createContext({ user, ip, transaction }), {
        document,
        title,
        text: body,
      });
    });

    // The summary is self-contained (it has its own citation), so the source
    // PDF is no longer needed. Delete it rather than orphan it: merely unlinking
    // would leave the file unreachable by every cleanup path (the preset has no
    // expiry and the draft no longer references it) yet still downloadable
    // indefinitely via the attachments redirect.
    await new DeleteAttachmentTask().schedule({
      attachmentId: attachment.id,
      teamId: attachment.teamId,
    });

    await new DraftSummarizedNotificationsTask().schedule({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      status: "completed",
      fileName,
    });
  }

  /**
   * On final failure, clear the lock and mark the placeholder draft failed (so
   * the uploader is not left with a draft stuck on "Summarizing…") and notify
   * them.
   *
   * @param props the original task props.
   * @returns a promise that resolves once the draft is updated and a notification scheduled.
   */
  public async onFailed({ attachmentId, userId, ip }: Props) {
    const [attachment, user] = await Promise.all([
      Attachment.findByPk(attachmentId),
      User.findByPk(userId),
    ]);
    if (!user) {
      return;
    }

    const document = attachment?.documentId
      ? await Document.findByPk(attachment.documentId)
      : null;
    if (attachment && document) {
      await sequelize.transaction(async (transaction) => {
        document.sourceMetadata = {
          fileName: attachment.name,
          mimeType: attachment.contentType,
        };
        await documentUpdater(createContext({ user, ip, transaction }), {
          document,
          text: "_The AI summary could not be generated. Please try uploading the document again._",
        });
      });
    }

    // Delete the source PDF (don't orphan it) — the upload is done with either
    // way.
    if (attachment) {
      await new DeleteAttachmentTask().schedule({
        attachmentId: attachment.id,
        teamId: attachment.teamId,
      });
    }

    await new DraftSummarizedNotificationsTask().schedule({
      userId: user.id,
      teamId: user.teamId,
      documentId: document?.id ?? null,
      status: "failed",
      fileName: attachment ? attachment.name : "your file",
    });
  }

  public get options() {
    return { ...super.options, priority: TaskPriority.Background, attempts: 3 };
  }

  /**
   * Create (or, on retry, reuse) the placeholder draft and link the source
   * attachment to it. The draft is marked `summarizing` so the client locks it
   * (shows an in-progress state rather than the editor) until it is filled in.
   *
   * @param attachment the uploaded source attachment.
   * @param user the requesting user.
   * @param ip the request ip.
   * @returns the placeholder (or existing) draft document.
   */
  private async ensureDraft(
    attachment: Attachment,
    user: User,
    ip: string
  ): Promise<Document> {
    const sourceMetadata: SourceMetadata = {
      fileName: attachment.name,
      mimeType: attachment.contentType,
      summarizing: true,
    };

    return sequelize.transaction(async (transaction) => {
      // Lock the attachment row so two concurrent attempts cannot each create a
      // placeholder draft — the second waits, then reuses the first one's draft.
      const locked = await Attachment.findByPk(attachment.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
        rejectOnEmpty: true,
      });
      if (locked.documentId) {
        const existing = await Document.findByPk(locked.documentId, {
          transaction,
        });
        if (existing) {
          return existing;
        }
      }

      const created = await documentCreator(
        createContext({ user, ip, transaction }),
        {
          title: shortenTitle(`Summarizing ${attachment.name}`),
          text: "_Generating an AI summary… this draft will be ready shortly._",
          publish: false,
          sourceMetadata,
        }
      );
      await locked.update({ documentId: created.id }, { transaction });
      return created;
    });
  }
}
