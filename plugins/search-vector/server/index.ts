import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import HybridSearchProvider from "./HybridSearchProvider";
import "./env";

PluginManager.add([
  { ...config, type: Hook.SearchProvider, value: new HybridSearchProvider() },
]);
