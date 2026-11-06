import type { AsyncEndpoint, EndpointCredential, EndpointInvocationContext, EndpointOutcome, ImmediateEndpointHandler } from "@hypit/hypit/endpoint";
import { EndpointServiceError, credentialRef, defineEndpoint, wakeAfter } from "@hypit/hypit/endpoint";
import type { CredentialRef, EndpointActionLimits, ResourceStore } from "@hypit/hypit/endpoint";
import { EndpointHttpError, EndpointResponseError, EndpointTransportError, withRequestDeadline } from "@hypit/hypit/endpoint/http";
import type { GenerationArtifactUrlResolver } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/protocol";
import type { BlobRef, CanonicalValue } from "@hypit/hypit/protocol";
import { capabilityKey, createToonflowRoutes } from "./routes.js";
import type { ToonflowCapability, ToonflowRoute } from "./routes.js";
import { ToonflowHttpError, ToonflowServiceError, taskFailure } from "./errors.js";

export type CreateToonflowProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  /** Ark-compatible API root, for example `https://ark.cn-beijing.volces.com/api/v3`. */
  readonly baseUrl: string;
  readonly apiKey?: CredentialRef;
  /** Capability name → the model ID the user's account uses for it. */
  readonly models: Readonly<Partial<Record<ToonflowCapability, string>>>;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

type Handle = {
  readonly contract: "toonflow.generation-operation@1";
  readonly taskId: string;
  readonly route: string;
  readonly startedAt: number;
  readonly url?: string;
};

const MB = 1_000_000;
/** Ark takes images under 30 MB and audio up to 15 MB inline within a 64 MB body; videos only by URL. */
const mediaLimits = { image: 30 * MB, audio: 15 * MB, body: 64 * MB } as const;

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string {
  const value = credentials.apiKey?.secret;
  if (typeof value !== "string" || value.length === 0) {
    throw new ToonflowServiceError("GENERATION_CREDENTIAL_UNAVAILABLE",
      "Generation API key is unavailable; set it in Toonflow 爆款复刻设置");
  }
  return value;
}
function failure(error: unknown): EndpointOutcome {
  if (!(error instanceof EndpointServiceError || error instanceof EndpointHttpError
    || error instanceof EndpointTransportError || error instanceof EndpointResponseError)) throw error;
  const code = error instanceof EndpointServiceError || error instanceof EndpointHttpError ? error.code : "GENERATION_ERROR";
  return { status: "failed", failure: { code, message: error.message } };
}
function retrying(error: unknown, handle: CanonicalValue, pollIntervalMs: number, deadlineAt?: number): EndpointOutcome | undefined {
  const delay = error instanceof EndpointTransportError ? pollIntervalMs
    : error instanceof EndpointHttpError && (error.status === 429 || error.status >= 500)
      ? error.retryAfterMs ?? pollIntervalMs : undefined;
  if (delay === undefined) return undefined;
  return { status: "pending", handle, wakeAt: Math.min(Date.now() + delay, deadlineAt ?? Number.MAX_SAFE_INTEGER), progress: { phase: "retrying" } };
}
function httpsUrl(value: unknown, subject: string): string {
  assert(typeof value === "string" && /^https?:\/\//u.test(value), `${subject} has no download URL`);
  return value;
}

class Client {
  constructor(readonly baseUrl: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
  async json(path: string, key: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(`${this.baseUrl}${path}`, {
        ...init, signal, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
      }));
      const text = await wait(response.text());
      if (!response.ok) {
        const input = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        throw new ToonflowHttpError(response.status, response, text, {
          method: init.method ?? "GET", path, ...(typeof input?.model === "string" ? { model: input.model } : {}),
        });
      }
      let body: unknown;
      try { body = text.length === 0 ? {} : JSON.parse(text); } catch { throw new EndpointResponseError(`Generation API returned invalid JSON (${response.status})`); }
      return object(body, "Generation API response");
    }, () => new EndpointTransportError("Generation API request timed out", { timeout: true }));
  }
  async download(url: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    return await withRequestDeadline(this.timeout, async ({ signal, wait }) => {
      const response = await wait(this.fetcher(url, { signal }));
      if (!response.ok) throw new ToonflowHttpError(response.status, response, "", { method: "GET", path: "<generated file>" });
      return { bytes: new Uint8Array(await wait(response.arrayBuffer())), mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream" };
    });
  }
}

