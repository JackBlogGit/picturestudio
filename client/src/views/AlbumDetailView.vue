<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ImageTile from '@/components/ImageTile.vue';
import { api, errorText, previewSrc } from '@/api/client';
import { createPersonShareLink, createShareLink, listShareLinks, revokeShareLink } from '@/api/share';
import { createChildAlbum, listChildAlbums } from '@/api/albums';
import type { AlbumCapsView, AlbumCapKey, AlbumRowView, AlbumView, BatchResult, ImageView, Page, ShareLinkView, TagView, Visibility } from '@/types/api';
import { ALBUM_CAP_LABEL, ALBUM_STATUS_LABEL, STAGE_LABEL, TAG_TYPE_LABEL, UserLevel, VISIBILITY_LABEL, VISIBILITY_RANK } from '@/types/api';
import { formatDate, formatBytes, toPickerValue } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

type TagType = keyof typeof TAG_TYPE_LABEL;

const props = defineProps<{ id: string }>();
const session = useSessionStore();

const album = ref<(AlbumView & AlbumCapsView) | null>(null);
const parentAlbum = ref<AlbumView | null>(null);
const images = ref<ImageView[]>([]);
const total = ref(0);
const loading = ref(false);

const FILTER_TYPES: TagType[] = ['event', 'coser', 'role', 'photographer', 'status'];
const tagGroups = reactive<Record<string, TagView[]>>({});
/** 已选标签按类型分组，类型之间 AND、同类型多值 OR（PRD 4.4） */
const picked = reactive<Record<string, number[]>>({});
const statusPicked = ref<number[]>([]);

const query = reactive({ page: 1, pageSize: 24 });

const selecting = ref(false);
const selectedIds = ref<Set<number>>(new Set());
const batchVisible = ref<Visibility>('member');
const batchTagIds = ref<number[]>([]);
const busy = ref(false);

const preview = ref<ImageView | null>(null);
const previewVisibility = ref<Visibility>('member');
const shotTimeDraft = ref('');

const shareOpen = ref(false);
const shareLinks = ref<ShareLinkView[]>([]);
const shareLoading = ref(false);
const shareForm = reactive({
  // album=只返本相册，person=这位 Coser 跨全部可对外相册汇总成一条
  scope: 'album' as 'album' | 'person',
  coserTagId: null as number | null,
  tagIds: [] as number[],
  snapshot: false,
  password: '',
  // 默认关：只给压缩预览，原图要显式放开（PRD 4.4 / 12.3）
  allowDownload: false,
  expireDays: 30,
});

// ---- 子相册 ----
const childAlbums = ref<AlbumRowView[]>([]);
const childrenLoading = ref(false);
const showCreateChild = ref(false);
const childForm = reactive({
  name: '',
  eventName: '',
  eventDate: '',
  location: '',
  description: '',
  visibility: 'member' as Visibility,
  stage: 'post' as 'pre' | 'post',
});
const childBusy = ref(false);

/** 当前身份是否能在本相册内建子相册：仅 L4 超管 */
const canCreateChildAlbum = computed(() => session.isMember && session.level === UserLevel.SuperAdmin);

/** 子相册可见性上限：不能宽于父相册 */
const childVisibilityOptions = computed<Visibility[]>(() => {
  if (!album.value) return ['member'];
  const parentRank = VISIBILITY_RANK[album.value.visibility];
  const allowed: Visibility[] = [];
  for (const v of session.visibilityOptions) {
    if (VISIBILITY_RANK[v] >= parentRank) allowed.push(v);
  }
  // 如果父相册是 public，子相册也只能是 public 或更严
  if (allowed.length === 0) allowed.push(album.value.visibility);
  return allowed;
});

async function loadChildAlbums(): Promise<void> {
  childrenLoading.value = true;
  try {
    childAlbums.value = await listChildAlbums(Number(props.id));
  } catch {
    childAlbums.value = [];
  } finally {
    childrenLoading.value = false;
  }
}

function openCreateChildDialog(): void {
  if (!album.value) return;
  // 从父相册预填部分字段
  childForm.eventName = album.value.eventName;
  childForm.eventDate = album.value.eventDate;
  childForm.location = album.value.location;
  childForm.visibility = album.value.visibility; // 默认跟随父相册
  childForm.stage = album.value.stage;
  childForm.name = '';
  childForm.description = '';
  showCreateChild.value = true;
}

