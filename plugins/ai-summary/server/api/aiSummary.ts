import Router from "koa-router";
import { AuthorizationError, ValidationError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { Attachment } from "@server/models";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import SummarizeDocumentTask from "../tasks/SummarizeDocumentTask";
import * as T from "./schema";

const router = new Router();

router.post(
  "aiSummary.create",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(T.AiSummaryCreateSchema),
  async (ctx: APIContext<T.AiSummaryCreateReq>) => {
    const { attachmentId } = ctx.input.body;
    const { user } = ctx.state.auth;

    // Only members who can create documents may summarize; viewers and guests
    // are rejected up front so we never schedule a job that the task would later
    // fail to authorize (wasting an LLM call).
    if (user.isViewer || user.isGuest) {
      throw AuthorizationError();
    }

    const attachment = await Attachment.findByPk(attachmentId, {
      rejectOnEmpty: true,
    });

    // The attachment must be the caller's own upload (this also enforces team
    // isolation, since a user's own attachment is always in their team).
    if (attachment.userId !== user.id) {
      throw AuthorizationError();
    }

    if (attachment.contentType !== "application/pdf") {
      throw ValidationError("Only PDF attachments can be summarized");
    }

    await new SummarizeDocumentTask().schedule({
      attachmentId: attachment.id,
      userId: user.id,
      ip: ctx.request.ip,
    });

    ctx.body = { success: true };
  }
);

export default router;
