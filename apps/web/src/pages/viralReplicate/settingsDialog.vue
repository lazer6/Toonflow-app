<template>
  <el-dialog
    v-model="visible"
    title="配置媒体模型"
    width="min(560px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving"
    @open="load">
    <el-form v-loading="loading" class="settingsForm" labelPosition="top" @submit.prevent="save">
      <el-alert v-if="settings && !settings.hypitReady" class="hypitAlert" type="warning" :closable="false" showIcon
        :title="`未找到可运行的 hypit：${settings.hypitRoot}`" description="请在该目录执行 pnpm install 后重新打开设置。" />
      <el-form-item label="Base URL">
        <el-input v-model="form.baseUrl" placeholder="https://ark.cn-beijing.volces.com/api/v3" />
        <el-text class="fieldHint" type="info" size="small">兼容火山方舟视频任务（/contents/generations/tasks）与图片生成（/images/generations）接口的服务地址。</el-text>
      </el-form-item>
      <el-form-item label="API Key">
        <el-input v-model="apiKey" type="password" showPassword autocomplete="off" :placeholder="settings?.hasApiKey ? '已保存，留空则不修改' : '请输入 API Key'" />
      </el-form-item>
      <el-form-item v-for="item in modelFields" :key="item.name" :label="item.label">
        <el-input v-model="form.models[item.name]" :placeholder="item.placeholder" />
      </el-form-item>
      <el-form-item label="Node 路径">
        <el-input v-model="form.nodePath" placeholder="node" />
        <el-text class="fieldHint" type="info" size="small">hypit 需要 Node.js 22.15 或更高版本，默认使用系统 PATH 中的 node。</el-text>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import http from "@/lib/http";

type ModelName = "seedance-2" | "seedance-2-fast" | "seedance-2-mini" | "seedance-2.5" | "seedream-5-lite";
type Settings = { baseUrl: string; models: Partial<Record<ModelName, string>>; nodePath: string; hasApiKey: boolean; hypitRoot: string; hypitReady: boolean };

const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ saved: [] }>();
const modelFields: { name: ModelName; label: string; placeholder: string }[] = [
  { name: "seedance-2", label: "Seedance 2.0 视频模型 ID", placeholder: "填写服务商的 Seedance 2.0 模型 ID" },
  { name: "seedance-2-fast", label: "Seedance 2.0 Fast 视频模型 ID（可选）", placeholder: "留空表示不使用" },
  { name: "seedance-2-mini", label: "Seedance 2.0 Mini 视频模型 ID（可选）", placeholder: "留空表示不使用" },
  { name: "seedance-2.5", label: "Seedance 2.5 视频模型 ID（可选）", placeholder: "留空表示不使用" },
  { name: "seedream-5-lite", label: "Seedream 5.0 Lite 图片模型 ID", placeholder: "填写服务商的 Seedream 5.0 Lite 模型 ID" },
];
const settings = ref<Settings>();
const form = reactive<{ baseUrl: string; models: Partial<Record<ModelName, string>>; nodePath: string }>({ baseUrl: "", models: {}, nodePath: "node" });
const apiKey = ref("");
const loading = ref(false);
const saving = ref(false);

async function load() {
  loading.value = true;
  apiKey.value = "";
  try {
    settings.value = await http<Settings>({ method: "GET", url: "/api/viralReplicate/settings/get" });
    Object.assign(form, { baseUrl: settings.value.baseUrl, models: { ...settings.value.models }, nodePath: settings.value.nodePath });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "读取设置失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value || loading.value) return;
  saving.value = true;
  try {
    await http({ method: "PUT", url: "/api/viralReplicate/settings/save", data: { ...form, ...(apiKey.value ? { apiKey: apiKey.value } : {}) } });
    ElMessage.success("设置已保存");
    visible.value = false;
    emit("saved");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存设置失败");
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.settingsForm {
  max-height: min(64vh, 640px);
  overflow-y: auto;
  padding-inline-end: 4px;

  .hypitAlert { margin-bottom: 16px; }
  .fieldHint { display: block; margin-top: 4px; line-height: 1.5; }
}
</style>
