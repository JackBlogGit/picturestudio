<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import AlbumCard from '@/components/AlbumCard.vue';
import WorkGrid from '@/components/WorkGrid.vue';
import { errorText, previewSrc, USE_MOCK } from '@/api/client';
import { listAlbums, type AlbumRow } from '@/api/albums';
import { getSiteInfo } from '@/api/public';
import { GUEST_CELLS, type WorkCell } from '@/config/workbench';
import type { SiteInfo } from '@/types/api';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();
const albums = ref<AlbumRow[]>([]);
const loading = ref(false);

/** 未登录那两格都有真路由，不需要工作台那套「尚未实现」提示与危险格分支 */
function openGuestCell(cell: WorkCell): void {
  if (cell.to) void router.push(cell.to);
}

/** 简介读后台配置（GET /public/site-info），这条只在接口没回来前兜住首屏 */
const FALLBACK: SiteInfo = {
  title: '皮克社工作室',
  introLines: [
    '专注漫展场照与 Cos 返图的摄影工作室，现场拍摄当天粗修、三天内精修交付。',
    '所有返图都按「漫展 / Coser / 角色」三级标签归档，找到自己的那组照片只需要点两下。',
    '原图一律经鉴权接口下发，未登录访问与分享链接只能看到压缩预览，交付更安心。',
  ],
  commentEnabled: true,
  watermarkText: '',
  contact: [],
};

const site = ref<SiteInfo | null>(null);

const intro = computed(() => site.value ?? FALLBACK);

const carousel = computed(() => albums.value.filter((a) => a.coverImgId).slice(0, 5));

const coverSrc = (album: AlbumRow): string => previewSrc(`/api/v1/images/${album.coverImgId}/preview`);

const eventNames = computed(() => {
  const groups = new Map<string, { date: string; count: number }>();
  for (const album of albums.value) {
    const key = album.eventName || '未标注漫展';
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { date: album.eventDate, count: 1 });
  }
  return [...groups.entries()]
    .map(([name, meta]) => ({ name, ...meta }))
    .sort((a, b) => b.date.localeCompare(a.date));
});

async function loadSite(): Promise<void> {
  try {
    site.value = await getSiteInfo();
  } catch {
    // 公开简介拉不到就用兜底文案，相册列表不该被它连累
  }
}

async function load(): Promise<void> {
  loading.value = true;
  void loadSite();
  try {
    const page = await listAlbums({ pageSize: 24 });
    albums.value = page.list;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading">
    <el-carousel v-if="carousel.length" class="pk-hero" :height="'clamp(240px, 42vw, 420px)'">
      <el-carousel-item v-for="album in carousel" :key="album.id">
        <router-link :to="`/albums/${album.id}`" class="pk-hero__item">
          <img :src="coverSrc(album)" :alt="album.name" />
          <div class="pk-hero__text">
            <h2>{{ album.name }}</h2>
            <p>{{ album.eventName }} · {{ album.eventDate }} · {{ album.location }}</p>
          </div>
        </router-link>
      </el-carousel-item>
    </el-carousel>

    <div class="pk-section pk-home-grid">
      <article class="pk-card pk-pad">
        <h2 class="pk-page-title">{{ intro.title }}</h2>
        <p v-for="line in intro.introLines" :key="line">{{ line }}</p>
        <p v-if="intro.watermarkText" class="pk-hint pk-muted">预览图水印：{{ intro.watermarkText }}</p>
        <p v-if="!session.loggedIn" class="pk-hint pk-muted">
          当前未登录，只显示公开相册。
          <router-link class="pk-link" to="/login">登录成员账号</router-link>
          可以看到成员可见档位的内容。
        </p>
        <div class="pk-actions">
          <el-button type="primary" @click="$router.push('/albums')">浏览全部相册</el-button>
        </div>
        <p v-if="USE_MOCK" class="pk-hint pk-muted">演示模式：图片来自本地样张，接口数据由前端 mock 生成。</p>
      </article>

      <aside class="pk-card pk-pad">
        <h3 class="pk-section__title">近期漫展</h3>
        <ul class="pk-events">
          <li v-for="item in eventNames" :key="item.name">
            <span>{{ item.name }}</span>
            <span class="pk-muted">{{ item.date }} · {{ item.count }} 组</span>
          </li>
          <li v-if="!eventNames.length" class="pk-muted">暂无公开相册</li>
        </ul>
      </aside>
    </div>

    <div class="pk-section pk-card pk-guest">
      <h3 class="pk-section__title">快捷入口</h3>
      <p class="pk-muted pk-guest__hint">手里有返图口令就直接领图，约稿与联系方式在「联系我们」里。</p>
      <WorkGrid :cells="GUEST_CELLS" :cols="2" @select="openGuestCell" />
    </div>

    <div class="pk-section">
      <div class="pk-section__head">
        <h3 class="pk-section__title">公开相册</h3>
        <router-link class="pk-link" to="/albums">全部 {{ albums.length }} 组 →</router-link>
      </div>
      <div class="pk-masonry">
        <AlbumCard v-for="album in albums.slice(0, 8)" :key="album.id" :album="album" />
      </div>
      <p v-if="!albums.length && !loading" class="pk-muted">这个身份下没有可见的相册。</p>
    </div>
  </section>
</template>

<style scoped>
.pk-hero {
  border-radius: var(--pk-radius);
  overflow: hidden;
}

.pk-hero__item {
  position: relative;
  display: block;
  height: 100%;
}

.pk-hero__item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pk-hero__text {
  position: absolute;
  inset: auto 0 0 0;
  padding: 40px 20px 16px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
}

.pk-hero__text h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.pk-hero__text p {
  margin: 0;
  font-size: 13px;
  opacity: 0.86;
}

.pk-home-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
}

.pk-guest {
  padding: 16px 18px;
}

.pk-guest__hint {
  margin: 6px 0 0;
  font-size: 12px;
}

/* 只有两格，铺满整行会让 4:3 的图标区撑成一面墙 */
.pk-guest :deep(.pk-work__grid) {
  max-width: 420px;
}

@media (max-width: 820px) {
  .pk-home-grid {
    grid-template-columns: 1fr;
  }
}

.pk-pad {
  padding: 16px 18px;
}

.pk-pad p {
  line-height: 1.75;
  margin: 8px 0;
}

.pk-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.pk-hint {
  font-size: 12px;
}

.pk-link {
  color: var(--pk-brand);
}

.pk-events {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}

.pk-events li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--pk-line);
  font-size: 13px;
}

.pk-events li:last-child {
  border-bottom: none;
}
</style>
