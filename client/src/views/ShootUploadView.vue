<script setup lang="ts">
/**
 * 相册传图面板。骨架与网盘的上传面板（DriveUploadView，D18）一致：
 * 三态子标签（上传 / 上传中 / 已完成）+ 目的地行 + 拖放区 + 队列，
 * 差别只在目的地是「相册 + 归属临时账号」而非目录，且字节走真分片接口。
 * 入口认的是「传图」能力位：正式成员默认可见，开了该开关的临时账号自己交付给自己，
 * 此时目的地相册已由 mock 按白名单＋档位裁好（/albums 列表只给 public 且在 albumIds 里）。
 * 某张不合格在建立会话那一关就被拒，原因留在队列里，不静默丢弃（PRD 4.5）。
 * 排队与进行中的照片都能单张取消，也能整批取消：取消会 DELETE 掉已建立的上传会话，
 * 会话作废后分片再回来也不续写，所以取消的照片不会进相册。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorText, previewSrc, USE_MOCK } from '@/api/client';
import { abortUpload, completeUpload, createSession, putChunk } from '@/api/upload';
import type { UploadSessionView } from '@/api/upload';
import { listTasks } from '@/api/temp';
import type { AlbumCapsView, AlbumView, ImageView, Page, TempTaskRow } from '@/types/api';
import { formatBytes } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

interface Task {
  key: number;
  file: File;
  progress: number;
  state: '排队' | '上传中' | '已完成' | '失败' | '已取消';
  detail: string;
  image: ImageView | null;
  sessionId: string;
  /** 分片请求在路上时点的取消：runTask 在下一片前复看这个标记，不复写状态 */
  cancelRequested: boolean;
}

const TABS = [
  { name: 'upload', label: '上传' },
  { name: 'running', label: '上传中' },
  { name: 'done', label: '已完成' },
] as const;

type TabName = (typeof TABS)[number]['name'];

const session = useSessionStore();
const route = useRoute();

const albums = ref<(AlbumView & AlbumCapsView)[]>([]);
const albumId = ref<number>(Number(route.query.album) || 0);
const tasks = ref<Task[]>([]);
const tab = ref<TabName>('upload');
const running = ref(false);
/** 整批取消的停止信号：submitAll 的串行循环在下一张之前复看 */
let stopRequested = false;
const loading = ref(false);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const cameraInput = ref<HTMLInputElement | null>(null);
let seed = 0;

/** 拍展传图的归属临时账号（member 发起必填，temp 发起等于选自己）；'' 表示还没选，好让下拉显示占位文案 */
const tempTasks = ref<TempTaskRow[]>([]);
const tempId = ref<number | ''>('');

const isTempActor = computed(() => session.isTemp);
const lockedTempId = computed<number | null>(() => {
  if (!session.isTemp) return null;
  const p = session.profile;
  return p?.kind === 'temp' ? p.tempId : null;
});

/** D25：本册（含父链）关掉了「传图」——目的地照常列出但标只读，不让人选上去再撞 403（PRD 6.5） */
const uploadClosed = (album: AlbumView & AlbumCapsView): boolean => (album.capsOff ?? []).includes('upload');

const writableAlbums = computed(() => albums.value.filter((a) => a.status === 1 && !uploadClosed(a)));
const activeTasks = computed(() => tasks.value.filter((t) => t.state === '上传中' || t.state === '排队'));
const finished = computed(() =>
  tasks.value.filter((t) => t.state === '已完成' || t.state === '失败' || t.state === '已取消'),
);
const totalBytes = computed(() => tasks.value.reduce((n, t) => n + t.file.size, 0));

/**
 * 成员只看自己登记的临时账号，L3+ 才看得见全部；已过期的账号仍可选（返图可能晚到）。
 * 临时账号本人不拉这份列表：工单列表只对成员开放，而它的交付对象本来就锁成自己。
 */
