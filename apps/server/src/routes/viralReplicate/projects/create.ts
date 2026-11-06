import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ name: z.string().trim().min(1).max(80) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.json(success(await u.viralReplicate.createProject(req.body.name)));
});
