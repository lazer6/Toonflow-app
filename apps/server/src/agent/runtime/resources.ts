import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import conf from "@/utils/conf";
import { getRuntimePlatform } from "@/lib/platform";
import { viralReplicatePrompt } from "@/agent/runtime/viralPrompt";
import { getSettings, isProject, resolveModelSelection } from "@/utils/viralReplicate";

export async function createAgentResources(cwd: string, tools: ToolDefinition[], settings = SettingsManager.inMemory(), instructions = "", viralReplicateModels?: { video: string; image: string }) {
  // 爆款复刻项目使用专用提示词，不读取宿主全局 AGENTS.md 与记忆；技能范围由 loadAgentSkills 限定。
  const viralReplicate = isProject(cwd);
  const savedPrompt = conf.get("settings", {}).agentSystemPrompt;
  let systemPrompt = viralReplicate ? viralReplicatePrompt : typeof savedPrompt === "string" ? savedPrompt : undefined;
  if (viralReplicate && systemPrompt) {
    const selected = resolveModelSelection(viralReplicateModels);
    const configuredCapabilities = Object.entries(getSettings().models).filter(([, model]) => model).map(([name]) => name);
    systemPrompt += `\n\n## 本轮生成型号\n${JSON.stringify({
      selectedVideo: selected.video || null,
      selectedImage: selected.image || null,
      configuredCapabilities,
    })}\nselectedVideo 和 selectedImage 是本轮用户选择，工程中的视频和图像生成必须分别使用对应型号；值为 null 表示本轮未选择该类生成模型，不能自行选择其他型号。只能使用 configuredCapabilities 中已绑定的生成能力。Seedance 的 standard/fast/mini/2.5 分别对应 seedance-2/seedance-2-fast/seedance-2-mini/seedance-2.5，不能把同系列不同型号视为可互换。继续旧工程时先核对并修正旧型号，再重新 plan、pricing；不擅自改选型号或修改 Runtime Profile。`;
  }
  const agentDir = join(cwd, ".agent");
  const { path: agentsPath } = await resolveWorkspacePath(cwd, "AGENTS.md");
  const agentsContent = await readFile(agentsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw new Error(t`读取工作区 AGENTS.md 失败：${error.message}`, { cause: error });
  });
  const [globalAgents, memory] = viralReplicate ? [{ content: "" }, { content: "" }]
    : await Promise.all([readDocument("agents"), isMemoryEnabled() ? readDocument("memory") : { content: "" }]);
  const skills = loadAgentSkills(cwd);
  const sdkSkills = tools.some(tool => tool.name === "skillOperator")
    ? { ...skills, skills: skills.skills.map(skill => ({ ...skill, disableModelInvocation: true })) }
    : skills;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // ACT: 仅自动载入工作区根目录的 AGENTS.md，关闭 SDK 向父目录和其他指令文件的自动扫描。
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: agentsContent.trim() ? [{ path: agentsPath, content: agentsContent.replace(/^\uFEFF/, "") }] : [] }),
    // ACT: 技能正文按需读取；每个会话独立创建 loader，避免 SDK 的会话绑定互相覆盖。
    skillsOverride: () => sdkSkills,
    systemPrompt: "",
    systemPromptOverride: () => [buildSystemPrompt({ systemPrompt, tools, skills: skills.skills, platform: getRuntimePlatform().os }), instructions].filter(Boolean).join("\n\n"),
    appendSystemPrompt: [
      globalAgents.content.trim() ? `## 全局协作规范（AGENTS.md）\n${globalAgents.content}` : "",
      memory.content.trim() ? `## 全局长期记忆\n以下是跨对话保存的偏好与事实，使用前核对适用项目，以用户本轮要求为准。\n<global_memory>\n${memory.content}\n</global_memory>` : "",
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
