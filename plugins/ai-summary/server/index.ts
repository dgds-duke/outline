import { PluginManager, Hook } from "@server/utils/PluginManager";
import env from "./env";
import DraftSummarizedNotificationsTask from "./tasks/DraftSummarizedNotificationsTask";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      type: Hook.Task,
      value: DraftSummarizedNotificationsTask,
    },
  ]);
}
