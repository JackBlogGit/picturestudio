<script setup lang="ts">
/**
 * 相册传图面板。三态子标签与队列沿用网盘上传面板（DriveUploadView，D18）的骨架，
 * 差别只在目的地是「相册 + 归属临时账号」而非目录，且字节走真分片接口。
 * 「上传」标签内部按 ①交付对象 → ②目的地相册与照片阶段 → ③挑照片 三步竖排（D33）：
 * 交付对象从「和相册挤在同一行的第二把下拉」提成第一步，选中的那位账号当场回显摘要
 * （帐户ID／登记人／有效期／目录现状），免得传到别人家里去。
 * 第 3 步的挑照片不设门槛，与网盘的上传面板同一口径：任何时候都能选与拖，
 * 交付对象没定是点「开始上传」那一刻才挡下来。
 * 这一页只对正式成员开放（D27）：临时账号只能取图，caps.upload 恒为 false，
 * 标签、深链守卫与顶栏入口一起收掉，接口侧由 decideTemp 兜回 403。
 * 照片一律由成员发起并点名交付给某位临时账号，目的地相册按成员自己的写权限列。
 * 某张不合格在建立会话那一关就被拒，原因留在队列里，不静默丢弃（PRD 4.5）。
 * 排队与进行中的照片都能单张取消，也能整批取消：取消会 DELETE 掉已建立的上传会话，
 * 会话作废后分片再回来也不续写，所以取消的照片不会进相册。
 * 传图时要点名这批照片属于前期（原片初修）还是后期（精修交付）——阶段逐张记在图片上（D31），
 * 取图页的「前期修图 / 后期返图」两段就按它分流；默认跟着目标相册自己的阶段。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorText, previewSrc, USE_MOCK } from '@/api/client';
import { abortUpload, completeUpload, createSession, putChunk } from '@/api/upload';
import type { UploadSessionView } from '@/api/upload';
import { listTasks } from '@/api/temp';
import type {
  AlbumCapsView,
  AlbumStage,
  AlbumView,
  ImageView,
  Page,
  TempTaskRow,
} from '@/types/api';
import { STAGE_LABEL } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

interface Task {
  key: number;
  file: File;
  progress: number;
  state: '排队' | '上传中' | '已完成' | '失败' | '已取消';
  /** 这张图进队列时定下的阶段（D31）；排队中还能改，开传后随会话落库 */
  stage: AlbumStage;
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

/** 拍展传图的归属临时账号（成员发起必填，照片落到它的帐户 ID 目录）；'' 表示还没选，好让下拉显示占位文案 */
const tempTasks = ref<TempTaskRow[]>([]);
const tempId = ref<number | ''>('');

/** 本批照片的阶段（D31）：新加入队列的照片都取它，之后可逐张改 */
const batchStage = ref<AlbumStage>('post');

/** 目标相册自己的阶段——前期册默认传前期图，后期册默认传后期图 */
const albumStage = computed<AlbumStage>(
  () => albums.value.find((a) => a.id === albumId.value)?.stage ?? 'post',
);

// 换目的地 = 换「跟相册」的默认值；已在队列里的照片保持自己那张的阶段，不被带跑。
// 只在相册换了或它的阶段变了时对齐，否则上传收尾的重新拉列表会冲掉手动改过的默认值。
let stageSyncedFor: string | null = null;

function syncStageToAlbum(): void {
  const stamp = `${albumId.value}:${albumStage.value}`;
  if (stageSyncedFor === stamp) return;
  stageSyncedFor = stamp;
  batchStage.value = albumStage.value;
}

watch(albumId, syncStageToAlbum);

/** D25：本册（含父链）关掉了「传图」——目的地照常列出但标只读，不让人选上去再撞 403（PRD 6.5） */
const uploadClosed = (album: AlbumView & AlbumCapsView): boolean => (album.capsOff ?? []).includes('upload');

