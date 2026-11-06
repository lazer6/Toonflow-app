<template>
  <div class="viralReplicate">
    <aside class="projectSidebar" aria-label="复刻项目">
      <div class="sidebarHeader">
        <el-button text circle aria-label="返回首页" title="返回首页" @click="router.push('/home')"><icon-arrow-left :size="18" /></el-button>
        <span class="sidebarTitle">爆款复刻</span>
      </div>
      <button class="sidebarItem newProject" type="button" :disabled="creating" @click="createProject">
        <icon-plus :size="18" aria-hidden="true" />
        <span class="sidebarText">新建复刻</span>
      </button>
      <hr class="sidebarDivider" />
      <nav v-loading="loading" class="projectList" aria-label="复刻项目列表">
        <div v-for="item in projects" :key="item.directory" class="projectItem" :class="{ active: item.directory === directory }">
          <button class="sidebarItem" type="button" :aria-current="item.directory === directory ? 'page' : undefined" :title="item.name" @click="directory = item.directory">
            <icon-movie :size="18" aria-hidden="true" />
            <span class="sidebarText">{{ item.name }}</span>
          </button>
          <button class="deleteProject" type="button" :disabled="!!deletingDirectory" :aria-label="`删除项目 ${item.name}`" :title="`删除项目 ${item.name}`" @click="deleteProject(item)">
            <icon-trash :size="16" aria-hidden="true" />
          </button>
        </div>
      </nav>
      <div class="sidebarFooter">
        <button class="sidebarItem" type="button" aria-label="爆款复刻配置" title="爆款复刻配置" @click="settingsVisible = true">
          <icon-settings :size="18" aria-hidden="true" />
          <span class="sidebarText">爆款复刻配置</span>
        </button>
      </div>
    </aside>
    <main class="chatPanel">
      <div class="modelToolbar" aria-label="生成模型选择">
        <div class="modelField">
          <label for="viralVideoModel">视频模型</label>
          <el-select id="viralVideoModel" v-model="selectedVideoModel" :loading="modelsLoading" :disabled="modelsLoading || !videoModels.length" placeholder="请先配置视频模型" aria-label="视频模型">
            <el-option v-for="item in videoModels" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </div>
        <div class="modelField">
          <label for="viralImageModel">图像模型</label>
          <el-select id="viralImageModel" v-model="selectedImageModel" :loading="modelsLoading" :disabled="modelsLoading || !imageModels.length" placeholder="请先配置图像模型" aria-label="图像模型">
            <el-option v-for="item in imageModels" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </div>
        <el-button text @click="settingsVisible = true">配置模型</el-button>
      </div>
      <agent v-if="directory" :key="directory" :modelValue="true" :directory="directory" :viralReplicateModels="{ video: selectedVideoModel, image: selectedImageModel }" @update:modelValue="router.push('/home')" />
    </main>
    <settingsDialog v-model="settingsVisible" @saved="loadModels" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox, ElSelect, ElOption } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import { IconArrowLeft, IconPlus, IconMovie, IconSettings, IconTrash } from "@tabler/icons-vue";
import http from "@/lib/http";
import agent from "@/components/agent/index.vue";
import settingsDialog from "./settingsDialog.vue";
import { settings, settingsStorage } from "@/stores/settings";

type Project = { directory: string; name: string; modified: number };

const router = useRouter();
const projects = ref<Project[]>([]);
const directory = ref("");
const loading = ref(false);
const creating = ref(false);
const deletingDirectory = ref("");
const settingsVisible = ref(false);
const savedModels = (settings.value.stores as Record<string, { video?: string; image?: string }> | undefined)?.["toonflow.viralReplicateModels"];
const selectedVideoModel = ref(savedModels?.video ?? "");
const selectedImageModel = ref(savedModels?.image ?? "");
const configuredModels = ref<Record<string, string>>({});
const modelsLoading = ref(true);

const videoModelOptions = [
  { label: "Seedance 2.0", value: "seedance-2" },
  { label: "Seedance 2.0 Fast", value: "seedance-2-fast" },
  { label: "Seedance 2.0 Mini", value: "seedance-2-mini" },
  { label: "Seedance 2.5", value: "seedance-2.5" },
];
const imageModelOptions = [
  { label: "Seedream 5.0 Lite", value: "seedream-5-lite" },
];
const videoModels = computed(() => videoModelOptions.filter(item => configuredModels.value[item.value]?.trim()));
const imageModels = computed(() => imageModelOptions.filter(item => configuredModels.value[item.value]?.trim()));

watch([selectedVideoModel, selectedImageModel], ([video, image]) => {
  settingsStorage.setItem("toonflow.viralReplicateModels", JSON.stringify({ video, image }));
});

async function loadModels() {
  modelsLoading.value = true;
  try {
    const settings = await http<{ models: Record<string, string> }>({ method: "GET", url: "/api/viralReplicate/settings/get" });
    configuredModels.value = settings.models;
    if (!videoModels.value.some(item => item.value === selectedVideoModel.value)) selectedVideoModel.value = videoModels.value[0]?.value ?? "";
    if (!imageModels.value.some(item => item.value === selectedImageModel.value)) selectedImageModel.value = imageModels.value[0]?.value ?? "";
  } catch (error) {
    configuredModels.value = {};
    selectedVideoModel.value = "";
    selectedImageModel.value = "";
    ElMessage.error(error instanceof Error ? error.message : "读取模型配置失败");
  } finally {
    modelsLoading.value = false;
  }
}

