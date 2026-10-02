<script setup lang="ts">
/**
 * Coser 返图页（PRD 4.4）：只凭链接 token 访问，不要求登录。
 * 口令未通过时后端回 403 SHARE_PASSWORD_REQUIRED，这里弹密码框；
 * 过期回 410、注销与不存在一律 404，三种情况都不给图片数据。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { errorText, isApiError, previewSrc, USE_MOCK } from '@/api/client';
import { getPublicShare, unlockShare } from '@/api/share';
import type { ImageView, PublicShareView } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';

const props = defineProps<{ shareToken: string }>();

const data = ref<PublicShareView | null>(null);
const needPassword = ref(false);
const dead = ref('');
const loading = ref(false);
const password = ref('');
const viewer = ref<ImageView | null>(null);
const viewerOpen = ref(false);

function openViewer(image: ImageView): void {
  viewer.value = image;
  viewerOpen.value = true;
}

const images = computed(() => data.value?.images ?? []);

/** 跨相册链接没有单一来源相册，页头三行都按 person 口径改写 */
const kicker = computed(() => {
  const d = data.value;
  if (!d) return '';
  return d.scope === 'person' ? d.eventName : `${d.eventName} · ${d.eventDate}`;
});
const title = computed(() => {
  const d = data.value;
  if (!d) return '';
  return d.scope === 'person' ? `${d.coserName} · 全部返图` : `${d.coserName} 的返图`;
});
const sourceLine = computed(() => {
  const d = data.value;
  if (!d) return '';
  const from = d.scope === 'person' ? `来自《${d.albumNames.join('》《')}》` : `来自相册《${d.albumName}》`;
  return `${from}，共 ${d.total} 张，有效期至 ${formatDate(d.expireTime)}。`;
});
/** 链接开了原图下载才给地址；mock 模式没有字节，点了只提示 */
const originalHref = (image: ImageView): string =>
  image.links.original ? (USE_MOCK ? '#' : previewSrc(image.links.original)) : '#';

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await getPublicShare(props.shareToken);
    needPassword.value = false;
    dead.value = '';
  } catch (err) {
    data.value = null;
    if (isApiError(err) && err.code === 'SHARE_PASSWORD_REQUIRED') {
      needPassword.value = true;
    } else {
      dead.value = errorText(err, '链接不可用');
    }
  } finally {
    loading.value = false;
  }
}

async function submitPassword(): Promise<void> {
  if (!password.value) {
    ElMessage.warning('请输入访问密码');
    return;
  }
  try {
    await unlockShare(props.shareToken, password.value);
    await load();
  } catch (err) {
    ElMessage.error(errorText(err, '密码校验失败'));
  }
}

