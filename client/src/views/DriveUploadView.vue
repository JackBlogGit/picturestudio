<script setup lang="ts">
/**
 * 网盘上传面板（手绘稿 18），只活在网盘页的「上传」标签里（D18，不再有独立上传页）。
 * 目的地只从 /drive/upload-targets 来，面板不自己判断哪个目录能写；
 * 白名单、单文件上限与配额都在登记接口里判，不合格的文件在队列里留下原因，不静默丢弃（PRD 4.5）。
 * 真接口是先分片传字节再登记元数据，这里逐份提交元数据，校验口径一致。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { createFolder, uploadFileMeta, uploadTargets } from '@/api/drive';
import { errorText, USE_MOCK } from '@/api/client';
import type { FileView, UploadTarget } from '@/types/api';
import { FOLDER_KIND_LABEL, UserLevel } from '@/types/api';
import { formatBytes } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

interface UploadTask {
  key: number;
  name: string;
  /** 选文件夹时带上的相对路径，只用于展示：这一层不重建目录结构 */
  relPath: string;
  size: number;
  type: string;
  progress: number;
  state: '排队' | '上传中' | '已完成' | '失败';
  detail: string;
  file: File;
}

const props = withDefaults(defineProps<{ presetFolder?: number }>(), { presetFolder: 0 });

const TABS = [
  { name: 'upload', label: '上传' },
  { name: 'running', label: '上传中' },
  { name: 'done', label: '已完成' },
] as const;

type TabName = (typeof TABS)[number]['name'];

const session = useSessionStore();
const route = useRoute();

const targets = ref<UploadTarget[]>([]);
const folderId = ref<number>(0);
const tasks = ref<UploadTask[]>([]);
const tab = ref<TabName>('upload');
const running = ref(false);
const loading = ref(false);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const dirInput = ref<HTMLInputElement | null>(null);
let seed = 0;

const folderDialog = reactive({ open: false, name: '' });

const selectable = computed(() => targets.value.filter((t) => !t.disabledReason));
const currentTarget = computed(() => targets.value.find((t) => t.id === folderId.value) ?? null);
const pending = computed(() => tasks.value.filter((t) => t.state === '排队' || t.state === '上传中'));
const finished = computed(() => tasks.value.filter((t) => t.state === '已完成' || t.state === '失败'));
const activeTasks = computed(() => tasks.value.filter((t) => t.state === '上传中' || t.state === '排队'));
const totalBytes = computed(() => tasks.value.reduce((sum, t) => sum + t.size, 0));

