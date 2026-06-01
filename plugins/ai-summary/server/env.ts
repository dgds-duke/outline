import { IsBoolean, IsOptional } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class AiSummaryPluginEnvironment extends Environment {
  /**
   * A vision-capable chat model id on the proxy (e.g. a GPT-5.x model).
   */
  @IsOptional()
  @CannotUseWithout("LITELLM_BASE_URL")
  public LITELLM_SUMMARY_MODEL = this.toOptionalString(
    environment.LITELLM_SUMMARY_MODEL
  );

  /**
   * Whether the summarize-a-paper feature is fully configured. Exposed to the
   * client so the upload UI only appears when the proxy is set up.
   */
  @Public
  @IsBoolean()
  public AI_SUMMARY_ENABLED = !!(
    this.LITELLM_BASE_URL &&
    this.LITELLM_API_KEY &&
    this.LITELLM_SUMMARY_MODEL
  );
}

export default new AiSummaryPluginEnvironment();
