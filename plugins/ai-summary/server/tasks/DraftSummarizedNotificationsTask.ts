import { NotificationEventType } from "@shared/types";
import { Notification, User } from "@server/models";
import { BaseTask, TaskPriority } from "@server/queues/tasks/base/BaseTask";

type Props = {
  userId: string;
  teamId: string;
  documentId: string | null;
  status: "completed" | "failed";
  fileName: string;
};

/**
 * Creates the persisted "draft summarized" notification for the requesting
 * user. Creation auto-emits over the user's websocket channel via the
 * Notification model's AfterCreate hook.
 */
export default class DraftSummarizedNotificationsTask extends BaseTask<Props> {
  /**
   * Create the "draft summarized" notification for the uploader. No-op when the
   * user has opted out of this notification type.
   *
   * @param props the recipient, team, draft id (null on failure), status, and source file name.
   * @returns a promise that resolves once the notification has been created (or skipped).
   */
  public async perform({ userId, teamId, documentId, status, fileName }: Props) {
    const user = await User.findByPk(userId);
    if (!user || !user.subscribedToEventType(NotificationEventType.DraftSummarized)) {
      return;
    }

    await Notification.create({
      event: NotificationEventType.DraftSummarized,
      userId,
      actorId: userId,
      teamId,
      documentId: documentId ?? undefined,
      data: { status, fileName },
    });
  }

  public get options() {
    return { ...super.options, priority: TaskPriority.Background };
  }
}
