"use strict";

const os = require("node:os");
const moduleApi = require("node:module");

if (!os.__toonflowUserInfoPatched) {
  const originalUserInfo = os.userInfo;
  os.userInfo = function toonflowUserInfo() {
    try {
      return originalUserInfo.call(os);
    } catch {
      return {
        uid: -1,
        gid: -1,
        username: process.env.USERNAME || process.env.USER || "toonflow",
        homedir: process.env.USERPROFILE || process.env.HOME || process.cwd(),
        shell: null,
      };
    }
  };
  Object.defineProperty(os, "__toonflowUserInfoPatched", { value: true });
  moduleApi.syncBuiltinESMExports();
}
