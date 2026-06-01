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

    const attachment = await Attachment.findByPk(attachmentId, {
      rejectOnEmpty: true,
    });

    if (attachment.teamId !== user.teamId) {
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
