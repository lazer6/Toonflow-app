import { z } from "zod";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { cp, existsSync, mkdir, readFile, readdir, rm, stat, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";
import { isWithin } from "@/utils/workspace/files";

export const capabilityNames = ["seedance-2", "seedance-2-fast", "seedance-2-mini", "seedance-2.5", "seedream-5-lite"] as const;

export const settingsSchema = z.strictObject({
  baseUrl: z.string().trim().max(2048).refine(value => !value || /^https?:\/\//.test(value), "Base URL 必须是 HTTP(S) 地址"),
  apiKey: z.string().max(4096).optional(),
  models: z.partialRecord(z.enum(capabilityNames), z.string().trim().max(200)),
  nodePath: z.string().trim().max(4096),
});
export type ViralReplicateSettings = z.infer<typeof settingsSchema>;
export type GenerationModels = { video: string; image: string };

const defaults: ViralReplicateSettings = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: {}, nodePath: "node" };
const projectNameSchema = z.string().trim().min(1).max(80);

/** 设置保存在顶层 viralReplicate 键，避免与宿主 settings 的完整覆盖保存互相清除。 */
export function getSettings(): ViralReplicateSettings {
  const saved = settingsSchema.partial().safeParse(conf.get("viralReplicate"));
  return { ...defaults, ...(saved.success ? saved.data : {}), models: { ...(saved.success ? saved.data.models : {}) } };
}

export function resolveModelSelection(selection?: GenerationModels): GenerationModels {
  const { models } = getSettings();
  const videoModels = capabilityNames.filter(name => name.startsWith("seedance-") && models[name]?.trim());
  const imageModels = capabilityNames.filter(name => name.startsWith("seedream-") && models[name]?.trim());
  const selected = { video: selection?.video ?? videoModels[0] ?? "", image: selection?.image ?? imageModels[0] ?? "" };
  for (const [kind, available] of [["video", videoModels], ["image", imageModels]] as const) {
    if (selected[kind] && !available.some(name => name === selected[kind])) {
      throw Object.assign(new Error(`所选${kind === "video" ? "视频" : "图像"}模型 ${selected[kind]} 未配置，请在爆款复刻配置中填写模型 ID 后重新选择`), { status: 400 });
    }
  }
  return selected;
}

export function saveSettings(settings: ViralReplicateSettings) {
  const previous = getSettings();
  // 未传 apiKey 表示沿用已保存的密钥，前端不回显明文。
  const next = { ...settings, apiKey: settings.apiKey === undefined ? previous.apiKey : settings.apiKey };
  conf.set("viralReplicate", next);
  return next;
}

export function publicSettings(settings = getSettings()) {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: !!apiKey };
}

const dataDirectory = () => dirname(conf.path);
// ACT: 源码与独立 Server 的 data/ 与 hypit/ 同级；桌面安装需随包放置同级 hypit/，否则用 TOONFLOW_HYPIT_ROOT 指定。
export const hypitRoot = () => resolve(process.env.TOONFLOW_HYPIT_ROOT ?? join(dataDirectory(), "..", "hypit"));
export const projectsDirectory = () => join(dataDirectory(), "viralReplicate");
const stateDirectory = () => join(dataDirectory(), "hypitState");

/** 位于爆款复刻根目录下的项目始终以复刻模式运行，模式由服务端按目录判断，不信任客户端标记。 */
export function isProject(directory: string) {
  const root = resolve(projectsDirectory());
  return isWithin(root, resolve(directory)) && resolve(directory) !== root;
}

export function assertProject(directory: string) {
  if (!isProject(directory)) throw Object.assign(new Error("只能操作爆款复刻项目目录"), { status: 403 });
}

function profile(settings: ViralReplicateSettings) {
  const models = Object.fromEntries(Object.entries(settings.models).filter(([, model]) => model));
  return {
    format: "hypit.runtime-local@1",
    dataRoot: ".hypit/runtimes/local",
    credentials: { env: { use: "@hypit/credential-store-env" } },
    endpoints: {
      ...(settings.baseUrl && Object.keys(models).length ? {
        "toonflow.generation": {
          use: "@toonflow/hypit-provider",
          pool: "toonflow.generation",
          config: { baseUrl: settings.baseUrl, apiKey: { store: "env", key: "TOONFLOW_HYPIT_API_KEY" }, models },
        },
      } : {}),
      "media.local": { use: "@hypit/media-local" },
      "html.local": { use: "@hypit/provider-html-local" },
      "image.opencv.local": { use: "@hypit/provider-image-opencv-local" },
      "whisperx.local": { use: "@hypit/provider-whisperx-local" },
    },
    bindings: settings.baseUrl ? Object.fromEntries(Object.keys(models).map(name => [
      `@hypit/${name.startsWith("seedream") ? "seedream" : "seedance"}@1#${name}`, "toonflow.generation",
    ])) : {},
  };
}