/** Inline references as data URLs within Ark's documented sizes. */
function resolverFor(context: EndpointInvocationContext): GenerationArtifactUrlResolver {
  const resolved = new Map<string, Promise<string>>();
  return (artifact) => {
    const existing = resolved.get(artifact.resource);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      const kind = artifact.mediaType.split("/", 1)[0];
      const limit = kind === "image" || kind === "audio" ? mediaLimits[kind] : undefined;
      assert(limit !== undefined, `This generation API accepts ${artifact.mediaType} references only by public URL; use image or audio references instead`);
      assert(artifact.size <= limit, `This generation API accepts ${kind} references up to ${limit / MB} MB; ${artifact.resource} is ${artifact.size} bytes`);
      const bytes = await context.resources.get(artifact.resource);
      assert(bytes !== undefined && bytes.byteLength === artifact.size, `Reference Resource ${artifact.resource} is unavailable or has changed`);
      return `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    })();
    resolved.set(artifact.resource, promise);
    return promise;
  };
}

async function store(client: Client, urls: readonly string[], resources: ResourceStore): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  for (const url of urls) {
    const downloaded = await client.download(url);
    blobs.push(await resources.put(downloaded.bytes, downloaded.mediaType));
  }
  return blobs;
}

const videoPath = "/contents/generations/tasks";

export function createToonflowProvider(options: CreateToonflowProviderOptions) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  let baseUrl = options.baseUrl.trim();
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  assert(baseUrl.length > 0, "Generation baseUrl is empty");
  const client = new Client(baseUrl, requestTimeoutMs, options.fetch ?? globalThis.fetch);
  const routes = createToonflowRoutes(options.models);
  assert(routes.length > 0, "Generation provider has no model IDs configured");
  const byKey = new Map(routes.map((route) => [route.key, route]));
  const routeFor = (context: EndpointInvocationContext): ToonflowRoute => {
    const route = byKey.get(capabilityKey(context.need.capability));
    assert(route !== undefined, "This generation provider does not implement this exact capability");
    return route;
  };
  const prepare = async (context: EndpointInvocationContext) => {
    const route = routeFor(context);
    const request = route.prepare(context.need.constraints);
    await context.reportProgress?.({ phase: `Preparing request: ${request.model}` });
    const body = JSON.stringify(await request.compile(resolverFor(context)));
    assert(Buffer.byteLength(body) <= mediaLimits.body,
      `Generation API accepts request bodies up to ${mediaLimits.body / MB} MB; inline references make this one ${Buffer.byteLength(body)} bytes`);
    return { route, model: request.model, body };
  };
  const post = (path: string, context: EndpointInvocationContext, body: string) =>
    client.json(path, apiKey(context.credentials), { method: "POST", headers: { "content-type": "application/json" }, body });

  const videoEndpoint: AsyncEndpoint = {
    async start(context) {
      try {
        const { route, model, body } = await prepare(context);
        assert(route.protocol === "video", "Image capabilities use an immediate endpoint");
        await context.reportProgress?.({ phase: `Submitting request: ${model}` });
        let response: Record<string, unknown>;
        try { response = await post(videoPath, context, body); }
        catch (error) {
          if (error instanceof EndpointTransportError) return { status: "failed", failure: {
            code: "GENERATION_SUBMISSION_UNKNOWN",
            message: `Generation submission transport failed; remote outcome is unknown: ${error.message}`,
          } };
          throw error;
        }
        const id = response.id;
        if (typeof id !== "string" || id.length === 0) throw new EndpointResponseError("Generation API response has no task id");
        const handle: Handle = { contract: "toonflow.generation-operation@1", taskId: id, route: route.key, startedAt: Date.now() };
        const receipt = { id };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "submitted" }), receipt };
      } catch (error) {
        return failure(error);
      }
    },
    async poll(context) {
      let deadlineAt: number | undefined;
      try {
        const handle = object(context.handle, "Generation handle") as unknown as Handle;
        const route = routeFor(context);
        assert(handle.contract === "toonflow.generation-operation@1" && handle.route === route.key, "Generation handle is invalid");
        const receipt = { id: handle.taskId };
        deadlineAt = handle.startedAt + operationTimeoutMs;
        if (Date.now() >= deadlineAt) {
          return { status: "failed", receipt, failure: { code: "GENERATION_OPERATION_TIMEOUT", message: `Task ${handle.taskId} exceeded operationTimeoutMs (${operationTimeoutMs}); remote outcome is unknown` } };
        }
        const task = await client.json(`${videoPath}/${encodeURIComponent(handle.taskId)}`, apiKey(context.credentials));
        const status = String(task.status);
        if (status === "queued" || status === "running") return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: status }), receipt };
        const rejected = taskFailure(task, handle.taskId);
        if (rejected !== undefined) return { ...failure(rejected), receipt };
        if (status !== "succeeded") throw new EndpointResponseError(`Generation API returned unknown task status ${status}`);
        const url = httpsUrl(object(task.content, "Generation task content").video_url, "Generation task");
        return { status: "ready", handle: canonicalize({ ...handle, url }), receipt };
      } catch (error) {
        return retrying(error, context.handle, pollIntervalMs, deadlineAt) ?? failure(error);
      }
    },
    async collect(context) {
      try {
        const handle = object(context.handle, "Generation handle") as unknown as Handle;
        const route = routeFor(context);
        await context.reportProgress?.({ phase: "Receiving generated video" });
        const blobs = await store(client, [httpsUrl(handle.url, "Generation handle")], context.resources);
        return { status: "completed", result: { value: route.packageResult(blobs) }, receipt: { id: handle.taskId } };
      } catch (error) {
        return retrying(error, context.handle, pollIntervalMs) ?? failure(error);
      }
    },
  };

  const imageEndpoint: ImmediateEndpointHandler = async (context) => {
    const { route, model, body } = await prepare(context);
    assert(route.protocol === "image", "Video capabilities use an asynchronous endpoint");
    await context.reportProgress?.({ phase: `Submitting request: ${model}` });
    const response = await post("/images/generations", context, body);
    assert(Array.isArray(response.data) && response.data.length > 0, "Generation API image response has no data");
    const urls = response.data.map((item, index) => httpsUrl(object(item, `Generated image ${index + 1}`).url, `Generated image ${index + 1}`));
    await context.reportProgress?.({ phase: "Receiving generated images" });
    return { value: route.packageResult(await store(client, urls, context.resources)) };
  };

  return defineEndpoint({
    instance: options.instance ?? "toonflow.generation",
    pool: options.pool ?? options.instance ?? "toonflow.generation",
    // ACT: 用户自带的接口没有统一价格页，只把 HTTPS 根地址作为查价入口；本机调试地址不声明价格页。
    ...(baseUrl.startsWith("https://") ? { pricing: { kind: "page" as const, url: new URL(baseUrl).origin } } : {}),
    credentials: { apiKey: options.apiKey ?? credentialRef("env", "TOONFLOW_HYPIT_API_KEY") },
    credentialInputs: { apiKey: { label: "Generation API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 2,
    ...(options.actionLimits === undefined ? {} : { actionLimits: options.actionLimits }),
    capabilities: routes.map((route) => route.protocol === "image"
      ? { capability: route.capability, returns: route.returns, lifecycle: "immediate" as const, handler: imageEndpoint, capacity: route.capability.name, supports: route.supports }
      : { capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const, endpoint: videoEndpoint, capacity: route.capability.name, supports: route.supports }),
  });
}
