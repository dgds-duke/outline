import { IsBoolean, IsOptional } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";

export class SearchVectorPluginEnvironment extends Environment {
  /**
   * Embedding model id; must produce 1536-dim vectors to match the column.
   * Only used when LiteLLM is configured (LITELLM_BASE_URL + LITELLM_API_KEY);
   * ignored otherwise. The semantic-search feature is optional, so a missing
   * LiteLLM config must never fail server startup — it degrades to keyword
   * search (AI_SEARCH_ENABLED stays false).
   */
  @IsOptional()
  public LITELLM_EMBEDDING_MODEL =
    this.toOptionalString(environment.LITELLM_EMBEDDING_MODEL) ??
    "text-embedding-3-small";

  /**
   * Chat model used to generate the Ask AI answer. Only used when LiteLLM is
   * configured; ignored otherwise.
   */
  @IsOptional()
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