async function writeIfChanged(path: string, content: string) {
  const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (previous === content) return false;
  await writeAtomic(path, content);
  return previous !== undefined;
}

/** 写入项目清单、运行配置和隔离的 hypit 技能；配置变化时重启该项目的 Worker 以读取新密钥。 */
export async function prepareProject(directory: string, signal?: AbortSignal) {
  assertProject(directory);
  const settings = getSettings();
  await writeIfChanged(join(directory, "package.json"), `${JSON.stringify({
    name: "toonflow-viral-replicate", version: "0.0.0", private: true, type: "module", hypit: { project: true },
  }, null, 2)}\n`);
  const changed = await writeIfChanged(join(directory, "hypit.runtime.json"), `${JSON.stringify(profile(settings), null, 2)}\n`);
  await mkdir(join(directory, ".hypit"), { recursive: true });
  await writeIfChanged(join(directory, ".hypit", "runtime"), "hypit.runtime.json\n");
  const keyHash = createHash("sha256").update(settings.apiKey ?? "").digest("hex");
  const keyChanged = await writeIfChanged(join(directory, ".hypit", "toonflowKey"), `${keyHash}\n`);
  // ACT: 每次运行前覆盖同步技能，项目内对技能文件的修改不会保留；需要定制时改 hypit/skills 源文件。
  await cp(join(hypitRoot(), "skills", "hypit"), join(directory, "skill", "hypit"), { recursive: true, force: true });
  if (changed || keyChanged) await runHypit(directory, ["runtime", "down"], signal).catch(() => undefined);
}

export async function listProjects() {
  const root = projectsDirectory();
  await mkdir(root, { recursive: true });
  const items = await Promise.all((await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).map(async item => {
    const directory = join(root, item.name);
    const meta = await readFile(join(directory, ".hypit", "toonflowProject.json"), "utf8").then(text => JSON.parse(text) as { name?: unknown }).catch(() => ({ name: undefined }));
    return { directory, name: typeof meta.name === "string" ? meta.name : item.name, modified: (await stat(directory)).mtimeMs };
  }));
  return items.sort((a, b) => b.modified - a.modified);
}

export async function createProject(name: string) {
  const projectName = projectNameSchema.parse(name);
  const directory = join(projectsDirectory(), crypto.randomUUID());
  await mkdir(join(directory, ".hypit"), { recursive: true });
  await writeAtomic(join(directory, ".hypit", "toonflowProject.json"), `${JSON.stringify({ name: projectName })}\n`);
  await prepareProject(directory);
  return { directory, name: projectName, modified: Date.now() };
}

/** 停止项目 Runtime 后删除整个爆款复刻项目目录。目录边界由 assertProject 统一校验。 */
export async function deleteProject(directory: string) {
  const target = resolve(directory);
  assertProject(target);
  await runHypit(target, ["runtime", "down"]).catch(() => undefined);
  await rm(target, { recursive: true, force: true });
}

export function status() {
  const root = hypitRoot();
  return {
    hypitRoot: root,
    hypitReady: existsSync(join(root, "bin", "hypit.mjs")) && existsSync(join(root, "node_modules", "tsx")),
  };
}

const maxOutput = 30000;

/** 以参数数组直接启动 hypit，不经过 shell；密钥只通过环境变量传给子进程。 */
export function runHypit(directory: string, args: string[], signal?: AbortSignal, onOutput?: (text: string) => void) {
  assertProject(directory);
  const settings = getSettings();
  const launcher = join(hypitRoot(), "bin", "hypit.mjs");
  const userInfoShim = join(hypitRoot(), "bin", "toonflowUserInfoShim.cjs");
  if (!existsSync(launcher)) return Promise.reject(new Error(`未找到 hypit：${launcher}`));
  return new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
    signal?.throwIfAborted();
    const child = spawn(settings.nodePath || "node", [launcher, ...args], {
      cwd: directory,
      windowsHide: true,
      env: {
        ...process.env,
        HYPIT_STATE_HOME: stateDirectory(),
        TOONFLOW_HYPIT_API_KEY: settings.apiKey ?? "",
        NO_COLOR: "1",
        NODE_OPTIONS: [process.env.NODE_OPTIONS, existsSync(userInfoShim) ? `--require="${userInfoShim.replaceAll("\\", "/")}"` : undefined].filter(Boolean).join(" "),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-maxOutput);
      onOutput?.(output);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => {
      signal?.removeEventListener("abort", abort);
      reject(Object.assign(new Error(`无法启动 Node（${settings.nodePath || "node"}）：${error.message}`), { cause: error }));
    });
    child.once("close", code => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else resolveRun({ code, output });
    });
  });
}
