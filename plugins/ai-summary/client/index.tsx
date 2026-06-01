import { t } from "i18next";
import { SparklesIcon } from "outline-icons";
import env from "@shared/env";
import { Hook, PluginManager } from "~/utils/PluginManager";
import config from "../plugin.json";
import { SummarizePaper } from "./SummarizePaper";

if (env.AI_SUMMARY_ENABLED) {
  PluginManager.add([
    {
      ...config,
      type: Hook.Imports,
      value: {
        title: "Summarize a paper",
        subtitle: t("Upload a PDF and get an AI draft summary"),
        icon: <SparklesIcon />,
        action: <SummarizePaper />,
      },
    },
  ]);
}
