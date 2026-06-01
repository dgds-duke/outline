import { IsBoolean, IsOptional, IsUrl } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";

class AiSummaryPluginEnvironment extends Environment {
  /** Base URL of the OpenAI-compatible LiteLLM proxy, e.g. https://litellm.duke.edu/v1 */
  @IsOptional()
  @IsUrl({ require_tld: false })
  public LITELLM_BASE_URL = this.toOptionalString(environment.LITELLM_BASE_URL);

  /** Virtual API key for the proxy (secret; supports LITELLM_API_KEY_FILE). */
  @IsOptional()
  public LITELLM_API_KEY = this.toOptionalString(environment.LITELLM_API_KEY);

  /** A vision-capable chat model id on the proxy (e.g. a GPT-5.x model). */
  @IsOptional()
  public LITELLM_SUMMARY_MODEL = this.toOptionalString(
    environment.LITELLM_SUMMARY_MODEL
  );

  /** Whether the summarize-a-paper feature is fully configured (exposed to the client). */
  @Public
  @IsBoolean()
  public AI_SUMMARY_ENABLED = !!(
    this.LITELLM_BASE_URL &&
    this.LITELLM_API_KEY &&
    this.LITELLM_SUMMARY_MODEL
  );
}

export default new AiSummaryPluginEnvironment();
