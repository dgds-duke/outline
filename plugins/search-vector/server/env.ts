import { IsBoolean, IsOptional } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class SearchVectorPluginEnvironment extends Environment {
  /**
   * Embedding model id; must produce 1536-dim vectors to match the column.
   */
  @IsOptional()
  @CannotUseWithout("LITELLM_BASE_URL")
  public LITELLM_EMBEDDING_MODEL =
    this.toOptionalString(environment.LITELLM_EMBEDDING_MODEL) ??
    "text-embedding-3-small";

  /**
   * Chat model used to generate the Ask AI answer.
   */
  @IsOptional()
  @CannotUseWithout("LITELLM_BASE_URL")
  public LITELLM_ANSWER_MODEL = this.toOptionalString(
    environment.LITELLM_ANSWER_MODEL
  );

  /**
   * Whether semantic search + Ask AI are fully configured (exposed to the client).
   */
  @Public
  @IsBoolean()
  public AI_SEARCH_ENABLED = !!(
    this.LITELLM_BASE_URL &&
    this.LITELLM_API_KEY &&
    environment.SEARCH_PROVIDER === "vector"
  );
}

export default new SearchVectorPluginEnvironment();
