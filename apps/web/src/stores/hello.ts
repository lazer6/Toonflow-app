import { computed } from "vue";
import { defineStore } from "pinia";
import { customProviders, saveSettings, settings } from "@/stores/settings";

export const useHelloStore = defineStore("hello", () => {
  const completed = computed(() => settings.value.helloCompleted === true);

  async function load() {
    // 开发环境直接跳过引导
    if (import.meta.env.DEV) {
      await complete();
      return true;
    }
    if (typeof settings.value.helloCompleted === "boolean") return completed.value;
    let previouslyCompleted = false;
    try {
      previouslyCompleted = JSON.parse(localStorage.getItem("toonflow.hello") ?? "null")?.completed === true;
    } catch {
      // ACT: 旧缓存不可读时仍可从已配置的模型恢复；桌面随机端口之间无法迁移 localStorage。
    }
    if (previouslyCompleted || customProviders.value.some(provider => typeof provider.apiKey === "string" && provider.apiKey.trim() && provider.models.length))
      await complete();
    return completed.value;
  }

  async function complete() {
    await saveSettings(() => ({ helloCompleted: true }));
  }

  async function reset() {
    await saveSettings(() => ({ helloCompleted: false }));
  }

  return { completed, load, complete, reset };
});
