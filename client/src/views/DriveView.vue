<script setup lang="ts">
/**
 * 网盘文件页（手绘稿 19）：面包屑 + 文件夹卡片 + 文件网格/列表双视图。
 * 按钮一律跟着目录回执里的 perms 渲染，页面不重复判断目录用途（规则 9/10 的越权提示因此和后端同源）。
 * 下载走本地任务队列，所以「下载中 / 已完成」两个页签看到的是真实受理结果，mock 模式不回字节。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import DriveUploadView from './DriveUploadView.vue';
import {
  batchZipFiles,
  createFolder,
  deleteFile,
  deleteFolder,
  driveTree,
  listFiles,
  purgeFile,
  purgeFolder,
  restoreFile,
  restoreFolder,
  updateFolder,
} from '@/api/drive';
import type { DriveSort } from '@/api/drive';
import { errorText, previewSrc, USE_MOCK } from '@/api/client';
import type { BatchZipResult, FileView, FolderNode, Page } from '@/types/api';
import { FOLDER_KIND_LABEL, FolderKind } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const PREVIEW_LABEL: Record<FileView['previewStatus'], string> = {
  0: '预览待生成',
  1: '可预览',
  2: '该格式不出预览',
  3: '预览生成失败',
};

const TABS = [
  { name: 'files', label: '文件' },
  { name: 'downloading', label: '下载中' },
  { name: 'done', label: '已完成' },
  { name: 'upload', label: '上传' },
] as const;

type TabName = (typeof TABS)[number]['name'];

interface DownloadJob {
  key: number;
  label: string;
  size: number;
  state: '下载中' | '已完成';
  detail: string;
}

const tree = ref<FolderNode[]>([]);
const currentId = ref<number>(0);
const files = ref<FileView[]>([]);
const total = ref(0);
const loading = ref(false);
const busy = ref(false);
/** 标签态挂在查询串上（D18）：宫格「传文件」深链 `/drive?tab=upload`，刷新与前进后退都回得到原标签 */
const tab = ref<TabName>(tabFromQuery());

function tabFromQuery(): TabName {
  const raw = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab;
  return TABS.some((item) => item.name === raw) ? (raw as TabName) : 'files';
}

function selectTab(next: TabName): void {
  tab.value = next;
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(route.query)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (key !== 'tab' && single !== null && single !== undefined) query[key] = single;
  }
  // 「文件」是默认标签，不占查询串
  if (next !== 'files') query.tab = next;
  void router.replace({ query });
}

watch(
  () => route.query.tab,
  () => {
    tab.value = tabFromQuery();
  },
);
const view = ref<'grid' | 'list'>('grid');
const multiSelect = ref(false);
const selectedFiles = ref<number[]>([]);
const selectedFolders = ref<number[]>([]);
const jobs = ref<DownloadJob[]>([]);
let jobSeq = 0;

const query = reactive({ kw: '', sort: 'time' as DriveSort, asc: false, page: 1, pageSize: 60 });

const folderDialog = reactive({
  open: false,
  mode: 'create' as 'create' | 'rename',
  id: 0,
  name: '',
  description: '',
  parentId: 0,
});

/** 目录回执里带权限位，页面只查这张表 */
const byId = computed(() => {
  const map = new Map<number, FolderNode>();
  const walk = (nodes: FolderNode[]): void => {
    for (const node of nodes) {
      map.set(node.id, node);
      walk(node.children);
    }
  };
  walk(tree.value);
  return map;
});

const current = computed<FolderNode | null>(() => (currentId.value ? byId.value.get(currentId.value) ?? null : null));

const crumbs = computed<FolderNode[]>(() => {
  const trail: FolderNode[] = [];
  let cursor = current.value;
  while (cursor) {
    trail.unshift(cursor);
    cursor = cursor.parentId ? byId.value.get(cursor.parentId) ?? null : null;
  }
  return trail;
});

const childFolders = computed<FolderNode[]>(() => {
  const kw = query.kw.trim().toLowerCase();
  // 搜索是全盘范围：目录列表跟着关键字收，文件由接口的 kw 负责
  if (kw) return [...byId.value.values()].filter((f) => f.name.toLowerCase().includes(kw));
  return current.value ? current.value.children : tree.value;
});

const inTrash = computed(() => current.value?.kind === FolderKind.Trash);

const myUid = computed(() => (session.profile?.kind === 'user' ? session.profile.uid : 0));

