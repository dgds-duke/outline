import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import HybridSearchProvider from "./HybridSearchProvider";
import BackfillEmbeddingsTask from "./tasks/BackfillEmbeddingsTask";
import "./env";

PluginManager.add([
  { ...config, type: Hook.SearchProvider, value: new HybridSearchProvider() },
  { type: Hook.Task, value: BackfillEmbeddingsTask },
]);