function download(image: ImageView): void {
  if (!image.links.original) return;
  if (USE_MOCK) ElMessage.info('演示模式不回字节，真实部署时这里直接下载原图');
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="pk-share">
    <div v-if="needPassword" class="pk-card pk-share__gate">
      <h2 class="pk-page-title">此返图链接需要密码</h2>
      <p class="pk-muted">工作室为这组照片设置了访问密码，请向返图对接人索取。</p>
      <el-input
        v-model="password"
        type="password"
        show-password
        placeholder="访问密码"
        class="pk-share__pwd"
        @keyup.enter="submitPassword"
      />
      <el-button type="primary" @click="submitPassword">进入</el-button>
    </div>

    <div v-else-if="dead" class="pk-card pk-share__gate">
      <el-result icon="warning" :title="dead" sub-title="链接过期或被注销后永久失效，如需补发请联系工作室。" />
      <router-link to="/"><el-button>回到首页</el-button></router-link>
    </div>

    <template v-else-if="data">
      <header class="pk-card pk-share__head">
        <p class="pk-share__kicker">{{ kicker }}</p>
        <h2 class="pk-page-title">{{ title }}</h2>
        <p class="pk-muted pk-share__ellipsis">{{ sourceLine }}</p>
        <p class="pk-share__note">
          这里是压缩预览档{{ data.allowDownload ? '，本页已开放原图下载' : '，本页未开放原图下载' }}。
          链接到期后自动失效，图片不会留在服务器上。
        </p>
      </header>

      <div class="pk-image-grid">
        <figure v-for="image in images" :key="image.id" class="pk-share__cell" @click="openViewer(image)">
          <img :src="previewSrc(image.links.preview)" :alt="image.filename" loading="lazy" />
          <figcaption>
            <span class="pk-share__ellipsis">{{ image.filename }}</span>
            <span class="pk-muted">{{ image.width }}×{{ image.height }} · {{ formatBytes(image.fileSize) }}</span>
          </figcaption>
          <span v-if="image.links.original" class="pk-chip pk-chip--ghost pk-share__dl" @click.stop="download(image)">
            <a v-if="!USE_MOCK" :href="originalHref(image)" :download="image.filename" @click.stop>原图</a>
            <template v-else>原图</template>
          </span>
        </figure>
      </div>
      <p v-if="!images.length" class="pk-muted pk-share__empty">这条链接当前没有命中任何图片，可能相册还在整理中。</p>

      <el-dialog v-model="viewerOpen" width="min(1000px, 92vw)" append-to-body destroy-on-close class="pk-share__viewer">
        <template v-if="viewer">
          <img class="pk-share__big" :src="previewSrc(viewer.links.preview)" :alt="viewer.filename" />
          <div class="pk-share__meta">
            <strong>{{ viewer.filename }}</strong>
            <span class="pk-muted">
              {{ viewer.width }}×{{ viewer.height }} · {{ formatBytes(viewer.fileSize) }} ·
              {{ viewer.shotTime ? formatDate(viewer.shotTime) : 'EXIF 缺失' }}
            </span>
            <span v-if="viewer.tags.length" class="pk-share__tags">
              <span v-for="tag in viewer.tags" :key="tag.id" class="pk-chip">{{ tag.name }}</span>
            </span>
            <a
              v-if="viewer.links.original && !USE_MOCK"
              class="pk-share__link"
              :href="originalHref(viewer)"
              :download="viewer.filename"
            >下载原图</a>
          </div>
        </template>
      </el-dialog>
    </template>
  </section>
</template>

<style scoped>
.pk-share__viewer :deep(.el-dialog) {
  border-radius: var(--pk-radius);
}

@media (max-width: 640px) {
  .pk-share__viewer :deep(.el-dialog) {
    width: 100vw !important;
    max-height: 100vh;
    margin: 0;
    border-radius: 0;
  }

  .pk-share__viewer :deep(.el-dialog__body) {
    padding: 8px;
    max-height: 90vh;
    overflow-y: auto;
  }

  .pk-share__big {
    width: 100%;
    height: auto;
  }
}

.pk-share__gate {
  max-width: 520px;
  margin: 40px auto;
  padding: 26px 24px;
  text-align: center;
}

.pk-share__pwd {
  max-width: 260px;
  margin: 14px auto 16px;
}

.pk-share__head {
  padding: 18px 20px;
  margin-bottom: 14px;
}

.pk-share__kicker {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--pk-brand);
}

.pk-share__head .pk-page-title {
  margin: 2px 0 6px;
}

.pk-share__note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--pk-muted);
}

.pk-share__ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-share__link {
  color: var(--pk-brand);
  font-size: 13px;
}

.pk-share__cell {
  position: relative;
  margin: 0;
  aspect-ratio: 4 / 3;
  border-radius: 12px;
  overflow: hidden;
  background: #e9ebf3;
  cursor: zoom-in;
}

.pk-share__cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pk-share__cell figcaption {
  position: absolute;
  inset: auto 0 0 0;
  padding: 24px 10px 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.68));
  font-size: 12px;
}

.pk-share__dl {
  position: absolute;
  top: 8px;
  right: 8px;
}

.pk-share__dl a {
  color: inherit;
  text-decoration: none;
}

.pk-share__empty {
  padding: 20px 0;
}

.pk-share__big {
  width: 100%;
  max-height: 68vh;
  object-fit: contain;
  background: #14151c;
  border-radius: 10px;
}

.pk-share__meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  font-size: 13px;
}

.pk-share__tags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
</style>