async function handleCreateChild(): Promise<void> {
  if (!album.value) return;
  if (!childForm.name.trim()) {
    ElMessage.warning('请输入子相册名称');
    return;
  }
  childBusy.value = true;
  try {
    const newAlbum = await createChildAlbum(Number(props.id), {
      name: childForm.name.trim(),
      eventName: childForm.eventName.trim() || childForm.name.trim(),
      eventDate: childForm.eventDate || album.value.eventDate,
      location: childForm.location.trim(),
      description: childForm.description.trim(),
      visibility: childForm.visibility,
      stage: childForm.stage,
    });
    ElMessage.success(`子相册「${newAlbum.name}」已创建`);
    showCreateChild.value = false;
    await loadChildAlbums();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    childBusy.value = false;
  }
}

/** 新建链接时的标签候选，状态标签不参与对外筛选 */
const shareTagPool = computed(() =>
  (['event', 'coser', 'role', 'photographer'] as TagType[]).map((type) => ({
    type,
    tags: tagGroups[type] ?? [],
  })),
);

/** el-dialog 的 v-model 是开关，不能直接绑行对象 */
const previewOpen = computed({
  get: () => !!preview.value,
  set: (open: boolean) => {
    if (!open) preview.value = null;
  },
});

const pickedIds = computed(() => [
  ...FILTER_TYPES.flatMap((t) => (t === 'status' ? [] : picked[t] ?? [])),
  ...statusPicked.value,
]);

/**
 * D25：本册（含父链）被超管关掉的功能。界面按它不渲染入口，
 * 但闸门在接口层——policy 里的相册级判定会回 403 ALBUM_CAP_CLOSED（PRD 6.5）。
 */
const capClosed = (key: AlbumCapKey): boolean => (album.value?.capsOff ?? []).includes(key);
const closedCapNames = computed(() => (album.value?.capsOff ?? []).map((k) => ALBUM_CAP_LABEL[k]).join('、'));

/** L1 禁批量（PRD 6.1），临时账号要开 editTag 开关；册内把打标与改档位都关了就没有可批处理的事 */
const canBatch = computed(
  () =>
    ((session.isMember && session.level >= UserLevel.Member) ||
      (session.isTemp && session.caps.editOwn)) &&
    !(capClosed('editTag') && capClosed('changeVisibility')),
);
const selectable = computed(() => selecting.value && (session.isMember || session.isTemp));
const statusTagPool = computed(() => tagGroups.status ?? []);

async function loadTags(): Promise<void> {
  // 状态标签只对成员开放，非成员直接不请求这一组
  const types = session.isMember ? FILTER_TYPES : FILTER_TYPES.filter((t) => t !== 'status');
  await Promise.all(
    types.map(async (type) => {
      try {
        tagGroups[type] = await api.get<TagView[]>('/tags/suggest', { query: { type, q: '' } });
      } catch {
        tagGroups[type] = [];
      }
    }),
  );
}

async function loadAlbum(): Promise<void> {
  try {
    album.value = await api.get<AlbumView & AlbumCapsView>(`/albums/${props.id}`);
    // 若有父相册，同步加载名称用于面包屑
    if (album.value?.parentId !== null && album.value?.parentId !== undefined) {
      try {
        parentAlbum.value = await api.get<AlbumView>(`/albums/${album.value.parentId}`);
      } catch {
        parentAlbum.value = null;
      }
    } else {
      parentAlbum.value = null;
    }
  } catch (err) {
    ElMessage.error(errorText(err));
  }
}

