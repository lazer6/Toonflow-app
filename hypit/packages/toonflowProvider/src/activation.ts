import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigActionLimits,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-local/extension";

import { createToonflowProvider } from "./provider.js";
import { toonflowImageCapabilities, toonflowVideoCapabilities } from "./routes.js";
import type { ToonflowCapability } from "./routes.js";

const capabilities: readonly string[] = [...toonflowVideoCapabilities, ...toonflowImageCapabilities];

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@toonflow/hypit-provider",
  activate(context) {
    if (context.pool === undefined) throw new Error("Toonflow generation Provider Pool is required");
    const config = runtimeConfigObject(context.config, "Toonflow generation");
    runtimeConfigExact(config, [
      "baseUrl", "apiKey", "models", "defaultConcurrency", "actionLimits", "pollIntervalMs", "requestTimeoutMs", "operationTimeoutMs",
    ], "Toonflow generation");
    const baseUrl = runtimeConfigString(config.baseUrl, "Toonflow generation baseUrl");
    if (baseUrl === undefined) throw new Error("Toonflow generation baseUrl is required");
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("Toonflow generation baseUrl must use HTTPS or loopback");
    }
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "Toonflow generation apiKey");
    if (apiKey === undefined) throw new Error("Toonflow generation apiKey CredentialRef is required");
    const modelConfig = runtimeConfigObject(config.models ?? {}, "Toonflow generation models");
    runtimeConfigExact(modelConfig, capabilities, "Toonflow generation models");
    const models: Partial<Record<ToonflowCapability, string>> = {};
    for (const [name, value] of Object.entries(modelConfig)) {
      const model = runtimeConfigString(value, `Toonflow generation model ${name}`);
      if (model) models[name as ToonflowCapability] = model;
    }
    const actionLimits = runtimeConfigActionLimits(config.actionLimits);
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "Toonflow generation defaultConcurrency");
    const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "Toonflow generation pollIntervalMs");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "Toonflow generation requestTimeoutMs");
    const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "Toonflow generation operationTimeoutMs");
    return {
      endpoint: createToonflowProvider({
        instance: context.instance,
        pool: context.pool,
        baseUrl,
        apiKey,
        models,
        ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
        ...(actionLimits === undefined ? {} : { actionLimits }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [adapter],
};

export default hypitPackage;