const writableAlbums = computed(() => albums.value.filter((a) => a.status === 1 && !uploadClosed(a)));
const activeTasks = computed(() => tasks.value.filter((t) => t.state === '上传中' || t.state === '排队'));
const finished = computed(() =>
  tasks.value.filter((t) => t.state === '已完成' || t.state === '失败' || t.state === '已取消'),
);
const totalBytes = computed(() => tasks.value.reduce((n, t) => n + t.file.size, 0));

/** 第 1 步选中那位临时账号的整行；没选或列表还没回来时为 null */
const pickedTemp = computed<TempTaskRow | null>(
  () => tempTasks.value.find((row) => row.tempId === tempId.value) ?? null,
);

const targetAlbum = computed(() => albums.value.find((a) => a.id === albumId.value) ?? null);

/**
 * 成员只看自己登记的临时账号，L3+ 才看得见全部；已过期的账号仍可选（返图可能晚到）。
 * 交付对象不按开关过滤：D27 起「传图」位不再授予给临时账号，这里的每一行都是成员替它收图。
 */
async function loadTempTasks(): Promise<void> {
  try {
    tempTasks.value = await listTasks({ scope: session.level >= 3 ? 'all' : 'mine' });
  } catch (err) {
    ElMessage.error(errorText(err, '临时账号列表加载失败'));
  }
}