async function loadProjects() {
  loading.value = true;
  try {
    projects.value = await http<Project[]>({ method: "GET", url: "/api/viralReplicate/projects/list" });
    if (!projects.value.some(item => item.directory === directory.value)) directory.value = projects.value[0]?.directory ?? "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "读取复刻项目失败");
  } finally {
    loading.value = false;
  }
}

async function createProject() {
  const name = await ElMessageBox.prompt(translate("为这次复刻起个名字"), translate("新建复刻"), {
    inputValue: translate("新的复刻"),
    inputValidator: value => !!value.trim() && value.trim().length <= 80,
    inputErrorMessage: translate("请输入 1–80 个字符的名称"),
  }).then(({ value }) => value.trim(), () => undefined);
  if (!name) return;
  creating.value = true;
  try {
    const project = await http<Project>({ method: "POST", url: "/api/viralReplicate/projects/create", data: { name } });
    projects.value.unshift(project);
    directory.value = project.directory;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "新建复刻失败");
  } finally {
    creating.value = false;
  }
}

async function deleteProject(item: Project) {
  const confirmed = await ElMessageBox.confirm(`删除“${item.name}”及其本地文件？此操作不可撤销。`, "删除复刻项目", {
    type: "warning", confirmButtonText: "删除", cancelButtonText: "取消",
  }).then(() => true, () => false);
  if (!confirmed) return;
  deletingDirectory.value = item.directory;
  try {
    await http({ method: "DELETE", url: "/api/viralReplicate/projects/delete", data: { directory: item.directory } });
    const index = projects.value.findIndex(project => project.directory === item.directory);
    if (index >= 0) projects.value.splice(index, 1);
    if (directory.value === item.directory) directory.value = projects.value[0]?.directory ?? "";
    ElMessage.success("项目已删除");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "删除复刻项目失败");
  } finally {
    deletingDirectory.value = "";
  }
}

onMounted(async () => {
  await loadModels();
  await loadProjects();
});
</script>

<style lang="scss" scoped>
.viralReplicate {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  height: 100dvh;
  overflow: hidden;
  color: var(--el-text-color-primary);
  background: color-mix(in srgb, var(--el-bg-color) 96%, var(--el-text-color-primary));

  .projectSidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 20px 12px 16px;
    border-inline-end: 1px solid var(--el-border-color-lighter);

    .sidebarHeader {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      margin-bottom: 24px;

      .sidebarTitle { font-size: 18px; font-weight: 600; }
      svg:dir(rtl) { transform: scaleX(-1); }
    }

    .sidebarDivider { margin: 12px 8px; border: 0; border-top: 1px solid var(--el-border-color-lighter); }

    .projectList {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 4px;
      min-height: 0;
      overflow-y: auto;

      .projectItem {
        display: flex;
        gap: 2px;
        min-width: 0;
        border-radius: var(--ui-radius);

        &.active { background: var(--el-fill-color-darker); }

        .sidebarItem { flex: 1; min-width: 0; }

        .deleteProject {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 38px;
          border: 0;
          border-radius: var(--ui-radius);
          background: transparent;
          color: var(--el-text-color-secondary);
          cursor: pointer;

          &:hover:not(:disabled) { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
          &:disabled { cursor: wait; opacity: 0.6; }
        }
      }
    }

    .sidebarFooter { padding-top: 16px; }

    .sidebarItem {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      width: 100%;
      min-height: 42px;
      gap: 10px;
      padding: 10px 12px;
      border: 0;
      border-radius: var(--ui-radius);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      font-size: 14px;
      line-height: 1.5;
      text-align: start;
      cursor: pointer;

      > svg { flex-shrink: 0; }
      .sidebarText { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

      &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
      &:disabled { cursor: wait; opacity: 0.6; }
      &.active { color: var(--el-text-color-primary); font-weight: 500; }
    }
  }

  .chatPanel {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
    min-height: 0;
    padding: 12px 16px 0;

    > * { width: 100%; max-width: 920px; }

    .modelToolbar {
      display: flex;
      flex-shrink: 0;
      align-items: flex-end;
      flex-wrap: wrap;
      gap: 12px;
      padding: 8px 0 16px;
      border-bottom: 1px solid var(--el-border-color-lighter);

      .modelField {
        flex: 1 1 200px;
        min-width: 0;
        max-width: 300px;

        label { display: block; margin-bottom: 6px; color: var(--el-text-color-secondary); font-size: 13px; }
        .el-select { width: 100%; }
      }
    }

    > .agent { flex: 1; min-height: 0; }
  }

  @media (max-width: 900px) {
    grid-template-columns: 72px minmax(0, 1fr);

    .projectSidebar {
      .sidebarHeader .sidebarTitle, .sidebarItem .sidebarText { display: none; }
      .sidebarItem { justify-content: center; padding-inline: 0; }
    }
  }
}
</style>
