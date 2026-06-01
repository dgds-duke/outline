import type { SourceMetadata } from "@shared/types";
import { escape } from "@shared/utils/markdown";
import documentCreator from "@server/commands/documentCreator";
import { createContext } from "@server/context";
import { Attachment, User } from "@server/models";
import { BaseTask, TaskPriority } from "@server/queues/tasks/base/BaseTask";
import { sequelize } from "@server/storage/database";
import FileStorage from "@server/storage/files";
import LiteLLMClient from "@server/utils/LiteLLMClient";
import env from "../env";
import {
  parseSummaryResponse,
  summarizeSystemPrompt,
  summarizeUserInstruction,
} from "../litellm/prompt";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";

type Props = {
  attachmentId: string;
  userId: string;
  ip: string;
};

/** Strip a trailing file extension for use as a fallback title. */
function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/**
 * Background task: read an uploaded PDF, summarize it via the LiteLLM proxy,
 * create an unpublished draft in the uploader's My Drafts with the source
 * attached, and notify the uploader.
 */
export default class SummarizeDocumentTask extends BaseTask<Props> {
  /**
   * Summarize the attachment and create the draft.
   *
   * @param props the source attachment id, the requesting user id, and the request ip.
   * @returns a promise that resolves once the draft is created and a notification scheduled.
   */
  public async perform({ attachmentId, userId, ip }: Props) {
    const attachment = await Attachment.findByPk(attachmentId, {
      rejectOnEmpty: true,
    });
    const user = await User.findByPk(userId, { rejectOnEmpty: true });

    const fileName = attachment.name;
    const buffer = await FileStorage.getFileBuffer(attachment.key);

    const raw = await LiteLLMClient.chat({
      model: env.LITELLM_SUMMARY_MODEL ?? "",
      systemPrompt: summarizeSystemPrompt,
      userText: summarizeUserInstruction,
      file: {
        filename: fileName,
        dataUrl: `data:application/pdf;base64,${buffer.toString("base64")}`,
      },
      jsonObject: true,
    });
    const { title, summaryMarkdown } = parseSummaryResponse(raw);

    const sourceLine = `> **Source:** [${escape(fileName)}](${Attachment.getRedirectUrl(
      attachment.id
    )})\n\n`;
    const text = sourceLine + summaryMarkdown;

    const sourceMetadata: Pick<Required<SourceMetadata>, "fileName" | "mimeType"> = {
      fileName,
      mimeType: attachment.contentType,
    };

    const document = await sequelize.transaction(async (transaction) => {
      const created = await documentCreator(
        createContext({ user, ip, transaction }),
        {
          title: title || stripExtension(fileName) || "Untitled",
          text,
          publish: false,
          sourceMetadata,
        }
      );
      await attachment.update({ documentId: created.id }, { transaction });
      return created;
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
   * On final failure, notify the uploader that summarization could not complete.
   *
   * @param props the original task props.
   * @returns a promise that resolves once the failure notification is scheduled.
   */
  public async onFailed({ attachmentId, userId }: Props) {
    const [attachment, user] = await Promise.all([
      Attachment.findByPk(attachmentId),
      User.findByPk(userId),
    ]);
    if (!user) {
      return;
    }
    await new DraftSummarizedNotificationsTask().schedule({
      userId: user.id,
      teamId: user.teamId,
      documentId: null,
      status: "failed",
      fileName: attachment ? attachment.name : "your file",
    });
  }

  public get options() {
    return { ...super.options, priority: TaskPriority.Background, attempts: 3 };
  }
}