// 会话在点「开始上传」时才建，所以队列里没开传的照片跟着**当前**的交付对象走。
// 换人不是错事（传错了才发现归属选错就靠它救），但必须说明白改了几张、已进相册的不跟着搬（D33）。
watch(tempId, (next, prev) => {
  if (prev === '' || next === '' || next === prev) return;
  const pending = tasks.value.filter((t) => t.state === '排队').length;
  if (!pending) return;
  const row = tempTasks.value.find((t) => t.tempId === next);
  ElMessage.info(`队列里 ${pending} 张还没开传，改为交付给 ${row?.code ?? '新账号'}；已进相册的不跟着搬`);
});

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
    syncStageToAlbum();
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
      stage: batchStage.value,
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
    // 照片归属由成员点名的那位临时账号决定，阶段（D31）跟着这一张走
    view = await createSession(
      albumId.value,
      { name: task.file.name, size: task.file.size },
      tempId.value || undefined,
      task.stage,
    );
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
    task.detail = `#${task.image.id} · ${task.image.visibility} · ${STAGE_LABEL[task.image.stage]}`;
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
    ElMessage.warning('请先在第 2 步选择要返到哪个相册');
    return;
  }
  // 深链 ?album= 可能指到一本关了「传图」的册子：这里先挡住，免得每张图逐条撞 403（PRD 6.5）
  const target = albums.value.find((a) => a.id === albumId.value);
  if (target && uploadClosed(target)) {
    ElMessage.error(`「${target.name}」的传图已被超管关闭，换一本或联系超管`);
    return;
  }
  // 代传必须指定归属的临时账号
  if (!tempId.value) {
    ElMessage.warning('请先在第 1 步选一位临时账号——照片要归到它的帐户ID 目录下');
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
  const doneTasks = tasks.value.filter((t) => t.state === '已完成');
  const done = doneTasks.length;
  const failed = tasks.value.filter((t) => t.state === '失败').length;
  const cancelled = tasks.value.filter((t) => t.state === '已取消').length;
  // 按服务端回读的阶段分（D31）：一批里可能有手动改过的单张
  const preCount = doneTasks.filter((t) => t.image?.stage === 'pre').length;
  const stageSplit = `前期 ${preCount} 张 / 后期 ${done - preCount} 张`;
  if (failed) {
    ElMessage.warning(`${done} 张已进相册（${stageSplit}），${failed} 张被拒，原因见「已完成」列表`);
  } else if (done) {
    ElMessage.success(
      `${done} 张已进入相册（${stageSplit}）${cancelled ? `，${cancelled} 张已取消` : ''}，交付给临时账号 ${pickedTemp.value?.code ?? ''}`,
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
        传图按三步走：① 定交付对象 → ② 定相册与阶段 → ③ 挑照片开传。第 3 步随时可选可拖，
        照片先排进队列，第 1 步没选定是点「开始上传」那一刻才挡下来；
        换交付对象只改还没开传的那些张，已进相册的不跟着搬。
        目的地只列当前身份能写的相册；单张上限、扩展名白名单与配额都取自后台「站点设置 → 上传 / 存储与配额」，
        改完立即生效，不合格的照片在建立会话那一关就被拒，原因留在队列里。排队与进行中的照片都能取消，
        取消即作废这条上传会话，不会进相册。每一张照片的前期 / 后期在建会话时一起记到图片上（D31），
        Coser 那侧的取图页就按它分成「前期修图」和「后期返图」两段。网盘里的原始文件请走
        <router-link class="pk-shoot__link" to="/drive?tab=upload">上传文件</router-link>，这条流程只管相册。
        <template v-if="USE_MOCK">当前为演示模式，只跑会话与分片下标，字节不写入磁盘。</template>
      </p>

      <div v-loading="loading" class="pk-flow">
        <div class="pk-card pk-step" :class="{ 'pk-step--done': pickedTemp }">
          <span class="pk-step__no">1</span>
          <div class="pk-step__body">
            <div class="pk-step__head">
              <span class="pk-step__title">交付给哪位临时账号</span>
              <span class="pk-chip pk-step__badge" :class="{ 'pk-chip--ghost': !pickedTemp }">
                {{ pickedTemp ? '已选定' : '先定这一步' }}
              </span>
            </div>
            <p class="pk-muted pk-step__desc">
              照片一律由成员代传（D27）：这一步定下的账号就是照片归属，字节落进它的帐户 ID 目录、配额记在它头上（6.3）。
              照片可以先排进队列，但没定下交付对象时点「开始上传」会被挡下。
            </p>
            <el-select
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
            <p v-if="!tempTasks.length" class="pk-muted pk-step__desc">
              当前身份名下还没有临时账号，先到
              <router-link class="pk-shoot__link" to="/guest/new">注册临时账号</router-link>
              开一个再回来传图。
            </p>
            <dl v-if="pickedTemp" class="pk-brief">
              <div class="pk-brief__row">
                <dt>名称</dt>
                <dd>{{ pickedTemp.displayName }}</dd>
              </div>
              <div class="pk-brief__row">
                <dt>帐户ID</dt>
                <dd class="pk-temp-code">{{ pickedTemp.code }}</dd>
              </div>
              <div class="pk-brief__row">
                <dt>登记人</dt>
                <dd>{{ pickedTemp.ownerName }} · {{ pickedTemp.ownerPosition }}</dd>
              </div>
              <div v-if="pickedTemp.shootContent" class="pk-brief__row">
                <dt>拍摄内容</dt>
                <dd>{{ pickedTemp.shootContent }}</dd>
              </div>
              <div class="pk-brief__row">
                <dt>有效期</dt>
                <dd>
                  {{ formatDate(pickedTemp.expiresAt) }}
                  <span class="pk-chip pk-chip--ghost" :class="{ 'pk-chip--warn': pickedTemp.expired }">
                    {{ pickedTemp.expired ? '已过期' : `剩 ${pickedTemp.daysLeft} 天` }}
                  </span>
                </dd>
              </div>
              <div class="pk-brief__row">
                <dt>目录现状</dt>
                <dd>
                  {{ pickedTemp.fileCount }} 个文件 ·
                  {{ formatBytes(pickedTemp.usedSpace) }} / {{ formatBytes(pickedTemp.spaceQuota) }}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div class="pk-card pk-step">
          <span class="pk-step__no">2</span>
          <div class="pk-step__body">
            <div class="pk-step__head">
              <span class="pk-step__title">传到哪本相册</span>
              <span class="pk-muted pk-upload__count">
                可选 {{ writableAlbums.length }} 个相册{{ albums.length - writableAlbums.length ? ` · ${albums.length - writableAlbums.length} 个只读` : '' }}
              </span>
            </div>
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
            <div class="pk-step__row">
              <span class="pk-upload__label">照片阶段：</span>
              <el-radio-group v-model="batchStage" size="small">
                <el-radio-button value="pre">前期</el-radio-button>
                <el-radio-button value="post">后期</el-radio-button>
              </el-radio-group>
            </div>
            <p class="pk-muted pk-upload__stage-note">
              这本相册是{{ STAGE_LABEL[albumStage] }}册，默认就取{{ STAGE_LABEL[albumStage] }}；改这一档只影响之后加进队列的照片，
              队列里已经排着的可以在每一行上单独改。
            </p>
          </div>
        </div>

        <div class="pk-card pk-step">
          <span class="pk-step__no">3</span>
          <div class="pk-step__body">
            <div class="pk-step__head">
              <span class="pk-step__title">挑照片</span>
            </div>

            <div
              class="pk-drop"
              :class="{ 'is-over': dragOver }"
              @dragover.prevent="dragOver = true"
              @dragleave="dragOver = false"
              @drop.prevent="onDrop"
            >
              <p class="pk-upload__label pk-drop__title">上传照片</p>
              <p class="pk-muted">把照片拖到这里，或用下面的按钮从本地选；选好的先排进队列，点「开始上传」才真正建会话。</p>
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
          </div>
        </div>
      </div>

      <div v-if="tasks.length" class="pk-card pk-queue">
        <div class="pk-queue__head">
          <span>
            队列 {{ tasks.length }} 张 · 合计 {{ formatBytes(totalBytes) }}
            <span v-if="pickedTemp && targetAlbum" class="pk-muted">
              · 交付给 {{ pickedTemp.code }} · 进「{{ targetAlbum.name }}」
            </span>
          </span>
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
            <el-radio-group
              v-if="task.state === '排队'"
              v-model="task.stage"
              class="pk-task__stage"
              size="small"
            >
              <el-radio-button value="pre">前期</el-radio-button>
              <el-radio-button value="post">后期</el-radio-button>
            </el-radio-group>
            <span v-else class="pk-chip pk-task__stage">{{ STAGE_LABEL[task.stage] }}</span>
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

.pk-flow {
  display: grid;
  gap: 12px;
  margin-bottom: 16px;
}

.pk-step {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 14px 16px;
  border-left: 3px solid var(--pk-line);
}

.pk-step--done {
  border-left-color: var(--pk-brand);
}

.pk-step__no {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}

.pk-step__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.pk-step__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.pk-step__title {
  font-size: 15px;
  font-weight: 600;
}

.pk-step__badge {
  flex: none;
}

.pk-step__desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}

.pk-step__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-brief {
  display: grid;
  gap: 5px;
  margin: 2px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--pk-line);
  border-radius: 10px;
  background: #fafaff;
}

.pk-brief__row {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.pk-brief__row dt {
  flex: none;
  width: 58px;
  color: var(--pk-muted);
}

.pk-brief__row dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.pk-upload__label {
  font-size: 14px;
  font-weight: 600;
}

.pk-upload__album {
  width: 260px;
}

.pk-upload__temp {
  width: 300px;
  max-width: 100%;
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

.pk-upload__stage-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.pk-task__stage {
  flex: none;
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
  margin: 0;
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

  .pk-step {
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 10px;
    padding: 12px;
  }

  .pk-step__no {
    width: 24px;
    height: 24px;
    font-size: 12px;
  }

  .pk-brief__row {
    display: block;
    font-size: 12px;
  }

  .pk-brief__row dt {
    width: auto;
    margin-bottom: 1px;
  }

  .pk-task__name {
    flex-direction: column;
    gap: 2px;
  }
}
</style>
