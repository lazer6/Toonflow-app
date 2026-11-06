import u from "@/utils";
import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", validateFields(u.viralReplicate.settingsSchema.shape), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const settings = u.viralReplicate.settingsSchema.parse(req.body);
  res.json(success(u.viralReplicate.publicSettings(u.viralReplicate.saveSettings(settings))));
});
