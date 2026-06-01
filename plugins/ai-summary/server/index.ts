import { PluginManager, Hook } from "@server/utils/PluginManager";
import env from "./env";

if (env.AI_SUMMARY_ENABLED) {
  void (async () => {
    const [{ default: SummarizeDocumentTask }, { default: DraftSummarizedNotificationsTask }] =
      await Promise.all([
        import("./tasks/SummarizeDocumentTask"),
        import("./tasks/DraftSummarizedNotificationsTask"),
      ]);
    PluginManager.add([
      {
        type: Hook.Task,
        value: SummarizeDocumentTask,
      },
      {
        type: Hook.Task,
        value: DraftSummarizedNotificationsTask,
      },
    ]);
  })();
}
