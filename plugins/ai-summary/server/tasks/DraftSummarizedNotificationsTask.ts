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
    return {
      priority: TaskPriority.Background,
      attempts: 5,
      backoff: { type: "exponential" as const, delay: 60 * 1000 },
    };
  }
}
