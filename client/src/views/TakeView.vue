<script setup lang="ts">
/**
 * 取图（PRD 18 章）。两种口径共用一个路由：
 * 临时账号 = 独立待领清单，分「前期修图」和「后期返图」两部分，各自独立完成独立展示；
 * 游客与成员 = 口令领图入口，粘贴返图链接或裸 token 跳到 /s/:token。
 * 某阶段未完成时对应 section 显示说明，不糊弄。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import TakeGroupBlock from '@/components/TakeGroupBlock.vue';
import { api, errorText, isApiError, previewSrc, USE_MOCK } from '@/api/client';
import type { ImageZipResult, ImageView, TakePending } from '@/types/api';
import { getTakePending } from '@/api/take';
import { getPublicShare } from '@/api/share';
import { formatBytes } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();

const isTemp = computed(() => session.profile?.kind === 'temp');
const data = ref<TakePending | null>(null);
const loading = ref(false);
const busy = ref(false);
const preview = ref<ImageView | null>(null);

// 前期 / 后期 各自独立的选择状态
const selectedPre = ref<number[]>([]);
const selectedPost = ref<number[]>([]);

/** 未开放下载时整页只读：不给勾选框 */
const canDownloadAll = computed(() => !!data.value?.canDownload);

// —— 前期 ——
const preSelectable = computed(() => canDownloadAll.value && !!data.value?.preStageDone);
const preAllIds = computed(() => (data.value ? data.value.preGroups.flatMap((g) => g.images.map((i) => i.id)) : []));
const preTotal = computed(() => preAllIds.value.length);

function togglePre(id: number): void {
  const at = selectedPre.value.indexOf(id);
  if (at >= 0) selectedPre.value.splice(at, 1);
  else selectedPre.value.push(id);
}
function selectAllPre(): void { selectedPre.value = [...preAllIds.value]; }
function clearPre(): void { selectedPre.value = []; }
function toggleGroupPre(ids: number[]): void {
  const picked = new Set(selectedPre.value);
  const allIn = ids.every((id) => picked.has(id));
  selectedPre.value = allIn
    ? selectedPre.value.filter((id) => !ids.includes(id))
    : [...new Set([...selectedPre.value, ...ids])];
}

// —— 后期 ——
const postSelectable = computed(() => canDownloadAll.value && !!data.value?.postStageDone);
const postAllIds = computed(() => (data.value ? data.value.postGroups.flatMap((g) => g.images.map((i) => i.id)) : []));
const postTotal = computed(() => postAllIds.value.length);

function togglePost(id: number): void {
  const at = selectedPost.value.indexOf(id);
  if (at >= 0) selectedPost.value.splice(at, 1);
  else selectedPost.value.push(id);
}
function selectAllPost(): void { selectedPost.value = [...postAllIds.value]; }
function clearPost(): void { selectedPost.value = []; }
function toggleGroupPost(ids: number[]): void {
  const picked = new Set(selectedPost.value);
  const allIn = ids.every((id) => picked.has(id));
  selectedPost.value = allIn
    ? selectedPost.value.filter((id) => !ids.includes(id))
    : [...new Set([...selectedPost.value, ...ids])];
}

/** 能存图的时候点格子等于勾选，只读的时候才弹预览——两种意图不该抢同一个点击 */
function onOpen(image: ImageView, selectable: boolean, toggle: (id: number) => void): void {
  if (selectable) toggle(image.id);
  else preview.value = image;
}

