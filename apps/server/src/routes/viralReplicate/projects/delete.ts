import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const inputSchema = z.strictObject({ directory: z.string().trim().min(1).max(4096) });

export default Router().delete("/", validateFields(inputSchema.shape), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { directory } = inputSchema.parse(req.body);
  await u.viralReplicate.deleteProject(directory);
  res.json(success(null, "项目已删除"));
});