async function loadTempTasks(): Promise<void> {
  if (isTempActor.value) return;
  try {
    const rows = await listTasks({ scope: session.level >= 3 ? 'all' : 'mine' });
    tempTasks.value = rows.filter((r) => r.flags.uploadImg);
  } catch (err) {
    ElMessage.error(errorText(err, '临时账号列表加载失败'));
  }
}

/** el-button 渲染成 <button>，是 HTML 交互式内容，浏览器不会把它的点击转发给 label 关联的控件，只能显式 click() */
function openPicker(input: HTMLInputElement | null): void {
  input?.click();
}

async function loadAlbums(): Promise<void> {
  loading.value = true;
  try {
    const page = await api.get<Page<AlbumView & AlbumCapsView>>('/albums', { query: { pageSize: 100 } });
    albums.value = page.list;
    // 默认目的地只挑真能写进去的那本：锁定/归档不行，被超管关掉「传图」也不行（PRD 6.5）
    if (!albumId.value) albumId.value = page.list.find((a) => a.status === 1 && !uploadClosed(a))?.id ?? 0;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

/** 客户端不猜类型：RAW 的 file.type 在浏览器里常常是空串，白名单归站点设置说了算 */
function pickFiles(list: FileList | null): void {
  if (!list?.length) return;
  const next: Task[] = [];
  for (const file of Array.from(list)) {
    next.push({
      key: (seed += 1),
      file,
      progress: 0,
      state: '排队',
      detail: '',
      image: null,
      sessionId: '',
      cancelRequested: false,
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

/** 会话作废：取消与失败都要 DELETE，句柄清空后重复调用是空操作 */
async function dropSession(task: Task): Promise<void> {
  if (!task.sessionId) return;
  const uploadId = task.sessionId;
  task.sessionId = '';
  await abortUpload(uploadId).catch(() => undefined);
}

/** 逐片顺序上传：现场网络不稳，串行更容易断点续传，也不与服务端限流打架 */
async function runTask(task: Task): Promise<void> {
  // 取消发生在建会话之前：状态已由取消侧写好，这里不碰
  if (task.cancelRequested) return;

  let view: UploadSessionView;
  try {
    // 临时账号自己发传图时忽略 tempId（后端会用 actor.tempId）；成员代传必须带 tempId
    const ownerTempId = lockedTempId.value ?? tempId.value;
    view = await createSession(albumId.value, { name: task.file.name, size: task.file.size }, ownerTempId || undefined);
    task.sessionId = view.uploadId;
  } catch (err) {
    if (task.cancelRequested) return;
    task.state = '失败';
    task.detail = errorText(err);
    return;
  }

  // 建会话这段时间里可能被取消：会话刚建出来就作废，不留残片
  if (task.cancelRequested) {
    await dropSession(task);
    return;
  }
  task.state = '上传中';
  for (let index = 0; index < view.totalChunks; index += 1) {
    if (task.cancelRequested) return;
    const start = index * view.chunkSize;
    const blob = task.file.slice(start, Math.min(start + view.chunkSize, task.file.size));
    try {
      const ack = await putChunk(view.uploadId, index, blob);
      if (task.cancelRequested) return;
      task.progress = Math.round((ack.uploaded / ack.total) * 100);
      task.detail = `分片 ${ack.uploaded}/${ack.total}`;
    } catch (err) {
      // 会话刚被取消时 DELETE 可能先落地，这一片的失败不改写「已取消」
      if (task.cancelRequested) return;
      task.state = '失败';
      task.detail = errorText(err);
      await dropSession(task);
      return;
    }
  }

  if (task.cancelRequested) return;
  try {
    task.image = await completeUpload(view.uploadId);
    task.state = '已完成';
    task.detail = `#${task.image.id} · ${task.image.visibility}`;
    task.sessionId = '';
  } catch (err) {
    if (task.cancelRequested) return;
    task.state = '失败';
    task.detail = errorText(err);
  }
}

/**
 * 单张取消。排队的直接作废（会话还没建，无需 DELETE）；进行中的先落「已取消」再作废会话，
 * runTask 只负责在下一片之前看见标记就收手，不会把状态改回「已完成」。
 */
async function cancelTask(task: Task): Promise<void> {
  if (task.state !== '排队' && task.state !== '上传中') return;
  task.cancelRequested = true;
  task.detail = task.state === '上传中' ? '已取消，已传的分片随会话一并作废' : '已取消，尚未开始上传';
  task.state = '已取消';
  await dropSession(task);
}

/** 整批取消：先立停止信号让串行循环不再往后走，再把队列里所有没跑完的作废 */
async function cancelAll(): Promise<void> {
  stopRequested = true;
  const list = tasks.value.filter((t) => t.state === '排队' || t.state === '上传中');
  for (const task of list) await cancelTask(task);
  ElMessage.info(list.length ? `已取消 ${list.length} 张，未进入相册` : '没有可取消的上传任务');
}

async function submitAll(): Promise<void> {
  if (!albumId.value) {
    ElMessage.warning('请先选择要返到哪个相册');
    return;
  }
  // 深链 ?album= 可能指到一本关了「传图」的册子：这里先挡住，免得每张图逐条撞 403（PRD 6.5）
  const target = albums.value.find((a) => a.id === albumId.value);
  if (target && uploadClosed(target)) {
    ElMessage.error(`「${target.name}」的传图已被超管关闭，换一本或联系超管`);
    return;
  }
  // 成员代传必须指定归属的临时账号
  if (!isTempActor.value && !tempId.value) {
    ElMessage.warning('拍展传图需要先选一位临时账号，照片将归到它的取图目录下');
    return;
  }
  const queue = tasks.value.filter((t) => t.state === '排队');
  if (!queue.length) {
    ElMessage.info('队列里没有待传照片');
    return;
  }
  running.value = true;
  tab.value = 'running';
  stopRequested = false;
  for (const task of queue) {
    if (stopRequested) break;
    await runTask(task);
  }
  running.value = false;
  stopRequested = false;
  tab.value = 'done';
  const done = tasks.value.filter((t) => t.state === '已完成').length;
  const failed = tasks.value.filter((t) => t.state === '失败').length;
  const cancelled = tasks.value.filter((t) => t.state === '已取消').length;
  if (failed) {
    ElMessage.warning(`${done} 张已进相册，${failed} 张被拒，原因见「已完成」列表`);
  } else if (done) {
    const target = isTempActor.value ? session.displayName : tempTasks.value.find((t) => t.tempId === tempId.value)?.code;
    ElMessage.success(
      `${done} 张已进入相册${cancelled ? `，${cancelled} 张已取消` : ''}，交付给临时账号 ${target ?? ''}`,
    );
  } else if (cancelled) {
    ElMessage.info(`已取消 ${cancelled} 张，没有照片进入相册`);
  }
  await loadAlbums();
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

onMounted(async () => {
  await loadAlbums();
  await loadTempTasks();
  // 临时账号自己上拍展传图时，直接锁定为自己，前端不允许改
  if (lockedTempId.value) tempId.value = lockedTempId.value;
});
</script>

<template>
  <section class="pk-upload">
    <div class="pk-upload__tabs">
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
      <p class="pk-muted pk-upload__note">
        目的地只列当前身份能写的相册；单张上限、扩展名白名单与配额都取自后台「站点设置 → 上传 / 存储与配额」，
        改完立即生效，不合格的照片在建立会话那一关就被拒，原因留在队列里。排队与进行中的照片都能取消，
        取消即作废这条上传会话，不会进相册。网盘里的原始文件请走
        <router-link class="pk-shoot__link" to="/drive?tab=upload">上传文件</router-link>，这条流程只管相册。
        <template v-if="USE_MOCK">当前为演示模式，只跑会话与分片下标，字节不写入磁盘。</template>
      </p>

      <div v-loading="loading" class="pk-card pk-upload__dest">
        <span class="pk-upload__label">交付给：</span>
        <el-select
          v-if="isTempActor"
          v-model="tempId"
          placeholder="归属临时账号"
          class="pk-upload__temp"
          disabled
        >
          <el-option :value="tempId" :label="session.displayName" />
        </el-select>
        <el-select
          v-else
          v-model="tempId"
          placeholder="选一位临时账号（照片归属它）"
          class="pk-upload__temp"
          filterable
        >
          <el-option
            v-for="row in tempTasks"
            :key="row.tempId"
            :value="row.tempId"
            :label="`${row.code} · ${row.displayName}`"
          >
            <span class="pk-temp-code">{{ row.code }}</span>
            <span class="pk-temp-name">· {{ row.displayName }}</span>
            <span v-if="row.expired" class="pk-chip pk-chip--warn pk-temp-expired">已过期</span>
          </el-option>
        </el-select>

        <span class="pk-upload__label">目标相册：</span>
        <el-select v-model="albumId" placeholder="选择相册" class="pk-upload__album">
          <el-option
            v-for="album in albums"
            :key="album.id"
            :label="album.name"
            :value="album.id"
            :disabled="album.status !== 1 || uploadClosed(album)"
          >
            <div class="pk-upload__option">
              <span>{{ album.name }}</span>
              <span v-if="uploadClosed(album)" class="pk-muted">传图已被超管关闭</span>
              <span v-else-if="album.status !== 1" class="pk-muted">已锁定或归档，不可写入</span>
            </div>
          </el-option>
        </el-select>

        <span class="pk-muted pk-upload__count">
          可选 {{ writableAlbums.length }} 个相册{{ albums.length - writableAlbums.length ? ` · ${albums.length - writableAlbums.length} 个只读` : '' }}
        </span>
      </div>

      <div
        class="pk-card pk-drop"
        :class="{ 'is-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="onDrop"
      >
        <p class="pk-upload__label pk-drop__title">上传照片</p>
        <p class="pk-muted">把照片拖到这里，或用下面的按钮从本地选。</p>
        <div class="pk-drop__actions">
          <input ref="fileInput" class="pk-file__input" type="file" multiple @change="onFileInput" />
          <el-button type="primary" @click="openPicker(fileInput)">本地选择照片</el-button>
          <input
            ref="cameraInput"
            class="pk-file__input"
            type="file"
            accept="image/*"
            capture="environment"
            @change="onFileInput"
          />
          <el-button @click="openPicker(cameraInput)">拍照上传</el-button>
        </div>
        <p class="pk-muted pk-drop__hint">
          移动端布局：现场直接拍照回传，分片走鉴权接口，原图不落静态路由（PRD 12.3）；
          真接口还会按魔数复核，扩展名与 Content-Type 都不作数。
        </p>
      </div>

      <div v-if="tasks.length" class="pk-card pk-queue">
        <div class="pk-queue__head">
          <span>队列 {{ tasks.length }} 张 · 合计 {{ formatBytes(totalBytes) }}</span>
          <div>
            <el-button size="small" :disabled="!finished.some((t) => t.state === '失败')" @click="retryFailed">
              重试失败项
            </el-button>
            <el-button size="small" :disabled="!finished.length" @click="clearFinished">清除已完成</el-button>
            <el-button size="small" :disabled="!activeTasks.length" @click="cancelAll">取消全部</el-button>
            <el-button size="small" type="primary" :loading="running" @click="submitAll">开始上传</el-button>
          </div>
        </div>
        <ul class="pk-queue__list">
          <li v-for="task in tasks" :key="task.key" class="pk-task">
            <img v-if="task.image" class="pk-task__thumb" :src="previewSrc(task.image.links.preview)" :alt="task.file.name" />
            <div v-else class="pk-task__thumb pk-task__thumb--empty" />
            <div class="pk-task__body">
              <div class="pk-task__name">
                <strong>{{ task.file.name }}</strong>
                <span :class="task.state === '失败' ? 'pk-upload__fail' : 'pk-muted'">
                  {{ formatBytes(task.file.size) }} · {{ task.state }}
                </span>
              </div>
              <el-progress :percentage="task.progress" :stroke-width="6" :show-text="false" />
              <span class="pk-muted pk-task__detail">{{ task.detail }}</span>
            </div>
            <el-button
              v-if="task.state === '排队' || task.state === '上传中'"
              class="pk-task__cancel"
              size="small"
              text
              @click="cancelTask(task)"
            >
              取消
            </el-button>
          </li>
        </ul>
      </div>
    </div>

    <div v-show="tab === 'running'" class="pk-card pk-queue">
      <p v-if="!activeTasks.length" class="pk-muted">没有正在进行的上传任务。</p>
      <template v-else>
        <div class="pk-queue__head">
          <span>进行中 {{ activeTasks.length }} 张 · 合计 {{ formatBytes(activeTasks.reduce((n, t) => n + t.file.size, 0)) }}</span>
          <el-button size="small" @click="cancelAll">取消全部</el-button>
        </div>
        <ul class="pk-queue__list">
          <li v-for="task in activeTasks" :key="task.key" class="pk-task">
            <div class="pk-task__thumb pk-task__thumb--empty" />
            <div class="pk-task__body">
              <div class="pk-task__name">
                <strong>{{ task.file.name }}</strong>
                <span class="pk-muted">{{ formatBytes(task.file.size) }} · {{ task.state }}</span>
              </div>
              <el-progress :percentage="task.progress" :stroke-width="6" :show-text="false" />
              <span class="pk-muted pk-task__detail">{{ task.detail }}</span>
            </div>
            <el-button class="pk-task__cancel" size="small" text @click="cancelTask(task)">取消</el-button>
          </li>
        </ul>
      </template>
    </div>

    <div v-show="tab === 'done'" class="pk-card pk-queue">
      <p v-if="!finished.length" class="pk-muted">还没有已结束的上传任务。</p>
      <ul v-else class="pk-queue__list">
        <li v-for="task in finished" :key="task.key" class="pk-task">
          <img
            v-if="task.image"
            class="pk-task__thumb"
            :src="previewSrc(task.image.links.preview)"
            :alt="task.file.name"
          />
          <div v-else class="pk-task__thumb pk-task__thumb--empty" />
          <div class="pk-task__body">
            <div class="pk-task__name">
              <strong>{{ task.file.name }}</strong>
              <span :class="task.state === '失败' ? 'pk-upload__fail' : 'pk-muted'">
                {{ formatBytes(task.file.size) }} · {{ task.state }}
              </span>
            </div>
            <span class="pk-muted pk-task__detail">{{ task.detail }}</span>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.pk-upload__tabs {
  display: flex;
  gap: 4px;
  margin: 0 0 12px;
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

.pk-upload__dest {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 14px;
}

.pk-upload__label {
  font-size: 14px;
  font-weight: 600;
}

.pk-upload__album {
  width: 240px;
}

.pk-upload__temp {
  width: 280px;
}

.pk-upload__option {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  padding: 2px 0;
}

.pk-upload__option .pk-muted {
  font-size: 11px;
}

.pk-upload__count {
  font-size: 12px;
}

.pk-upload__note {
  font-size: 12px;
  margin: 0 0 12px;
  line-height: 1.7;
}

.pk-upload__fail {
  color: #d64545;
}

.pk-temp-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
}

.pk-temp-name {
  color: var(--pk-muted);
}

.pk-temp-expired {
  margin-left: 6px;
}

.pk-shoot__link {
  color: var(--pk-brand);
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

.pk-file__input {
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

.pk-task__thumb {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  background: #e9ebf3;
  flex: none;
}

.pk-task__thumb--empty {
  background: #eef0f6;
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

.pk-task__cancel {
  flex: none;
}

@media (max-width: 640px) {
  .pk-upload__album,
  .pk-upload__temp {
    width: 100%;
  }

  .pk-task__name {
    flex-direction: column;
    gap: 2px;
  }
}
</style>
