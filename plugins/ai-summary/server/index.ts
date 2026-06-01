import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import aiSummary from "./api/aiSummary";
import env from "./env";
import DraftSummarizedNotificationsTask from "./tasks/DraftSummarizedNotificationsTask";
import SummarizeDocumentTask from "./tasks/SummarizeDocumentTask";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      ...config,
      type: Hook.API,
      value: aiSummary,
    },
    {
      type: Hook.Task,
      value: SummarizeDocumentTask,
    },
    {
      type: Hook.Task,
      value: DraftSummarizedNotificationsTask,
    },
  ]);
}