async function loadTargets(): Promise<void> {
  loading.value = true;
  try {
    targets.value = await uploadTargets();
    const canPick = (id: number): boolean => targets.value.some((t) => t.id === id && !t.disabledReason);
    const fromQuery = Number(route.query.folder);
    const wanted = props.presetFolder || fromQuery;
    if (wanted && canPick(wanted)) {
      folderId.value = wanted;
      return;
    }
    if (canPick(folderId.value)) return;
    folderId.value = selectable.value[0]?.id ?? 0;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

// 内嵌时宿主换了目录，目的地跟着切过去，但没上传权的目录不切（规则 10）
watch(
  () => props.presetFolder,
  (id) => {
    if (id && targets.value.some((t) => t.id === id && !t.disabledReason)) folderId.value = id;
  },
);

/** 客户端不猜类型：能不能传、能传多大由登记接口按站点设置说了算 */
function pickFiles(list: FileList | null): void {
  if (!list?.length) return;
  const next: UploadTask[] = [];
  for (const file of Array.from(list)) {
    next.push({
      key: (seed += 1),
      name: file.name,
      relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '',
      size: file.size,
      type: file.type,
      progress: 0,
      state: '排队',
      detail: '',
      file,
    });
  }
  tasks.value = [...tasks.value, ...next];
  tab.value = 'upload';
}

function onFileInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  pickFiles(input.files);
  // 不清空的话，连续选同一个文件时 change 不会触发
  input.value = '';
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  pickFiles(event.dataTransfer?.files ?? null);
}

async function submitAll(): Promise<void> {
  if (!folderId.value) {
    ElMessage.warning('先选一个有上传权的目的地');
    return;
  }
  const queue = tasks.value.filter((t) => t.state === '排队');
  if (!queue.length) {
    ElMessage.info('队列里没有待传文件');
    return;
  }
  running.value = true;
  tab.value = 'running';
  let ok = 0;
  let failed = 0;
  for (const task of queue) {
    task.state = '上传中';
    task.detail = USE_MOCK ? '演示模式只登记元数据，字节不写盘' : '分片上传中';
    try {
      const view: FileView = await uploadFileMeta({
        folderId: folderId.value,
        filename: task.name,
        fileSize: task.size,
        mimeType: task.type,
      });
      task.progress = 100;
      task.state = '已完成';
      task.detail = `#${view.id} · ${currentTarget.value?.trail ?? ''}`;
      ok += 1;
    } catch (err) {
      task.state = '失败';
      task.detail = errorText(err);
      failed += 1;
    }
  }
  running.value = false;
  tab.value = 'done';
  await loadTargets();
  if (failed) ElMessage.warning(`${ok} 个已登记，${failed} 个被拒绝，原因见「已完成」列表`);
  else ElMessage.success(`${ok} 个文件已登记到 ${currentTarget.value?.trail ?? '网盘'}`);
}

function clearFinished(): void {
  tasks.value = tasks.value.filter((t) => t.state === '排队' || t.state === '上传中');
}

function retryFailed(): void {
  for (const task of tasks.value) {
    if (task.state !== '失败') continue;
    task.state = '排队';
    task.detail = '';
    task.progress = 0;
  }
  tab.value = 'upload';
}

async function submitFolder(): Promise<void> {
  const name = folderDialog.name.trim();
  if (!name) {
    ElMessage.warning('目录名不能为空');
    return;
  }
  running.value = true;
  try {
    const node = await createFolder({ name, parentId: folderId.value || null });
    folderDialog.open = false;
    folderDialog.name = '';
    await loadTargets();
    folderId.value = node.id;
    ElMessage.success(`已建好「${node.name}」，用途与权限随上级`);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    running.value = false;
  }
}

function openFolderDialog(): void {
  if (!currentTarget.value && session.level < UserLevel.SuperAdmin) {
    ElMessage.warning('顶层目录由系统按用途创建，先选一个有改动权的上级');
    return;
  }
  folderDialog.name = '';
  folderDialog.open = true;
}

onMounted(loadTargets);
</script>

<template>
  <section class="pk-up">
    <div class="pk-up__tabs">
      <button
        v-for="item in TABS"
        :key="item.name"
        type="button"
        class="pk-tab"
        :class="{ 'is-active': tab === item.name }"
        @click="tab = item.name"
      >
        {{ item.label }}
        <span v-if="item.name === 'running' && activeTasks.length" class="pk-tab__badge">
          {{ activeTasks.length }}
        </span>
        <span v-if="item.name === 'done' && finished.length" class="pk-tab__badge">{{ finished.length }}</span>
      </button>
    </div>

    <div v-show="tab === 'upload'">
      <p class="pk-muted pk-up__note">
        目的地只列出有上传权的目录（规则 10）；扩展名、单文件上限与配额由服务端按站点设置判定，被拒的文件留在队列里写清原因。
        <template v-if="USE_MOCK">当前为演示模式，只登记元数据，字节不写入磁盘。</template>
      </p>
      <div v-loading="loading" class="pk-card pk-up__dest">
        <span class="pk-up__label">上传目的地：</span>
        <el-select v-model="folderId" size="default" placeholder="选择目录" class="pk-up__select">
          <el-option v-for="t in targets" :key="t.id" :label="t.trail" :value="t.id" :disabled="!!t.disabledReason">
            <div class="pk-up__option">
              <span>{{ t.trail }}</span>
              <span v-if="t.disabledReason" class="pk-muted">{{ t.disabledReason }}</span>
            </div>
          </el-option>
        </el-select>
        <el-button size="default" @click="openFolderDialog">＋</el-button>
        <span v-if="currentTarget" class="pk-chip pk-chip--ghost">{{ FOLDER_KIND_LABEL[currentTarget.kind] }}</span>
        <span class="pk-muted pk-up__note">
          可选 {{ selectable.length }} 个目录{{ targets.length - selectable.length ? ` · ${targets.length - selectable.length} 个只读` : '' }}
        </span>
      </div>

      <div
        class="pk-card pk-drop"
        :class="{ 'is-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="onDrop"
      >
        <p class="pk-up__label pk-drop__title">上传文件</p>
        <p class="pk-muted">把文件拖到这里，或用下面的按钮从本地选。</p>
        <div class="pk-drop__actions">
          <input ref="fileInput" class="pk-up__input" type="file" multiple @change="onFileInput" />
          <el-button type="primary" @click="fileInput?.click()">本地上传文件</el-button>
          <input ref="dirInput" class="pk-up__input" type="file" webkitdirectory multiple @change="onFileInput" />
          <el-button @click="dirInput?.click()">本地上传文件夹</el-button>
        </div>
        <p class="pk-muted pk-drop__hint">
          选文件夹时只把文件带进来，相对路径显示在队列里，这一层不重建目录层级；
          要分目录就先用「＋」在目的地下面建好，再分批选。
        </p>
      </div>

      <div v-if="tasks.length" class="pk-card pk-queue">
        <div class="pk-queue__head">
          <span>队列 {{ tasks.length }} 个 · 合计 {{ formatBytes(totalBytes) }}</span>
          <div>
            <el-button size="small" :disabled="!finished.some((t) => t.state === '失败')" @click="retryFailed">
              重试失败项
            </el-button>
            <el-button size="small" :disabled="!finished.length" @click="clearFinished">清除已完成</el-button>
            <el-button size="small" type="primary" :loading="running" @click="submitAll">开始上传</el-button>
          </div>
        </div>
        <ul class="pk-queue__list">
          <li v-for="task in tasks" :key="task.key" class="pk-task">
            <div class="pk-task__body">
              <div class="pk-task__name">
                <strong>{{ task.name }}</strong>
                <span class="pk-muted">{{ formatBytes(task.size) }} · {{ task.state }}</span>
              </div>
              <el-progress :percentage="task.progress" :stroke-width="6" :show-text="false" />
              <span class="pk-muted pk-task__detail">{{ task.relPath || task.detail }}</span>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div v-show="tab === 'running'" class="pk-card pk-queue">
      <p v-if="!activeTasks.length" class="pk-muted">没有正在进行的上传任务。</p>
      <ul v-else class="pk-queue__list">
        <li v-for="task in activeTasks" :key="task.key" class="pk-task">
          <div class="pk-task__body">
            <div class="pk-task__name">
              <strong>{{ task.name }}</strong>
              <span class="pk-muted">{{ formatBytes(task.size) }} · {{ task.state }}</span>
            </div>
            <el-progress :percentage="task.progress" :stroke-width="6" :show-text="false" />
            <span class="pk-muted pk-task__detail">{{ task.detail }}</span>
          </div>
        </li>
      </ul>
    </div>

    <div v-show="tab === 'done'" class="pk-card pk-queue">
      <p v-if="!finished.length" class="pk-muted">还没有已结束的上传任务。</p>
      <ul v-else class="pk-queue__list">
        <li v-for="task in finished" :key="task.key" class="pk-task">
          <div class="pk-task__body">
            <div class="pk-task__name">
              <strong>{{ task.name }}</strong>
              <span :class="task.state === '失败' ? 'pk-up__fail' : 'pk-muted'">
                {{ formatBytes(task.size) }} · {{ task.state }}
              </span>
            </div>
            <span class="pk-muted pk-task__detail">{{ task.detail }}</span>
          </div>
        </li>
      </ul>
    </div>

    <el-dialog v-model="folderDialog.open" title="在目的地下面新建目录" width="min(480px, 92vw)">
      <el-form label-position="top">
        <el-form-item :label="`名称（上级：${currentTarget?.trail ?? '根目录'}）`">
          <el-input v-model="folderDialog.name" maxlength="60" placeholder="同级不能重名" @keyup.enter="submitFolder" />
        </el-form-item>
        <p class="pk-muted pk-up__note">
          新目录的用途与权限随上级，建完直接选为目的地；上级没有改动权时这一步会被服务端挡下（规则 9）。
        </p>
      </el-form>
      <template #footer>
        <el-button @click="folderDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="running" @click="submitFolder">创建</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-up__tabs {
  display: flex;
  gap: 4px;
  margin: 14px 0 12px;
  border-bottom: 1px solid var(--pk-line);
}