// —— 批量打包 ——
async function zip(imageIds: number[], label: string): Promise<void> {
  if (!imageIds.length) return;
  busy.value = true;
  try {
    const res = await api.post<ImageZipResult>('/images/batch-zip', { imageIds });
    if (res.rejected.length) {
      ElMessage.warning(`${label}：已受理 ${res.accepted} 张，${res.rejected.length} 张被挡：${res.rejected[0]?.message ?? ''}`);
    } else {
      ElMessage.success(`${label}：已受理 ${res.accepted} 张，约 ${formatBytes(res.estimatedSize)}`);
    }
    if (res.accepted) window.open(res.zipUrl, '_blank', 'noopener');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}
const zipPre = () => zip(selectedPre.value, '前期修图');
const zipPost = () => zip(selectedPost.value, '后期返图');

async function load(): Promise<void> {
  if (!isTemp.value) return;
  loading.value = true;
  try {
    data.value = await getTakePending();
    selectedPre.value = [];
    selectedPost.value = [];
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

// ---------------- 口令领图（游客 / 成员） ----------------

const tokenInput = ref('');
const checking = ref(false);

/** 支持直接粘贴整条链接：从 /s/ 后面截 token，裸 token 原样用 */
function extractToken(input: string): string {
  const raw = input.trim();
  const matched = /\/s\/([^/?#]+)/.exec(raw);
  return decodeURIComponent(matched ? matched[1] : raw);
}

async function openToken(): Promise<void> {
  const token = extractToken(tokenInput.value);
  if (!token) {
    ElMessage.warning('先粘贴返图链接或访问口令');
    return;
  }
  checking.value = true;
  try {
    await getPublicShare(token);
    await router.push(`/s/${encodeURIComponent(token)}`);
  } catch (err) {
    // 要密码不算失败，交给 /s/:token 自己弹密码框
    if (isApiError(err) && err.code === 'SHARE_PASSWORD_REQUIRED') {
      await router.push(`/s/${encodeURIComponent(token)}`);
      return;
    }
    ElMessage.error(errorText(err, '口令无效或已失效'));
  } finally {
    checking.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="pk-take">
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">取图</h2>
        <p class="pk-muted">
          {{
            isTemp
              ? '取图分两部分：前期修图（初调色）和后期返图（精修成片），各自独立完成后自动出现在下方。'
              : '把手里的返图链接或访问口令贴进来，就能打开那一批图。'
          }}
        </p>
      </div>
      <div v-if="isTemp" class="pk-admin__inline">
        <el-button size="small" :disabled="loading" @click="load">刷新清单</el-button>
      </div>
    </div>

    <!-- 临时账号：待领清单 -->
    <template v-if="isTemp">
      <!-- 只读预览提示（下载开关关闭） -->
      <el-alert
        v-if="data && !data.canDownload"
        class="pk-take__alert"
        type="warning"
        :closable="false"
        show-icon
        title="只读预览"
        description="这个账号没有开通下载开关（allow_download），只能看预览图。要原图请找归属你的成员改授权。"
      />

      <!-- 前期修图 section -->
      <div class="pk-take__stage">
        <div class="pk-admin__head">
          <div>
            <h3 class="pk-section__title">
              前期修图
              <span :class="['pk-chip', data?.preStageDone ? '' : 'pk-chip--ghost']">
                {{ data?.preStageDone ? '已完成' : '进行中' }}
              </span>
            </h3>
            <p class="pk-muted">原图筛选 + 初修（调色、液化、裁剪、去瑕疵）</p>
          </div>
        </div>

        <el-alert
          v-if="data && !data.preStageDone"
          class="pk-take__alert"
          type="info"
          :closable="false"
          show-icon
          title="前期修图中"
          description="工作室正在进行前期初修，修完之后这里会自动列出。"
        />

        <template v-else-if="data && data.preStageDone">
          <div v-if="preSelectable && preAllIds.length" class="pk-admin__toolbar">
            <span class="pk-muted">已选 {{ selectedPre.length }} / {{ preTotal }} 张</span>
            <el-button size="small" :disabled="!preAllIds.length" @click="selectAllPre">全部选中</el-button>
            <el-button size="small" :disabled="!selectedPre.length" @click="clearPre">清空选择</el-button>
            <el-button size="small" type="primary" :disabled="!selectedPre.length" :loading="busy" @click="zipPre">
              批量存图{{ selectedPre.length ? `(${selectedPre.length})` : '' }}
            </el-button>
          </div>

          <article v-for="group in data.preGroups" :key="`pre-${group.kind}-${group.id}`" class="pk-card pk-take__group">
            <TakeGroupBlock
              :group="group"
              :selectable="preSelectable"
              :selected="selectedPre"
              @toggle="togglePre"
              @toggle-group="toggleGroupPre"
              @open="(img) => onOpen(img, preSelectable, togglePre)"
            />
          </article>

          <p v-if="!preAllIds.length" class="pk-muted">
            白名单相册里还没有对你可见的前期图，可能是相册被锁定或档位不匹配。
          </p>
        </template>
      </div>

      <!-- 后期返图 section -->
      <div class="pk-take__stage">
        <div class="pk-admin__head">
          <div>
            <h3 class="pk-section__title">
              后期返图
              <span :class="['pk-chip', data?.postStageDone ? '' : 'pk-chip--ghost']">
                {{ data?.postStageDone ? '已完成' : '进行中' }}
              </span>
            </h3>
            <p class="pk-muted">精修成片回传给 coser 并交付</p>
          </div>
        </div>

        <el-alert
          v-if="data && !data.postStageDone"
          class="pk-take__alert"
          type="info"
          :closable="false"
          show-icon
          title="后期还没修完"
          description="工作室正在进行后期精修，修完之后这里会自动列出。"
        />

        <template v-else-if="data && data.postStageDone">
          <div v-if="postSelectable && postAllIds.length" class="pk-admin__toolbar">
            <span class="pk-muted">已选 {{ selectedPost.length }} / {{ postTotal }} 张</span>
            <el-button size="small" :disabled="!postAllIds.length" @click="selectAllPost">全部选中</el-button>
            <el-button size="small" :disabled="!selectedPost.length" @click="clearPost">清空选择</el-button>
            <el-button size="small" type="primary" :disabled="!selectedPost.length" :loading="busy" @click="zipPost">
              批量存图{{ selectedPost.length ? `(${selectedPost.length})` : '' }}
            </el-button>
          </div>

          <article v-for="group in data.postGroups" :key="`post-${group.kind}-${group.id}`" class="pk-card pk-take__group">
            <TakeGroupBlock
              :group="group"
              :selectable="postSelectable"
              :selected="selectedPost"
              @toggle="togglePost"
              @toggle-group="toggleGroupPost"
              @open="(img) => onOpen(img, postSelectable, togglePost)"
            />
          </article>

          <p v-if="!postAllIds.length" class="pk-muted">
            白名单相册里还没有对你可见的后期图，可能是相册被锁定或档位不匹配。
          </p>
        </template>
      </div>
    </template>

    <!-- 游客 / 成员：口令领图 -->
    <div v-else class="pk-card pk-take__token">
      <el-input
        v-model="tokenInput"
        placeholder="粘贴返图链接，或直接输入访问口令"
        clearable
        @keyup.enter="openToken"
      />
      <el-button type="primary" :loading="checking" @click="openToken">打开</el-button>
      <p class="pk-muted">
        口令由工作室在「返图链接」页签发，只对这一个 Coser 的那批图有效；
        链接过期或注销后立即失效。
      </p>
      <p v-if="!session.loggedIn" class="pk-muted">
        当前是游客视角，口令通过后也只能看压缩预览，不能下载原图。
      </p>
      <p v-if="session.loggedIn" class="pk-muted">
        想按漫展 / Coser / 角色挑公开相册，去
        <router-link class="pk-link" to="/albums">相册页</router-link>
        更快。
      </p>
    </div>

    <el-dialog :model-value="!!preview" width="min(980px, 94vw)" @close="preview = null" class="pk-take__viewer">
      <div v-if="preview" class="pk-take__preview">
        <img :src="previewSrc(preview.links.preview)" :alt="preview.filename" />
        <p class="pk-muted">
          {{ preview.filename }} · {{ preview.width }}×{{ preview.height }} ·
          {{ formatBytes(preview.fileSize) }}
        </p>
      </div>
    </el-dialog>

    <p v-if="USE_MOCK" class="pk-muted pk-take__note">
      演示模式：待领清单与打包回执由前端 mock 生成，未连后端。
    </p>
  </section>
</template>

<style scoped>
.pk-take__alert {
  margin-bottom: 12px;
}

.pk-take__stage {
  margin-bottom: 24px;
}

.pk-take__group {
  padding: 14px 16px;
  margin-bottom: 14px;
}

.pk-take__viewer :deep(.el-dialog) {
  border-radius: var(--pk-radius);
}

@media (max-width: 640px) {
  .pk-take__viewer :deep(.el-dialog) {
    width: 100vw !important;
    max-height: 100vh;
    margin: 0;
    border-radius: 0;
  }

  .pk-take__viewer :deep(.el-dialog__body) {
    padding: 8px;
    max-height: 90vh;
    overflow-y: auto;
  }
}

.pk-take__token {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 18px;
  max-width: 720px;
}

@media (max-width: 640px) {
  .pk-take__token {
    grid-template-columns: 1fr;
  }

  .pk-take__token .el-button {
    width: 100%;
  }
}

.pk-take__token p {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}

.pk-take__preview img {
  width: 100%;
  border-radius: 10px;
}

.pk-take__preview p {
  font-size: 12px;
  margin: 8px 0 0;
}

.pk-take__note {
  margin-top: 12px;
  font-size: 12px;
}
</style>