const perms = computed(() => current.value?.perms ?? null);
const canCreate = computed(() => (current.value ? current.value.perms.modify : tree.value.some((f) => f.perms.modify)));
const canRename = computed(() => !!perms.value?.modify);
const canDeleteHere = computed(() => !!perms.value?.remove || !!perms.value?.purge);

const selectionCount = computed(() => selectedFiles.value.length + selectedFolders.value.length);

const downloadingJobs = computed(() => jobs.value.filter((j) => j.state === '下载中'));
const doneJobs = computed(() => jobs.value.filter((j) => j.state === '已完成'));

function resetSelection(): void {
  selectedFiles.value = [];
  selectedFolders.value = [];
}

async function loadTree(): Promise<void> {
  try {
    tree.value = await driveTree();
  } catch (err) {
    ElMessage.error(errorText(err));
  }
}

async function loadFiles(): Promise<void> {
  loading.value = true;
  try {
    const kw = query.kw.trim();
    const page: Page<FileView> = await listFiles({
      // 搜索时不限定当前目录，与目录卡片的全盘搜索同一口径
      folder: kw ? undefined : currentId.value || undefined,
      deep: 1,
      kw: kw || undefined,
      sort: query.sort,
      order: query.asc ? 'asc' : 'desc',
      page: query.page,
      pageSize: query.pageSize,
    });
    files.value = page.list;
    total.value = page.total;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function reload(): Promise<void> {
  await Promise.all([loadTree(), loadFiles()]);
}

async function open(node: FolderNode): Promise<void> {
  currentId.value = node.id;
  resetSelection();
  await loadFiles();
}

async function goCrumb(node: FolderNode | null): Promise<void> {
  currentId.value = node?.id ?? 0;
  resetSelection();
  await loadFiles();
}

function goUp(): void {
  void goCrumb(crumbs.value.length > 1 ? crumbs.value[crumbs.value.length - 2] : null);
}

function toggleFile(id: number): void {
  selectedFiles.value = selectedFiles.value.includes(id)
    ? selectedFiles.value.filter((n) => n !== id)
    : [...selectedFiles.value, id];
}

function toggleFolder(id: number): void {
  selectedFolders.value = selectedFolders.value.includes(id)
    ? selectedFolders.value.filter((n) => n !== id)
    : [...selectedFolders.value, id];
}

function selectAll(): void {
  selectedFiles.value = files.value.filter((f) => f.canDelete || f.links.download).map((f) => f.id);
  selectedFolders.value = childFolders.value.filter((f) => f.perms.remove || f.perms.purge).map((f) => f.id);
}

function pickCard(node: FolderNode, event: MouseEvent): void {
  if ((event.target as HTMLElement).closest('.pk-card__menu') || (event.target as HTMLElement).closest('.pk-card__check')) {
    return;
  }
  if (multiSelect.value) toggleFolder(node.id);
  else void open(node);
}

function openFolderDialog(mode: 'create' | 'rename'): void {
  folderDialog.mode = mode;
  if (mode === 'create') {
    folderDialog.id = 0;
    folderDialog.name = '';
    folderDialog.description = '';
    folderDialog.parentId = currentId.value;
  } else {
    if (!current.value) return;
    folderDialog.id = current.value.id;
    folderDialog.name = current.value.name;
    folderDialog.description = current.value.description;
    folderDialog.parentId = current.value.parentId ?? 0;
  }
  folderDialog.open = true;
}

async function submitFolder(): Promise<void> {
  busy.value = true;
  try {
    if (folderDialog.mode === 'create') {
      await createFolder({
        name: folderDialog.name,
        parentId: folderDialog.parentId || null,
        description: folderDialog.description,
      });
      ElMessage.success('目录已创建，用途与权限随上级');
    } else {
      await updateFolder(folderDialog.id, { name: folderDialog.name, description: folderDialog.description });
      ElMessage.success('目录已更新');
    }
    folderDialog.open = false;
    await reload();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

function pushJob(label: string, size: number): DownloadJob {
  jobSeq += 1;
  const job: DownloadJob = { key: jobSeq, label, size, state: '下载中', detail: '' };
  jobs.value = [job, ...jobs.value];
  return job;
}

function finishJob(job: DownloadJob, detail: string): void {
  job.state = '已完成';
  job.detail = detail;
}

function downloadOne(file: FileView): void {
  if (!file.links.download) {
    ElMessage.warning('这个目录没有给你下载权');
    return;
  }
  const job = pushJob(file.filename, file.fileSize);
  if (USE_MOCK) {
    finishJob(job, '演示模式不落盘，真实部署走鉴权下载接口');
    ElMessage.success(`已受理 ${file.filename}`);
    return;
  }
  window.open(file.links.download, '_blank', 'noopener');
  finishJob(job, '已交给浏览器');
}

function summarize(result: BatchZipResult, job: DownloadJob): void {
  if (!result.accepted) {
    job.state = '已完成';
    job.detail = '没有一个文件可以打包';
    ElMessage.warning('没有一个文件可以打包');
  } else {
    finishJob(job, `已受理 ${result.accepted} 个 / 约 ${formatBytes(result.estimatedSize)}`);
    if (USE_MOCK) ElMessage.success(job.detail);
    else window.open(result.zipUrl, '_blank', 'noopener');
  }
  if (!result.rejected.length) return;
  const lines = result.rejected.map((item) => `· #${item.fileId} ${item.code}·${item.message}`).join('\n');
  ElMessageBox.alert(lines, `${result.rejected.length} 个被拒绝，未打包（不静默跳过，PRD 4.5）`, {
    type: 'warning',
  }).catch(() => undefined);
}

async function downloadSelected(): Promise<void> {
  if (!selectionCount.value) {
    ElMessage.warning('先勾选要下载的内容');
    return;
  }
  busy.value = true;
  try {
    // 目录没有自己的下载地址：展开子树取文件，再按文件逐条交给打包接口
    const sizes = new Map<number, number>();
    const wanted = new Set<number>();
    for (const file of files.value) {
      if (selectedFiles.value.includes(file.id)) sizes.set(file.id, file.fileSize);
    }
    for (const id of selectedFiles.value) wanted.add(id);
    for (const folderId of selectedFolders.value) {
      const page = await listFiles({ folder: folderId, deep: 1, pageSize: 200 });
      for (const file of page.list) {
        sizes.set(file.id, file.fileSize);
        wanted.add(file.id);
      }
    }
    const ids = [...wanted];
    if (!ids.length) {
      ElMessage.info('选中的目录里没有文件');
      return;
    }
    const bytes = ids.reduce((n, id) => n + (sizes.get(id) ?? 0), 0);
    const job = pushJob(`批量下载 ${ids.length} 个文件`, bytes);
    try {
      summarize(await batchZipFiles(ids), job);
    } catch (err) {
      job.state = '已完成';
      job.detail = errorText(err);
      ElMessage.error(errorText(err));
    }
    resetSelection();
    await loadFiles();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

async function removeSelected(): Promise<void> {
  const picked = selectionCount.value;
  if (!picked) {
    ElMessage.warning('先勾选要删除的内容');
    return;
  }
  const purgeDirectly = inTrash.value || !!perms.value?.purge;
  try {
    await ElMessageBox.confirm(
      purgeDirectly
        ? `彻底删除 ${picked} 项，不可恢复（规则 8/12）`
        : `删除 ${picked} 项后先进垃圾箱，超管在垃圾箱里清除才算彻底删除（规则 7）`,
      inTrash.value ? '清除垃圾箱内容' : '删除',
      { type: 'warning', confirmButtonText: purgeDirectly ? '彻底删除' : '移进垃圾箱', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busy.value = true;
  let toTrash = 0;
  let purged = 0;
  const failures: string[] = [];
  for (const id of selectedFiles.value) {
    try {
      if ((await deleteFile(id)).purged) purged += 1;
      else toTrash += 1;
    } catch (err) {
      failures.push(`文件 #${id}：${errorText(err)}`);
    }
  }
  for (const id of selectedFolders.value) {
    try {
      const r = await deleteFolder(id);
      if (r.purged) purged += 1;
      else toTrash += 1;
    } catch (err) {
      failures.push(`目录 #${id}：${errorText(err)}`);
    }
  }
  busy.value = false;
  resetSelection();
  await reload();
  const parts: string[] = [];
  if (toTrash) parts.push(`${toTrash} 项进垃圾箱`);
  if (purged) parts.push(`${purged} 项已彻底删除`);
  if (parts.length) ElMessage.success(parts.join('，'));
  if (failures.length) {
    ElMessageBox.alert(failures.map((line) => `· ${line}`).join('\n'), `${failures.length} 项被拒绝`, {
      type: 'warning',
    }).catch(() => undefined);
  }
}

async function restoreSelected(): Promise<void> {
  busy.value = true;
  const failures: string[] = [];
  for (const id of selectedFiles.value) {
    try {
      await restoreFile(id);
    } catch (err) {
      failures.push(`文件 #${id}：${errorText(err)}`);
    }
  }
  for (const id of selectedFolders.value) {
    try {
      await restoreFolder(id);
    } catch (err) {
      failures.push(`目录 #${id}：${errorText(err)}`);
    }
  }
  busy.value = false;
  resetSelection();
  await reload();
  if (failures.length) {
    ElMessageBox.alert(failures.map((line) => `· ${line}`).join('\n'), `${failures.length} 项还原失败`, {
      type: 'warning',
    }).catch(() => undefined);
  } else {
    ElMessage.success('已还原回原目录');
  }
}

async function deleteOneFile(file: FileView): Promise<void> {
  selectedFiles.value = [file.id];
  selectedFolders.value = [];
  await removeSelected();
}

async function restoreFileOne(file: FileView): Promise<void> {
  selectedFiles.value = [file.id];
  selectedFolders.value = [];
  await restoreSelected();
}

/** 彻底删除不可恢复，单条入口也要二次确认（规则 8/12） */
async function confirmPurge(label: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(`${label} 不经过垃圾箱，删除后不可恢复。`, '彻底删除', {
      type: 'warning',
      confirmButtonText: '确认彻底删除',
      cancelButtonText: '取消',
    });
  } catch {
    return false;
  }
  return true;
}

async function purgeOneFile(file: FileView): Promise<void> {
  if (!(await confirmPurge(`文件 ${file.filename}`))) return;
  busy.value = true;
  try {
    await purgeFile(file.id);
    await reload();
    ElMessage.success('已彻底删除');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

async function purgeOneFolder(node: FolderNode): Promise<void> {
  if (!(await confirmPurge(`目录 ${node.name} 及其 ${node.fileCount} 个文件`))) return;
  busy.value = true;
  try {
    await purgeFolder(node.id);
    await reload();
    ElMessage.success('已彻底删除');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

function folderAction(action: 'open' | 'rename' | 'create' | 'delete' | 'restore' | 'purge', node: FolderNode): void {
  if (action === 'open') void open(node);
  if (action === 'rename') {
    currentId.value = node.id;
    openFolderDialog('rename');
  }
  if (action === 'create') {
    currentId.value = node.id;
    openFolderDialog('create');
  }
  if (action === 'delete') {
    selectedFolders.value = [node.id];
    selectedFiles.value = [];
    void removeSelected();
  }
  if (action === 'restore') {
    selectedFolders.value = [node.id];
    selectedFiles.value = [];
    void restoreSelected();
  }
  if (action === 'purge') void purgeOneFolder(node);
}

function onSizeChange(size: number): void {
  query.pageSize = size;
  query.page = 1;
  void loadFiles();
}

function onSearch(): void {
  query.page = 1;
  void loadFiles();
}

function changeSort(): void {
  query.page = 1;
  void loadFiles();
}

onMounted(async () => {
  await reload();
});
</script>

<template>
  <section class="pk-drive">
    <header class="pk-drive__head">
      <div class="pk-drive__nav">
        <el-button size="small" :disabled="!crumbs.length" @click="goUp">返回</el-button>
        <el-button size="small" :loading="loading" @click="reload">刷新</el-button>
        <el-breadcrumb separator="／" class="pk-drive__crumbs">
          <el-breadcrumb-item :to="{ path: '/drive' }">根目录</el-breadcrumb-item>
          <el-breadcrumb-item v-for="node in crumbs" :key="node.id">
            <a @click="goCrumb(node)">{{ node.name }}</a>
          </el-breadcrumb-item>
        </el-breadcrumb>
      </div>
      <div class="pk-drive__who">
        <span class="pk-muted">{{ session.displayName }}</span>
        <span v-if="current" class="pk-chip pk-chip--ghost">{{ FOLDER_KIND_LABEL[current.kind] }}</span>
      </div>
    </header>

    <div class="pk-drive__tabs">
      <button
        v-for="item in TABS"
        :key="item.name"
        type="button"
        class="pk-tab"
        :class="{ 'is-active': tab === item.name }"
        @click="selectTab(item.name)"
      >
        {{ item.label }}
        <span v-if="item.name === 'downloading' && downloadingJobs.length" class="pk-tab__badge">
          {{ downloadingJobs.length }}
        </span>
        <span v-if="item.name === 'done' && doneJobs.length" class="pk-tab__badge">{{ doneJobs.length }}</span>
      </button>
    </div>

    <div v-show="tab === 'files'" class="pk-drive__main">
      <div class="pk-card pk-drive__bar">
        <div class="pk-drive__search">
          <el-input
            v-model="query.kw"
            size="small"
            placeholder="搜索文件或目录名"
            clearable
            @keyup.enter="onSearch"
            @clear="onSearch"
          />
          <el-button size="small" type="primary" @click="onSearch">搜索</el-button>
        </div>

        <div class="pk-drive__tools">
          <el-radio-group v-model="view" size="small">
            <el-radio-button value="grid">网格</el-radio-button>
            <el-radio-button value="list">列表</el-radio-button>
          </el-radio-group>
          <el-select v-model="query.sort" size="small" class="pk-drive__sort" @change="changeSort">
            <el-option value="time" label="排列方式：时间" />
            <el-option value="name" label="排列方式：名称" />
            <el-option value="size" label="排列方式：大小" />
            <el-option value="type" label="排列方式：类型" />
          </el-select>
          <el-button size="small" text @click="((query.asc = !query.asc), void loadFiles())">
            {{ query.asc ? '升序 ↑' : '降序 ↓' }}
          </el-button>
          <span class="pk-muted pk-drive__count">
            文件个数 {{ childFolders.length }} 个目录 · {{ total }} 个文件
          </span>
          <el-button v-if="canCreate" size="small" type="primary" plain @click="openFolderDialog('create')">
            ＋新建文件夹
          </el-button>
        </div>

        <div class="pk-drive__select">
          <el-checkbox v-model="multiSelect" size="small" @change="multiSelect || resetSelection()">多选</el-checkbox>
          <template v-if="multiSelect">
            <span class="pk-muted">已选择了 {{ selectionCount }} 个</span>
            <el-button size="small" text @click="selectAll">全选</el-button>
            <el-button size="small" text @click="resetSelection">取消</el-button>
            <el-button
              v-if="!inTrash"
              size="small"
              :disabled="!selectedFiles.length || busy"
              @click="downloadSelected"
            >
              下载
            </el-button>
            <el-button v-if="inTrash && perms?.modify" size="small" :disabled="!selectionCount || busy" @click="restoreSelected">
              还原
            </el-button>
            <el-button
              v-if="!inTrash && canDeleteHere"
              size="small"
              type="danger"
              plain
              :disabled="!selectionCount || busy"
              @click="removeSelected"
            >
              删除
            </el-button>
            <el-button
              v-if="inTrash && perms?.purge"
              size="small"
              type="danger"
              plain
              :disabled="!selectionCount || busy"
              @click="removeSelected"
            >
              彻底删除
            </el-button>
          </template>
        </div>

        <p v-if="current && !current.perms.upload" class="pk-muted pk-drive__hint">
          {{
            current.kind === FolderKind.Shared && current.ownerUid !== myUid
              ? '这是他人的共享文件夹：可以读取和下载，不能改动也不能往里上传（规则 9）'
              : '当前目录没有上传权，上传按钮不会出现在这里（规则 10）'
          }}
        </p>
      </div>

      <div v-loading="loading" class="pk-drive__grid" :class="{ 'is-list': view === 'list' }">
        <article
          v-for="node in childFolders"
          :key="`d-${node.id}`"
          class="pk-card pk-item"
          :class="{ 'is-picked': selectedFolders.includes(node.id) }"
          @click="pickCard(node, $event)"
        >
          <el-checkbox
            v-if="multiSelect"
            class="pk-card__check"
            :model-value="selectedFolders.includes(node.id)"
            @change="toggleFolder(node.id)"
            @click.stop
          />
          <div class="pk-item__icon" :class="{ 'is-recycled': !!node.deletedAt }" :data-kind="node.kind">
            <span>{{ node.deletedAt ? '回收' : '目录' }}</span>
          </div>
          <div class="pk-item__text">
            <strong class="pk-item__name">{{ node.name }}</strong>
            <p class="pk-muted pk-item__sub">
              {{ node.fileCount }} 个文件 · 第 {{ node.depth }} 层
            </p>
            <!-- 规则 1：名称下面并排显示职务标签与等级标签 -->
            <p v-if="node.owner && node.kind === FolderKind.Shared" class="pk-item__chips">
              <span class="pk-chip">{{ node.owner.position }}</span>
              <span class="pk-chip pk-chip--ghost">{{ node.owner.levelName }}</span>
            </p>
            <p v-else-if="node.description" class="pk-muted pk-item__desc">{{ node.description }}</p>
            <p v-if="node.deletedAt" class="pk-muted pk-item__desc">删除于 {{ formatDate(node.deletedAt) }}</p>
            <p class="pk-item__perm">
              <span class="pk-chip pk-chip--ghost">{{ FOLDER_KIND_LABEL[node.kind] }}</span>
              <span v-if="!node.perms.modify" class="pk-muted">只读</span>
              <span v-else-if="node.ownerUid === myUid" class="pk-muted">本人目录</span>
            </p>
          </div>
          <el-dropdown trigger="click" class="pk-card__menu" @command="(cmd: string) => folderAction(cmd as never, node)">
            <el-button size="small" text class="pk-card__more" @click.stop>…</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="open">打开</el-dropdown-item>
                <el-dropdown-item v-if="node.perms.modify && !inTrash" command="rename">重命名</el-dropdown-item>
                <el-dropdown-item v-if="node.perms.modify && node.kind !== FolderKind.Trash" command="create">
                  新建子目录
                </el-dropdown-item>
                <el-dropdown-item v-if="inTrash && node.perms.modify" command="restore">还原</el-dropdown-item>
                <el-dropdown-item v-if="inTrash && node.perms.purge" command="purge" divided>
                  彻底删除
                </el-dropdown-item>
                <el-dropdown-item v-if="!inTrash && (node.perms.remove || node.perms.purge)" command="delete" divided>
                  删除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </article>

        <article
          v-for="file in files"
          :key="`f-${file.id}`"
          class="pk-card pk-item pk-item--file"
          :class="{ 'is-picked': selectedFiles.includes(file.id) }"
        >
          <el-checkbox
            v-if="multiSelect"
            class="pk-card__check"
            :model-value="selectedFiles.includes(file.id)"
            @change="toggleFile(file.id)"
            @click.stop
          />
          <img
            v-if="file.links.preview"
            class="pk-item__thumb"
            :src="previewSrc(file.links.preview)"
            :alt="file.filename"
            loading="lazy"
          />
          <div v-else class="pk-item__thumb pk-item__thumb--none">—</div>
          <div class="pk-item__text">
            <strong class="pk-item__name">{{ file.filename }}</strong>
            <p class="pk-muted pk-item__sub">
              {{ formatBytes(file.fileSize) }} · {{ PREVIEW_LABEL[file.previewStatus] }}
            </p>
            <p class="pk-muted pk-item__desc">{{ formatDate(file.createTime) }}</p>
            <p v-if="file.deletedAt" class="pk-muted pk-item__desc">删除于 {{ formatDate(file.deletedAt) }}</p>
          </div>
          <div class="pk-item__actions">
            <el-button
              size="small"
              text
              type="primary"
              :disabled="!file.links.download"
              @click="downloadOne(file)"
            >
              下载
            </el-button>
            <el-button v-if="inTrash && perms?.modify" size="small" text @click="restoreFileOne(file)">还原</el-button>
            <el-button
              v-if="inTrash && perms?.purge"
              size="small"
              text
              type="danger"
              @click="purgeOneFile(file)"
            >
              清除
            </el-button>
            <el-button
              v-else-if="file.canDelete && !inTrash"
              size="small"
              text
              type="danger"
              @click="deleteOneFile(file)"
            >
              删除
            </el-button>
          </div>
        </article>

        <p v-if="!childFolders.length && !files.length && !loading" class="pk-muted pk-drive__empty">
          <template v-if="session.isTemp">
            游客不看网盘列表：你的可访问目录挂在「拍展」下面，按账户 ID 从任务入口进去才是正路（规则 3）。
          </template>
          <template v-else>
            这里没有你能看到的目录或文件。网盘按目录用途与文件权限裁剪，看不见的目录不会以空壳形式出现。
          </template>
        </p>
      </div>

      <el-pagination
        v-if="total > query.pageSize"
        class="pk-pager"
        layout="prev, pager, next, sizes"
        :total="total"
        :page-size="query.pageSize"
        :current-page="query.page"
        :page-sizes="[60, 120, 200]"
        @current-change="(p: number) => ((query.page = p), void loadFiles())"
        @size-change="onSizeChange"
      />
    </div>

    <!-- 手绘稿 18 的上传面板只活在「上传」这一格里（D18）；用 v-show 常驻，切标签不丢队列 -->
    <DriveUploadView v-show="tab === 'upload'" :preset-folder="currentId" />

    <div v-show="tab === 'downloading' || tab === 'done'" class="pk-card pk-drive__jobs">
      <p v-if="!(tab === 'downloading' ? downloadingJobs : doneJobs).length" class="pk-muted">
        {{ tab === 'downloading' ? '没有正在进行的下载任务' : '还没有已完成的下载任务' }}
      </p>
      <ul v-else>
        <li v-for="job in tab === 'downloading' ? downloadingJobs : doneJobs" :key="job.key" class="pk-job">
          <div>
            <strong>{{ job.label }}</strong>
            <span class="pk-muted"> · {{ formatBytes(job.size) }} · {{ job.state }}</span>
          </div>
          <span class="pk-muted pk-job__detail">{{ job.detail }}</span>
        </li>
      </ul>
    </div>

    <el-dialog
      v-model="folderDialog.open"
      :title="folderDialog.mode === 'create' ? '新建文件夹' : '重命名目录'"
      width="min(520px, 92vw)"
    >
      <el-form label-position="top">
        <el-form-item :label="`名称（上级：${folderDialog.parentId ? byId.get(folderDialog.parentId)?.name ?? '#' : '根目录'}）`">
          <el-input v-model="folderDialog.name" maxlength="60" placeholder="同级不能重名" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="folderDialog.description" type="textarea" :rows="2" maxlength="200" />
        </el-form-item>
        <p class="pk-muted pk-drive__hint">
          新目录的用途与权限随上级：在别人的共享文件夹里建目录会被挡下，在「爬虫」下建子目录会自动按时间归档（规则 9/11）。
        </p>
      </el-form>
      <template #footer>
        <el-button @click="folderDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitFolder">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-drive__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.pk-drive__nav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-drive__crumbs {
  font-size: 13px;
  margin-left: 4px;
}

.pk-drive__crumbs a {
  cursor: pointer;
}

.pk-drive__who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.pk-drive__tabs {
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

.pk-drive__bar {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pk-drive__search {
  display: flex;
  gap: 8px;
}

.pk-drive__search .el-input {
  max-width: 320px;
}

.pk-drive__tools,
.pk-drive__select {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-drive__sort {
  width: 168px;
}

@media (max-width: 640px) {
  .pk-drive__sort {
    width: 100%;
  }

  .pk-drive__grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
}

.pk-drive__count {
  font-size: 12px;
}

.pk-drive__hint {
  font-size: 12px;
  margin: 0;
  line-height: 1.7;
}

.pk-drive__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.pk-drive__grid.is-list {
  grid-template-columns: 1fr;
}

.pk-item {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.pk-item:hover {
  border-color: var(--pk-brand);
}

.pk-item.is-picked {
  border-color: var(--pk-brand);
  box-shadow: 0 0 0 1px var(--pk-brand) inset;
}

.pk-card__check {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 1;
}

.pk-card__menu {
  position: absolute;
  top: 4px;
  right: 4px;
}

.pk-card__more {
  font-size: 16px;
  line-height: 1;
}

.pk-item__icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  letter-spacing: 1px;
  flex: none;
}

.pk-item__icon.is-recycled {
  background: #f2f3f7;
  color: var(--pk-muted);
}

.pk-item__thumb {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  object-fit: cover;
  background: #eef0f6;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pk-muted);
}

.pk-item__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pk-item__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.pk-item__sub,
.pk-item__desc {
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.pk-item__chips {
  display: flex;
  gap: 5px;
  margin: 0;
  flex-wrap: wrap;
}

.pk-item__perm {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  margin: 2px 0 0;
}

.pk-item__actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  margin-left: auto;
}

.pk-item--file {
  align-items: center;
}

.pk-drive__jobs {
  padding: 12px 16px;
}

.pk-drive__jobs ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pk-job {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--pk-line);
  font-size: 13px;
}

.pk-job__detail {
  font-size: 12px;
  text-align: right;
}

.pk-drive__empty {
  grid-column: 1 / -1;
  font-size: 13px;
  line-height: 1.8;
  padding: 16px 2px;
}

.pk-pager {
  margin-top: 14px;
  justify-content: center;
}
</style>
