import { NotificationEventType } from "@shared/types";
import { Notification } from "@server/models";
import { buildUser, buildDocument } from "@server/test/factories";
import DraftSummarizedNotificationsTask from "./DraftSummarizedNotificationsTask";

describe("DraftSummarizedNotificationsTask", () => {
  it("creates a completed notification linked to the draft", async () => {
    const user = await buildUser();
    const document = await buildDocument({ userId: user.id, teamId: user.teamId });

    await new DraftSummarizedNotificationsTask().perform({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      status: "completed",
      fileName: "paper.pdf",
    });

    const notification = await Notification.findOne({ where: { userId: user.id } });
    expect(notification).toBeTruthy();
    expect(notification!.event).toEqual(NotificationEventType.DraftSummarized);
    expect(notification!.documentId).toEqual(document.id);
  });

  it("creates a failed notification with no document", async () => {
    const user = await buildUser();

    await new DraftSummarizedNotificationsTask().perform({
      userId: user.id,
      teamId: user.teamId,
      documentId: null,
      status: "failed",
      fileName: "broken.pdf",
    });

    const notification = await Notification.findOne({ where: { userId: user.id } });
    expect(notification).toBeTruthy();
    expect(notification!.documentId).toBeNull();
    expect(notification!.data).toMatchObject({ status: "failed", fileName: "broken.pdf" });
  });

  it("skips notification for an unsubscribed user", async () => {
    const user = await buildUser();
    user.setNotificationEventType(NotificationEventType.DraftSummarized, false);
    await user.save();

    await new DraftSummarizedNotificationsTask().perform({
      userId: user.id,
      teamId: user.teamId,
      documentId: null,
      status: "failed",
      fileName: "ignored.pdf",
    });

    const notification = await Notification.findOne({ where: { userId: user.id } });
    expect(notification).toBeNull();
  });
});
