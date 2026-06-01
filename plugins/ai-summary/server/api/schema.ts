import { z } from "zod";
import { BaseSchema } from "@server/routes/api/schema";

export const AiSummaryCreateSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the PDF attachment to summarize. */
    attachmentId: z.uuid(),
  }),
});

export type AiSummaryCreateReq = z.infer<typeof AiSummaryCreateSchema>;