.pk-tab {
  border: 0;
  background: none;
  padding: 8px 14px;
  font-size: 14px;
  color: var(--pk-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.pk-tab.is-active {
  color: var(--pk-brand);
  border-bottom-color: var(--pk-brand);
  font-weight: 600;
}

.pk-tab__badge {
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
  border-radius: 9px;
  font-size: 11px;
  padding: 0 6px;
  line-height: 16px;
}

.pk-up__dest {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 14px;
}

.pk-up__label {
  font-size: 14px;
  font-weight: 600;
}

.pk-up__select {
  width: min(420px, 100%);
}

.pk-up__option {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  padding: 2px 0;
}

.pk-up__option .pk-muted {
  font-size: 11px;
}

.pk-up__note {
  font-size: 12px;
  margin: 0;
  line-height: 1.7;
}

.pk-up__fail {
  color: #d64545;
}

.pk-drop {
  margin: 16px 0;
  padding: 24px 20px;
  text-align: center;
  border: 1px dashed var(--pk-line);
  transition: border-color 0.16s ease, background 0.16s ease;
}

.pk-drop.is-over {
  border-color: var(--pk-brand);
  background: var(--pk-brand-soft);
}

.pk-drop__title {
  margin: 0 0 6px;
}

.pk-drop__actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 12px;
}

.pk-up__input {
  display: none;
}

.pk-drop__hint {
  font-size: 12px;
  margin: 14px auto 0;
  line-height: 1.7;
  max-width: 620px;
}

.pk-queue {
  padding: 14px 16px 6px;
}

.pk-queue__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  margin-bottom: 10px;
}

.pk-queue__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pk-task {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--pk-line);
}

.pk-task__body {
  flex: 1;
  min-width: 0;
}

.pk-task__name {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 6px;
}

.pk-task__name strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-task__detail {
  font-size: 12px;
  display: block;
  margin-top: 4px;
}

@media (max-width: 640px) {
  .pk-up__select {
    width: 100%;
  }
}
</style>
