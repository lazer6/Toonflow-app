import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { resolveModelSelection, runHypit } from "@/utils/viralReplicate";
import type { GenerationModels } from "@/utils/viralReplicate";
import { isWithin } from "@/utils/workspace/files";

const parameters = z.strictObject({
  args: z.array(z.string().max(4096)).min(1).max(64).describe("hypit 的参数数组，不含 hypit 本身。plan、pricing、build 必须紧跟已存在的 .svrun 文件相对路径，例如 [\"plan\", \"productions/main/runs/final.svrun\"]；查看语法用 [\"help\", \"plan\"]"),
});

// ACT: 凭据由宿主通过环境变量注入，禁止 Agent 改写或读取；其他子命令按 hypit 自身规则执行。
const blocked = new Set(["auth"]);

export function createHypitTool(cwd: string, selection?: GenerationModels): ToolDefinition {
  const selectedModels = resolveModelSelection(selection);
  return {
    name: "hypit",
    label: "Hypit",
    description: "在当前爆款复刻项目根目录执行 hypit 命令行。参数按数组逐项传入，不经过 shell，不能使用管道、重定向或其他程序。返回退出码与输出（超长时保留末尾）。",
    promptSnippet: "执行 hypit 命令：check、plan、pricing、build、status、logs、inspect、get、doctor、runtime、programs、transcribe、media 等。",
    promptGuidelines: [
      "hypit 已安装且当前目录就是视频项目根目录，Runtime Profile 已由宿主写好并选中；不要执行 auth、runtime init 或改写 hypit.runtime.json。生成模型凭据已由宿主注入。",
      "doctor 不带 --endpoint 时只检查本轮使用的 toonflow.generation、media.local 和 html.local；image.opencv.local 与 whisperx.local 是可选服务，需要时再显式指定 endpoint。",
      "transcribe 只适用于包含音频流的 audio/video 文件；视频没有音轨时跳过 transcribe，继续做画面分析，并向用户说明无法获得语音文字。",
      "plan、pricing、build 必须指定已编写的 Run Source，例如 [\"plan\", \"productions/main/runs/final.svrun\"]；check 也必须指定 Source。没有工程源文件时先分析素材并编写工程，不调用空参数 plan 检查环境；环境检查使用 doctor，命令语法使用 help <命令>。",
      "build 使用 --follow 观察进度；长任务可配合 --max-wait-ms，超时后用 status/logs 继续查看，不要重复提交同一 Build。",
      "build 提交前会检查工程中的图像、视频生成型号是否与用户本轮选择一致；不一致时必须先修改工程并重新 plan、pricing，不能绕过检查或自行替换型号。",
      "成片使用 hypit get <build> --output <output> --to exports/<文件名>.mp4 导出到工作区，交付时给出 exports/ 下的相对路径链接。",
    ],
    parameters: z.toJSONSchema(parameters, { io: "input", target: "draft-07" }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      const { args: requestedArgs } = parameters.parse(params);
      if (blocked.has(requestedArgs[0]!)) throw new Error(`hypit ${requestedArgs[0]} 由 Toonflow 管理，Agent 不能调用`);
      if (["check", "plan", "pricing", "build"].includes(requestedArgs[0]!) && (!requestedArgs[1]?.trim() || requestedArgs[1].startsWith("-"))) {
        throw new Error(`hypit ${requestedArgs[0]} 缺少 Source 文件路径。先编写工程源文件，再将相对路径作为第二项参数；plan、pricing、build 示例：["${requestedArgs[0]}", "productions/main/runs/final.svrun"]。尚未编写工程时使用 ["doctor"] 检查环境，或 ["help", "${requestedArgs[0]}"] 查看语法，不要重复空参数调用。`);
      }
      const args = requestedArgs[0] === "doctor" && !requestedArgs.some(arg => arg === "--endpoint" || arg.startsWith("--endpoint="))
        ? [...requestedArgs, "--endpoint", "toonflow.generation", "--endpoint", "media.local", "--endpoint", "html.local"]
        : requestedArgs;
      for (const arg of args) {
        const [flag, value = arg] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
        if (["--project", "--asset-root", "--package-root", "--runtime"].includes(flag!)) throw new Error(`${flag} 由 Toonflow 固定为当前项目，不能修改`);
        // ACT: 只拦截绝对路径和 .. 越界；hypit 内部按项目根目录解析其余相对路径。
        if ((isAbsolute(value) && !isWithin(cwd, resolve(value))) || value.split(/[\\/]/).includes("..")) {
          throw new Error(`参数 ${arg} 超出当前复刻项目目录`);
        }
      }
      if (args[0] === "build") {
        resolveModelSelection(selectedModels);
        const plan = await runHypit(cwd, ["plan", args[1]!, "--json"], signal);
        if (plan.code !== 0) throw new Error(`生成提交前的工程检查失败，请先修正工程：\n${plan.output}`);
        let planData: unknown;
        try { planData = JSON.parse(plan.output); }
        catch { throw new Error("无法读取完整生成计划，已阻止提交；请先检查 hypit plan 的输出"); }
        const report = z.object({
          format: z.literal("hypit.cli-plan@1"),
          ok: z.literal(true),
          needs: z.array(z.object({ capability: z.string() })),
        }).safeParse(planData);
        if (!report.success) throw new Error("无法读取完整生成计划，已阻止提交；请先检查 hypit plan 的输出");
        for (const need of report.data.needs) {
          const match = /^@hypit\/(seedance|seedream)@[^#]+#(.+)$/.exec(need.capability);
          if (!match) continue;
          const expected = match[1] === "seedance" ? selectedModels.video : selectedModels.image;
          if (match[2] !== expected) {
            throw new Error(`工程使用 ${match[2]}，本轮用户选择为 ${expected || "未选择该类生成模型"}，已阻止生成。请先按用户选择修改工程，再重新 plan、pricing，不要自动改选模型。`);
          }
        }
      }
      const result = await runHypit(cwd, args, signal, output => onUpdate?.({ content: [{ type: "text", text: output }], details: {} }));
      if (args[0] === "transcribe" && result.code !== 0 && result.output.includes("source contains no audio stream")) {
        const text = "退出码：0\n未检测到音频流，已跳过语音转录。请继续使用画面和时长分析参考视频，并向用户说明该素材没有可转录的声音。";
        return { content: [{ type: "text", text }], details: { code: 0, skipped: "no-audio" } };
      }
      const text = `退出码：${result.code}\n${result.output}`;
      if (result.code !== 0) throw new Error(text);
      return { content: [{ type: "text", text }], details: { code: result.code } };
    },
  };
}
