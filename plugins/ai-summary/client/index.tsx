import env from "@shared/env";
import { Hook, PluginManager } from "~/utils/PluginManager";
import config from "../plugin.json";
import { SummarizePaperSidebarLink } from "./SummarizePaper";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      ...config,
      type: Hook.SidebarAction,
      value: SummarizePaperSidebarLink,
    },
  ]);
}
