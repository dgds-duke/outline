import type { SourceMetadata } from "@shared/types";
import { escape } from "@shared/utils/markdown";
import documentCreator from "@server/commands/documentCreator";
import documentUpdater from "@server/commands/documentUpdater";
import { createContext } from "@server/context";
import { Attachment, Document, User } from "@server/models";
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
 * A placeholder draft is created up front and linked to the source attachment,
 * so the uploader sees the in-progress summary in My Drafts immediately. The
 * draft is then updated in place with the finished summary, or marked failed if
 * it could not be generated. Creating the draft once (reused on retry) keeps the
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
    const sourceLine = SummarizeDocumentTask.sourceLine(attachment);
    const document = await this.ensureDraft(attachment, user, ip, sourceLine);

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
      await documentUpdater(createContext({ user, ip, transaction }), {
        document,
        title,
        text: sourceLine + body,
      });
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
   * On final failure, mark the placeholder draft as failed (so the uploader is
   * not left with a perpetual "Summarizing…" draft) and notify them.
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
        await documentUpdater(createContext({ user, ip, transaction }), {
          document,
          text:
            SummarizeDocumentTask.sourceLine(attachment) +
            "_The AI summary could not be generated. Please try uploading the document again._",
        });
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

  /** The blockquote line linking the draft back to the uploaded source PDF. */
  private static sourceLine(attachment: Attachment): string {
    return `> **Source:** [${escape(attachment.name)}](${Attachment.getRedirectUrl(
      attachment.id
    )})\n\n`;
  }

  /**
   * Create (or, on retry, reuse) the placeholder draft and link the source
   * attachment to it.
   *
   * @param attachment the uploaded source attachment.
   * @param user the requesting user.
   * @param ip the request ip.
   * @param sourceLine the rendered source link line.
   * @returns the placeholder (or existing) draft document.
   */
  private async ensureDraft(
    attachment: Attachment,
    user: User,
    ip: string,
    sourceLine: string
  ): Promise<Document> {
    const sourceMetadata: Pick<
      Required<SourceMetadata>,
      "fileName" | "mimeType"
    > = {
      fileName: attachment.name,
      mimeType: attachment.contentType,
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
          text:
            sourceLine +
            "_Generating an AI summary… this draft will update when it is ready._",
          publish: false,
          sourceMetadata,
        }
      );
      await locked.update({ documentId: created.id }, { transaction });
      return created;
    });
  }
}
