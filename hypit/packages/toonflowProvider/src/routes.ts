import {
  compileWireRequest,
  selectWireModelForRequest,
  generationTypes,
  sealGeneratedImageSet,
  sealGeneratedVideoSet,
} from "@hypit/generation";
import type { GenerationArtifactUrlResolver, GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { canonicalize } from "@hypit/hypit/protocol";
import type { BlobRef, CapabilityRef, CanonicalValue, ModuleRef, StoredValue, TypeRef } from "@hypit/hypit/protocol";
import type { EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";

const SEEDANCE: ModuleRef = { name: "@hypit/seedance", version: "1" };
const SEEDREAM: ModuleRef = { name: "@hypit/seedream", version: "1" };

/** Capabilities this Provider can serve; the user's account decides which model ID answers each one. */
export const toonflowVideoCapabilities = ["seedance-2", "seedance-2-fast", "seedance-2-mini", "seedance-2.5"] as const;
export const toonflowImageCapabilities = ["seedream-5-lite"] as const;
export type ToonflowCapability = typeof toonflowVideoCapabilities[number] | typeof toonflowImageCapabilities[number];

export type ToonflowProtocol = "video" | "image";

export type ToonflowPreparedRequest = {
  readonly model: string;
  readonly protocol: ToonflowProtocol;
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

export type ToonflowRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly protocol: ToonflowProtocol;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
  readonly prepare: (constraints: CanonicalValue) => ToonflowPreparedRequest;
  readonly packageResult: (artifacts: readonly BlobRef[]) => StoredValue;
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** Seedream 5.0 lite pixel sizes for each resolution tier and aspect ratio, from the Ark image API reference. */
const SEEDREAM_SIZES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  basic: { "1:1": "2048x2048", "4:3": "2304x1728", "3:4": "1728x2304", "16:9": "2848x1600", "9:16": "1600x2848", "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3136x1344" },
  high: { "1:1": "3072x3072", "4:3": "3456x2592", "3:4": "2592x3456", "16:9": "4096x2304", "9:16": "2304x4096", "3:2": "3744x2496", "2:3": "2496x3744", "21:9": "4704x2016" },
  ultra: { "1:1": "4096x4096", "4:3": "4704x3520", "3:4": "3520x4704", "16:9": "5504x3040", "9:16": "3040x5504", "3:2": "4992x3328", "2:3": "3328x4992", "21:9": "6240x2656" },
};

function rejection(mapping: GenerationWireMapping, request: GenerationRequest): string | undefined {
  if (mapping.capability.module.name !== "@hypit/seedream") return undefined;
  const quality = String(scalar(request, "quality"));
  const ratio = String(scalar(request, "aspectRatio"));
  return SEEDREAM_SIZES[quality]?.[ratio] === undefined
    ? `Seedream 5.0 lite has no size for quality ${quality} at ${ratio}` : undefined;
}

const videoMapping = (name: string, model: string): GenerationWireMapping => ({
  capability: { module: SEEDANCE, name }, result: "video", routes: [{ model }],
  fields: {
    prompt: { as: "value", field: "text" },
    referenceImage: { as: "urlArray", field: "reference_image", resourceFields: ["personReference"] },
    referenceVideo: { as: "urlArray", field: "reference_video", resourceFields: ["personReference"] },
    referenceAudio: { as: "urlArray", field: "reference_audio" },
    firstFrame: { as: "url", field: "first_frame", resourceFields: ["personReference"] },
    lastFrame: { as: "url", field: "last_frame", resourceFields: ["personReference"] },
    resolution: { as: "value", field: "resolution" },
    aspectRatio: { as: "value", field: "ratio" },
    duration: { as: "value", field: "duration" },
    generateAudio: { as: "value", field: "generate_audio" },
    webSearch: { as: "value", field: "web_search" },
  },
});

const imageMapping = (name: string, model: string): GenerationWireMapping => ({
  capability: { module: SEEDREAM, name }, result: "image", routes: [{ model }],
  fields: {
    prompt: { as: "value", field: "prompt" },
    aspectRatio: { as: "value", field: "aspect_ratio" },
    quality: { as: "value", field: "quality" },
    outputFormat: { as: "value", field: "output_format" },
    nsfwCheck: { as: "value", field: "nsfw_check" },
    images: { as: "urlArray", field: "image" },
  },
});

function contentItem(type: "image_url" | "video_url" | "audio_url", url: string, role: string) {
  return { type, [type]: { url }, role };
}

/** Ark video tasks take one `content` array of typed, role-tagged items. */
function videoBody(model: string, input: Record<string, unknown>): Record<string, unknown> {
  const first = input.first_frame;
  const last = input.last_frame;
  return {
    model,
    content: [
      { type: "text", text: input.text },
      ...(typeof first === "string" ? [contentItem("image_url", first, "first_frame")] : []),
      ...(typeof last === "string" ? [contentItem("image_url", last, "last_frame")] : []),
      ...strings(input.reference_image).map((url) => contentItem("image_url", url, "reference_image")),
      ...strings(input.reference_video).map((url) => contentItem("video_url", url, "reference_video")),
      ...strings(input.reference_audio).map((url) => contentItem("audio_url", url, "reference_audio")),
    ],
    resolution: input.resolution,
    ratio: input.ratio,
    duration: input.duration,
    generate_audio: input.generate_audio,
    watermark: false,
    ...(input.web_search === true ? { tools: [{ type: "web_search" }] } : {}),
  };
}

function imageBody(model: string, input: Record<string, unknown>): Record<string, unknown> {
  const images = strings(input.image);
  return {
    model,
    prompt: input.prompt,
    ...(images.length === 1 ? { image: images[0] } : images.length > 1 ? { image: images } : {}),
    size: SEEDREAM_SIZES[String(input.quality)]![String(input.aspect_ratio)]!,
    output_format: input.output_format,
    response_format: "url",
    watermark: false,
  };
}

export function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}

/** Build the routes for the capabilities the user mapped to a model ID. */
export function createToonflowRoutes(models: Readonly<Partial<Record<ToonflowCapability, string>>>): readonly ToonflowRoute[] {
  return Object.entries(models).flatMap(([name, model]) => {
    if (model === undefined) return [];
    const protocol: ToonflowProtocol = (toonflowImageCapabilities as readonly string[]).includes(name) ? "image" : "video";
    const mapping = protocol === "image" ? imageMapping(name, model) : videoMapping(name, model);
    const body = protocol === "image" ? imageBody : videoBody;
    return [{
      ...mapping,
      key: capabilityKey(mapping.capability),
      returns: protocol === "image" ? generationTypes.imageSet : generationTypes.videoSet,
      protocol,
      supports: (request: EndpointRequest): EndpointSupport => {
        const reason = rejection(mapping, request.constraints as unknown as GenerationRequest);
        return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
      },
      prepare: (constraints: CanonicalValue): ToonflowPreparedRequest => {
        const request = constraints as unknown as GenerationRequest;
        const reason = rejection(mapping, request);
        if (reason !== undefined) throw new Error(reason);
        const selected = selectWireModelForRequest(mapping, request);
        return {
          model: selected,
          protocol,
          compile: async (resolve) => body(selected, (await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>),
        };
      },
      packageResult: (artifacts: readonly BlobRef[]): StoredValue => ({
        kind: "inline",
        value: canonicalize(protocol === "image"
          ? sealGeneratedImageSet({ images: artifacts })
          : sealGeneratedVideoSet({ videos: artifacts })),
      }),
    }];
  });
}