async function loadImages(): Promise<void> {
  loading.value = true;
  try {
    const page = await api.get<Page<ImageView>>(`/albums/${props.id}/images`, {
      query: {
        tags: pickedIds.value.length ? pickedIds.value : undefined,
        status: statusPicked.value.length ? statusPicked.value : undefined,
        page: query.page,
        pageSize: query.pageSize,
      },
    });
    images.value = page.list;
    total.value = page.total;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  query.page = 1;
  await loadImages();
}

function toggleSelect(id: number): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll(): void {
  selectedIds.value = selectedIds.value.size === images.value.length ? new Set() : new Set(images.value.map((i) => i.id));
}

function leaveSelection(): void {
  selecting.value = false;
  selectedIds.value = new Set();
}

/** 后端逐条判定后会回 rejected[]，这里按 code 汇总成人能看懂的一行 */
function summarize(result: BatchResult, okText: string): void {
  if (result.updated) ElMessage.success(`${okText}：成功 ${result.updated} 张`);
  if (!result.rejected.length) return;
  const codes = new Map<string, number>();
  for (const item of result.rejected) {
    const key = `${item.code}·${item.message}`;
    codes.set(key, (codes.get(key) ?? 0) + 1);
  }
  const detail = [...codes.entries()]
    .map(([label, count]) => `· ${label}${count > 1 ? `（${count} 张）` : ''}`)
    .join('\n');
  ElMessageBox.alert(detail, `${result.rejected.length} 张被拒绝，未改动（不静默跳过，PRD 4.5）`, {
    type: 'warning',
    customClass: 'pk-reject-box',
  }).catch(() => undefined);
}

async function runBatchTags(add: number[], remove: number[]): Promise<void> {
  if (!add.length && !remove.length) {
    ElMessage.warning('请先选择要加或要去的标签');
    return;
  }
  busy.value = true;
  try {
    const result = await api.post<BatchResult>('/images/batch-tags', {
      imageIds: [...selectedIds.value],
      add,
      remove,
    });
    summarize(result, '批量打标');
    await Promise.all([loadImages(), loadTags()]);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

async function runBatchVisibility(): Promise<void> {
  busy.value = true;
  try {
    const result = await api.patch<BatchResult>('/images/batch-visibility', {
      imageIds: [...selectedIds.value],
      visibility: batchVisible.value,
    });
    summarize(result, '批量改档位');
    await loadImages();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

function openPreview(image: ImageView): void {
  preview.value = image;
  previewVisibility.value = image.visibility;
  shotTimeDraft.value = toPickerValue(image.shotTime);
}

async function saveMeta(patch: Record<string, unknown>): Promise<void> {
  if (!preview.value) return;
  busy.value = true;
  try {
    const next = await api.patch<ImageView>(`/images/${preview.value.id}`, patch);
    const index = images.value.findIndex((i) => i.id === next.id);
    if (index >= 0) images.value[index] = next;
    preview.value = next;
    shotTimeDraft.value = toPickerValue(next.shotTime);
    ElMessage.success('已保存');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

function saveShotTime(): void {
  const value = shotTimeDraft.value || null;
  void saveMeta({ shotTime: value });
}

function canEdit(image: ImageView | null): boolean {
  if (!image || !session.isMember) return false;
  const profile = session.profile;
  const uid = profile?.kind === 'user' ? profile.uid : 0;
  return session.caps.editAny || image.uploadUid === uid;
}

function onSizeChange(size: number): void {
  query.pageSize = size;
  query.page = 1;
  void loadImages();
}

function openShareDialog(): void {
  shareOpen.value = true;
  void loadShareLinks();
}

async function loadShareLinks(): Promise<void> {
  shareLoading.value = true;
  try {
    shareLinks.value = await listShareLinks({ album: Number(props.id) });
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    shareLoading.value = false;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('链接已复制到剪贴板');
  } catch {
    ElMessage.warning('浏览器拦了剪贴板，请手动选中下面的地址');
  }
}

async function createLink(): Promise<void> {
  if (shareForm.scope === 'person' && !shareForm.coserTagId) {
    ElMessage.warning('返给个人需要先选定一位 Coser');
    return;
  }
  const payload = {
    coserTagId: shareForm.coserTagId,
    tagIds: shareForm.tagIds,
    snapshot: shareForm.snapshot,
    password: shareForm.password || undefined,
    allowDownload: shareForm.allowDownload,
    expireDays: shareForm.expireDays,
  };
  busy.value = true;
  try {
    const link =
      shareForm.scope === 'person'
        ? await createPersonShareLink(payload)
        : await createShareLink(Number(props.id), payload);
    // 口令只在创建时经手一次，之后任何接口都不会再带回它（PRD 12.1）
    shareForm.password = '';
    ElMessage.success(`已生成：命中 ${link.imageCount} 张 · 来自 ${link.albumNames.length} 个相册`);
    await loadShareLinks();
    await copyText(link.url);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

async function revokeLink(link: ShareLinkView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `${link.coserName ?? '该链接'} 会立刻打不开，且不可恢复`,
      '撤销返图链接',
      { type: 'warning', confirmButtonText: '确定撤销', cancelButtonText: '再想想' },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await revokeShareLink(link.id);
    await loadShareLinks();
    ElMessage.success('已撤销');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadAlbum(), loadTags()]);
  await Promise.all([loadImages(), loadChildAlbums()]);
});

watch(
  () => props.id,
  async () => {
    leaveSelection();
    statusPicked.value = [];
    for (const key of Object.keys(picked)) delete picked[key];
    await Promise.all([loadAlbum(), loadTags()]);
    await Promise.all([loadImages(), loadChildAlbums()]);
  },
);

watch(pickedIds, () => void refresh(), { deep: true });
watch(statusPicked, () => void refresh(), { deep: true });
watch(() => query.page, () => void loadImages());
</script>

<template>
  <section v-loading="loading">
    <header class="pk-detail-head">
      <div>
        <nav v-if="parentAlbum" class="pk-breadcrumb">
          <router-link :to="`/albums/${parentAlbum.id}`">{{ parentAlbum.name }}</router-link>
          <span class="pk-breadcrumb__sep">›</span>
          <span class="pk-breadcrumb__current">{{ album?.name ?? '当前相册' }}</span>
        </nav>
        <h2 class="pk-page-title">{{ album?.name ?? '相册' }}</h2>
        <p class="pk-muted">
          <template v-if="album">
            {{ album.eventName }} · {{ album.eventDate }}
            <template v-if="album.location"> · {{ album.location }}</template>
            <span class="pk-chip pk-chip--ghost">{{ VISIBILITY_LABEL[album.visibility] }}</span>
            <span class="pk-chip pk-chip--ghost">{{ STAGE_LABEL[album.stage] }}</span>
            <span v-if="album.status !== 1" class="pk-chip pk-chip--warn">
              {{ ALBUM_STATUS_LABEL[album.status] }}
            </span>
          </template>
          <span v-if="album?.description"> · {{ album.description }}</span>
        </p>
        <p class="pk-muted">
          共 {{ total }} 张可见 · 当前身份 {{ session.displayName }}
          <template v-if="album?.status === 3">（相册已锁定，写操作会被逐条拒绝）</template>
        </p>
        <p v-if="closedCapNames" class="pk-muted pk-detail-caps">
          本相册已由超管关闭：{{ closedCapNames }}
          <template v-if="album?.capsInheritedOff?.length">（其中父相册带下来的项需回父册打开）</template>
        </p>
      </div>
      <div class="pk-detail-actions">
        <el-button v-if="session.caps.shareLink && !capClosed('shareLink')" @click="openShareDialog">生成返图链接</el-button>
        <el-button v-if="canCreateChildAlbum" type="success" plain @click="openCreateChildDialog">
          ＋ 新建子相册
        </el-button>
        <el-button
          v-if="session.caps.upload && !session.isTemp && !capClosed('upload')"
          type="primary"
          @click="$router.push(`/albums?tab=upload&album=${id}`)"
        >
          拍展传图
        </el-button>
        <el-button v-if="canBatch" :type="selecting ? 'warning' : 'default'" @click="selecting ? leaveSelection() : (selecting = true)">
          {{ selecting ? '退出多选' : '多选批处理' }}
        </el-button>
      </div>
    </header>

    <div class="pk-card pk-filterbar">
      <div v-for="type in FILTER_TYPES" :key="type" class="pk-filter-row">
        <span class="pk-filter-label">{{ TAG_TYPE_LABEL[type] }}</span>
        <template v-if="type === 'status' && !session.isMember">
          <span class="pk-muted pk-filter-hint">状态标签仅成员可见</span>
        </template>
        <template v-else-if="tagGroups[type]?.length">
          <el-check-tag
            v-for="tag in tagGroups[type]"
            :key="tag.id"
            :checked="type === 'status' ? statusPicked.includes(tag.id) : (picked[type] ?? []).includes(tag.id)"
            class="pk-filter-tag"
            @change="
              type === 'status'
                ? (statusPicked = statusPicked.includes(tag.id)
                    ? statusPicked.filter((v) => v !== tag.id)
                    : [...statusPicked, tag.id])
                : (picked[type] = (picked[type] ?? []).includes(tag.id)
                    ? (picked[type] ?? []).filter((v) => v !== tag.id)
                    : [...(picked[type] ?? []), tag.id])
            "
          >
            {{ tag.name }}
          </el-check-tag>
        </template>
        <span v-else class="pk-muted pk-filter-hint">暂无</span>
      </div>
      <p class="pk-filter-note pk-muted">类型之间是「且」，同类型多选是「或」；改档位不会宽于上级相册（PRD 3.2）。</p>
    </div>

    <div v-if="selectable" class="pk-card pk-batchbar">
      <el-button size="small" text @click="toggleSelectAll">
        {{ selectedIds.size === images.length ? '取消全选' : '全选本页' }}
      </el-button>
      <span class="pk-muted">已选 {{ selectedIds.size }} / {{ images.length }}</span>

      <template v-if="!capClosed('changeVisibility')">
        <el-select v-model="batchVisible" size="small" class="pk-batch-select">
          <el-option
            v-for="v in session.visibilityOptions"
            :key="v"
            :label="VISIBILITY_LABEL[v]"
            :value="v"
          />
        </el-select>
        <el-button size="small" :disabled="!selectedIds.size" :loading="busy" @click="runBatchVisibility">改档位</el-button>
      </template>

      <template v-if="!capClosed('editTag')">
        <el-select
          v-model="batchTagIds"
          size="small"
          multiple
          collapse-tags
          placeholder="选择标签"
          class="pk-batch-select"
        >
          <el-option-group v-for="type in ['event', 'coser', 'role', 'photographer']" :key="type" :label="TAG_TYPE_LABEL[type as TagType]">
            <el-option v-for="tag in tagGroups[type] ?? []" :key="tag.id" :label="tag.name" :value="tag.id" />
          </el-option-group>
          <el-option-group v-if="session.isMember" label="状态" :disabled="session.isTemp">
            <el-option v-for="tag in statusTagPool" :key="tag.id" :label="tag.name" :value="tag.id" />
          </el-option-group>
        </el-select>
        <el-button size="small" :disabled="!selectedIds.size" :loading="busy" @click="runBatchTags(batchTagIds, [])">
          批量加标签
        </el-button>
        <el-button size="small" :disabled="!selectedIds.size" :loading="busy" @click="runBatchTags([], batchTagIds)">
          批量去标签
        </el-button>
      </template>

      <span v-if="capClosed('editTag') || capClosed('changeVisibility')" class="pk-muted pk-batchbar__note">
        {{ capClosed('editTag') && capClosed('changeVisibility') ? '本相册的打标与改档位都已被超管关闭' : capClosed('editTag') ? '本相册的打标已被超管关闭，只能批量改档位' : '本相册的改档位已被超管关闭，只能批量打标' }}
      </span>
    </div>

    <!-- 子相册列表 -->
    <div v-if="childAlbums.length || childrenLoading" class="pk-card pk-children">
      <div class="pk-children__head">
        <strong class="pk-children__title">子相册</strong>
        <span class="pk-muted">{{ childAlbums.length }} 个</span>
      </div>
      <div v-if="childAlbums.length" class="pk-children__grid">
        <el-card
          v-for="child in childAlbums"
          :key="child.id"
          class="pk-children__card"
          shadow="hover"
          @click="$router.push(`/albums/${child.id}`)"
        >
          <template #header>
            <div class="pk-children__card-header">
              <span class="pk-children__card-name">{{ child.name }}</span>
              <span class="pk-chip pk-chip--ghost pk-children__chip">{{ VISIBILITY_LABEL[child.visibility] }}</span>
            </div>
          </template>
          <p class="pk-muted pk-children__card-meta">
            {{ child.eventName }} · {{ child.eventDate }}
            <template v-if="child.location"> · {{ child.location }}</template>
          </p>
          <p class="pk-muted pk-children__card-count">{{ child.imagesCount ?? 0 }} 张图片</p>
        </el-card>
      </div>
      <el-skeleton v-else-if="childrenLoading" :rows="2" animated />
    </div>

    <div v-if="images.length" class="pk-image-grid">
      <ImageTile
        v-for="image in images"
        :key="image.id"
        :image="image"
        :selectable="selectable"
        :selected="selectedIds.has(image.id)"
        @toggle="toggleSelect"
        @open="selectable ? toggleSelect($event.id) : openPreview($event)"
      />
    </div>
    <el-empty v-else-if="!loading" description="没有符合条件的图片，或它们不在当前身份的可见范围内" />

    <el-pagination
      v-if="total > query.pageSize"
      class="pk-pager"
      layout="prev, pager, next, sizes"
      :total="total"
      :page-size="query.pageSize"
      :current-page="query.page"
      :page-sizes="[12, 24, 48, 100]"
      @current-change="(p: number) => (query.page = p)"
      @size-change="onSizeChange"
    />

    <el-dialog v-model="previewOpen" width="min(980px, 94vw)" class="pk-preview">
      <template v-if="preview">
        <div class="pk-preview__body">
          <img class="pk-preview__img" :src="previewSrc(preview.links.preview)" :alt="preview.filename" />
          <aside class="pk-preview__meta">
            <h3>{{ preview.filename }}</h3>
            <dl>
              <dt>尺寸</dt>
              <dd>{{ preview.width }} × {{ preview.height }}</dd>
              <dt>体积</dt>
              <dd>{{ formatBytes(preview.fileSize) }}</dd>
              <dt>档位</dt>
              <dd>{{ VISIBILITY_LABEL[preview.visibility] }}</dd>
              <dt>水印</dt>
              <dd>{{ preview.watermarked ? '预览图已加水印' : '无' }}</dd>
              <dt>拍摄时间</dt>
              <dd>{{ preview.shotTime ? formatDate(preview.shotTime) : 'EXIF 缺失，可手动补填' }}</dd>
              <template v-if="preview.uploadUid !== null || preview.uploadTempId !== null">
                <dt>上传账号</dt>
                <dd>{{ preview.uploadTempId ? `游客 #${preview.uploadTempId}` : `成员 #${preview.uploadUid}` }}</dd>
              </template>
              <dt>MD5</dt>
              <dd class="pk-mono">{{ preview.md5 }}</dd>
            </dl>

            <p class="pk-preview__tags">
              <span v-for="tag in preview.tags" :key="tag.id" class="pk-chip">{{ tag.name }}</span>
              <span v-if="!preview.tags.length" class="pk-muted">无可见标签</span>
            </p>

            <div v-if="preview.links.original" class="pk-preview__actions">
              <el-link :href="preview.links.original" target="_blank" type="primary" :underline="false">
                下载原图（经鉴权接口）
              </el-link>
            </div>
            <p v-else class="pk-muted pk-preview__actions">
              {{
                capClosed('download')
                  ? '本相册的原图下载已被超管关闭'
                  : session.isTemp
                    ? '游客未开通下载开关，原图不可见'
                    : '该身份无原图下载权限'
              }}
            </p>

            <template v-if="canEdit(preview) && (!capClosed('editTag') || !capClosed('changeVisibility'))">
              <el-divider />
              <div class="pk-edit">
                <template v-if="!capClosed('editTag')">
                  <el-date-picker
                    v-model="shotTimeDraft"
                    type="datetime"
                    size="small"
                    placeholder="补填拍摄时间"
                    value-format="YYYY-MM-DDTHH:mm:ss"
                  />
                  <el-button size="small" :loading="busy" @click="saveShotTime">保存时间</el-button>
                </template>
                <template v-if="!capClosed('changeVisibility')">
                  <el-select v-model="previewVisibility" size="small" class="pk-edit__vis">
                    <el-option
                      v-for="v in session.visibilityOptions"
                      :key="v"
                      :label="VISIBILITY_LABEL[v]"
                      :value="v"
                    />
                  </el-select>
                  <el-button size="small" :loading="busy" @click="saveMeta({ visibility: previewVisibility })">
                    改这张的档位
                  </el-button>
                </template>
              </div>
            </template>
          </aside>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="shareOpen" title="返图链接" width="min(760px, 94vw)">
      <p class="pk-muted pk-share-note">
        链接在有效期内忽略图片自身的档位（D2），访客拿到的是压缩预览；勾了「允许下载原图」才出原图入口。
        相册档位为 admin/private 或状态为已锁定时，后端会直接拒绝生成；「返给个人」只会汇总到档位允许且未锁定的相册。
      </p>

      <div class="pk-card pk-share-form">
        <el-form label-position="top" @submit.prevent="createLink">
          <el-form-item label="返图范围">
            <el-radio-group v-model="shareForm.scope">
              <el-radio-button value="album">本相册</el-radio-button>
              <el-radio-button value="person">返给个人 · 跨全部相册</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <div class="pk-share-row">
            <el-form-item label="Coser" class="pk-share-col">
              <el-select
                v-model="shareForm.coserTagId"
                class="pk-share-col__ctl"
                clearable
                :placeholder="shareForm.scope === 'person' ? '必选：返给哪位 Coser' : '不指定＝整册精选'"
              >
                <el-option v-for="tag in tagGroups.coser ?? []" :key="tag.id" :label="tag.name" :value="tag.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="有效天数" class="pk-share-col">
              <el-input-number v-model="shareForm.expireDays" class="pk-share-col__ctl" :min="1" :max="365" />
            </el-form-item>
          </div>

          <el-form-item label="附加筛选标签">
            <el-select
              v-model="shareForm.tagIds"
              class="pk-share-wide"
              multiple
              collapse-tags
              clearable
              placeholder="按漫展／摄影／角色再收窄命中范围"
            >
              <el-option-group v-for="group in shareTagPool" :key="group.type" :label="TAG_TYPE_LABEL[group.type]">
                <el-option v-for="tag in group.tags" :key="tag.id" :label="tag.name" :value="tag.id" />
              </el-option-group>
            </el-select>
          </el-form-item>

          <el-form-item label="访问密码">
            <el-input
              v-model="shareForm.password"
              class="pk-share-wide"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="留空表示不设密码"
            />
          </el-form-item>

          <div class="pk-share-row pk-share-switches">
            <el-switch v-model="shareForm.snapshot" active-text="固化快照（此后新增图不进链接）" />
            <el-switch v-model="shareForm.allowDownload" active-text="允许下载原图" />
          </div>

          <el-button
            type="primary"
            :loading="busy"
            :disabled="shareForm.scope === 'person' && !shareForm.coserTagId"
            @click="createLink"
          >
            生成并复制
          </el-button>
        </el-form>
      </div>

      <div v-loading="shareLoading" class="pk-share-list">
        <p v-if="!shareLinks.length && !shareLoading" class="pk-muted">本相册还没有返图链接。</p>
        <div v-for="link in shareLinks" :key="link.id" class="pk-share-item">
          <div class="pk-share-item__head">
            <strong>{{ link.coserName ?? '整册精选' }}</strong>
            <span v-if="link.scope === 'person'" class="pk-chip">跨 {{ link.albumNames.length }} 个相册</span>
            <span class="pk-chip pk-chip--ghost">{{ link.snapshot === 1 ? '快照' : '实时筛选' }}</span>
            <span v-if="link.hasPassword" class="pk-chip">有密码</span>
            <span v-if="link.allowDownload === 1" class="pk-chip pk-chip--warn">可下原图</span>
            <span v-if="link.revoked === 1" class="pk-chip pk-chip--warn">已撤销</span>
            <span v-else-if="link.expired" class="pk-chip pk-chip--warn">已过期</span>
            <span class="pk-muted pk-share-item__count">命中 {{ link.imageCount }} 张 · 访问 {{ link.visitCount }} 次</span>
          </div>
          <el-input class="pk-share-item__url" size="small" readonly :model-value="link.url">
            <template #append>
              <el-button @click="copyText(link.url)">复制</el-button>
            </template>
          </el-input>
          <p class="pk-muted pk-share-item__meta">
            创建 {{ formatDate(link.createTime) }} · 到期 {{ formatDate(link.expireTime) }}
            <template v-if="link.lastVisitTime"> · 最近访问 {{ formatDate(link.lastVisitTime) }}</template>
            <template v-if="link.scope === 'person'"> · 来自 {{ link.albumNames.join('、') }}</template>
            <el-link class="pk-share-item__open" type="primary" :underline="false" :href="link.url" target="_blank">
              在新窗口打开
            </el-link>
            <el-button
              v-if="link.revoked === 0 && !link.expired"
              class="pk-share-item__revoke"
              size="small"
              type="danger"
              text
              :loading="busy"
              @click="revokeLink(link)"
            >
              撤销
            </el-button>
          </p>
        </div>
      </div>
    </el-dialog>

    <!-- 新建子相册弹窗 -->
    <el-dialog v-model="showCreateChild" title="在本相册内新建子相册" width="min(560px, 94vw)">
      <p class="pk-muted pk-share-note">
        子相册的可见范围不能宽于父相册；仅超级管理员可创建子相册。
      </p>
      <el-form label-position="top" @submit.prevent="handleCreateChild">
        <el-form-item label="子相册名称" required>
          <el-input v-model="childForm.name" placeholder="如：棚拍返图 / 现场原片" />
        </el-form-item>
        <div class="pk-share-row">
          <el-form-item label="漫展名称" class="pk-share-col">
            <el-input v-model="childForm.eventName" :placeholder="album?.eventName ?? ''" />
          </el-form-item>
          <el-form-item label="漫展日期" class="pk-share-col">
            <el-date-picker
              v-model="childForm.eventDate"
              type="date"
              value-format="YYYY-MM-DD"
              class="pk-share-col__ctl"
              :placeholder="album?.eventDate ?? ''"
            />
          </el-form-item>
        </div>
        <el-form-item label="地点">
          <el-input v-model="childForm.location" :placeholder="album?.location ?? ''" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="childForm.description" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
        <div class="pk-share-row">
          <el-form-item label="可见范围" class="pk-share-col">
            <el-select v-model="childForm.visibility" class="pk-share-col__ctl">
              <el-option
                v-for="v in childVisibilityOptions"
                :key="v"
                :label="VISIBILITY_LABEL[v]"
                :value="v"
              />
            </el-select>
            <p class="pk-muted pk-filter-hint" v-if="album">
              父相册为 {{ VISIBILITY_LABEL[album.visibility] }}，子相册不能比它更宽松。
            </p>
          </el-form-item>
          <el-form-item label="阶段" class="pk-share-col">
            <el-select v-model="childForm.stage" class="pk-share-col__ctl">
              <el-option label="前期 · 原片" value="pre" />
              <el-option label="后期 · 交付" value="post" />
            </el-select>
          </el-form-item>
        </div>
        <div class="pk-detail-actions">
          <el-button @click="showCreateChild = false">取消</el-button>
          <el-button type="primary" :loading="childBusy" @click="handleCreateChild">创建子相册</el-button>
        </div>
      </el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-detail-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.pk-detail-head .pk-muted {
  margin: 4px 0;
  font-size: 13px;
}

.pk-detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* D25：本册被超管关掉的功能，在头部单起一行说明 */
.pk-detail-caps {
  border-left: 3px solid var(--pk-warn, #e6a23c);
  padding-left: 8px;
}

.pk-batchbar__note {
  font-size: 12px;
}

.pk-filterbar,
.pk-batchbar {
  padding: 12px 14px;
  margin: 14px 0;
}

.pk-batchbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.pk-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.pk-filter-label {
  width: 56px;
  font-size: 12px;
  color: var(--pk-muted);
  flex: none;
}

.pk-filter-tag {
  font-size: 12px;
}

.pk-filter-hint {
  font-size: 12px;
}

.pk-filter-note {
  font-size: 12px;
  margin: 6px 0 0;
}

.pk-batch-select {
  width: 160px;
}

.pk-pager {
  margin-top: 18px;
  justify-content: center;
}

.pk-preview__body {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(220px, 1fr);
  gap: 18px;
}

@media (max-width: 760px) {
  .pk-preview__body {
    grid-template-columns: 1fr;
  }
}

.pk-preview__img {
  width: 100%;
  border-radius: 10px;
  background: #14141c;
  object-fit: contain;
  max-height: 70vh;
}

.pk-preview__meta h3 {
  margin: 0 0 10px;
  font-size: 15px;
  word-break: break-all;
}

.pk-preview__meta dl {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 6px 10px;
  margin: 0;
  font-size: 13px;
}

.pk-preview__meta dt {
  color: var(--pk-muted);
}

.pk-preview__meta dd {
  margin: 0;
}

.pk-mono {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.pk-preview__tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.pk-preview__actions {
  margin: 8px 0 0;
  font-size: 13px;
}

.pk-edit {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.pk-edit__vis {
  width: 130px;
}

.pk-share-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
}

.pk-share-form {
  padding: 14px 14px 0;
  margin-bottom: 16px;
}

.pk-share-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.pk-share-row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.pk-share-col {
  flex: 1 1 200px;
}

.pk-share-col__ctl,
.pk-share-wide {
  width: 100%;
}

.pk-share-switches {
  gap: 22px;
  margin-bottom: 14px;
}

.pk-share-list {
  min-height: 62px;
}

.pk-share-item {
  padding: 10px 0;
  border-top: 1px solid var(--pk-line);
}

.pk-share-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 13px;
}

.pk-share-item__count {
  margin-left: auto;
  font-size: 12px;
}

.pk-share-item__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 12px;
}

.pk-share-item__open {
  font-size: 12px;
}

.pk-share-item__revoke {
  margin-left: auto;
}

/* ---- 子相册列表 ---- */
.pk-breadcrumb {
  margin-bottom: 4px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pk-breadcrumb a {
  color: var(--pk-primary, #409eff);
  text-decoration: none;
}

.pk-breadcrumb a:hover {
  text-decoration: underline;
}

.pk-breadcrumb__sep {
  color: var(--pk-muted, #909399);
}

.pk-breadcrumb__current {
  color: var(--pk-muted, #909399);
}

.pk-children {
  padding: 14px 16px;
  margin: 14px 0;
}

.pk-children__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.pk-children__title {
  font-size: 14px;
}

.pk-children__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.pk-children__card {
  cursor: pointer;
  transition: transform 0.15s ease;
}

.pk-children__card:hover {
  transform: translateY(-2px);
}

.pk-children__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pk-children__card-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-children__chip {
  flex-shrink: 0;
}

.pk-children__card-meta {
  font-size: 12px;
  margin: 4px 0 2px;
}

.pk-children__card-count {
  font-size: 12px;
}
</style>
