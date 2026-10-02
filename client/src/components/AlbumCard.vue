<script setup lang="ts">
import { computed } from 'vue';
import { previewSrc } from '@/api/client';
import type { AlbumView } from '@/types/api';
import { ALBUM_STATUS_LABEL, STAGE_LABEL, VISIBILITY_LABEL } from '@/types/api';

const props = defineProps<{ album: AlbumView; imagesCount?: number }>();

/** 封面也走鉴权预览接口，不给 originals 留任何直链（PRD 12.3） */
const cover = computed(() =>
  props.album.coverImgId ? previewSrc(`/api/v1/images/${props.album.coverImgId}/preview`) : '',
);

const visibilityTone = computed(() => {
  switch (props.album.visibility) {
    case 'public':
      return 'pk-chip';
    case 'member':
      return 'pk-chip pk-chip--ghost';
    default:
      return 'pk-chip pk-chip--warn';
  }
});
</script>

<template>
  <router-link class="pk-album-card pk-card" :to="`/albums/${album.id}`">
    <div class="pk-album-card__cover">
      <img v-if="cover" :src="cover" :alt="album.name" loading="lazy" />
      <div v-else class="pk-album-card__placeholder">无封面</div>
      <div class="pk-album-card__badges">
        <span :class="visibilityTone">{{ VISIBILITY_LABEL[album.visibility] }}</span>
        <span class="pk-chip pk-chip--ghost pk-chip--stage">{{ STAGE_LABEL[album.stage] }}</span>
        <span v-if="album.status !== 1" class="pk-chip pk-chip--warn">{{ ALBUM_STATUS_LABEL[album.status] }}</span>
      </div>
    </div>
    <div class="pk-album-card__body">
      <h3>{{ album.name }}</h3>
      <p class="pk-muted">
        {{ album.eventName || '未标注漫展' }} · {{ album.eventDate || '日期待定' }}
        <template v-if="album.location"> · {{ album.location }}</template>
      </p>
      <p class="pk-album-card__meta pk-muted">
        <span>{{ imagesCount ?? '—' }} 张</span>
        <span v-if="album.description" class="pk-ellipsis">{{ album.description }}</span>
      </p>
    </div>
  </router-link>
</template>

<style scoped>
.pk-album-card {
  display: block;
  overflow: hidden;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.pk-album-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(31, 31, 41, 0.12);
}

.pk-album-card__cover {
  position: relative;
  aspect-ratio: 4 / 3;
  background: #e9ebf3;
}

.pk-album-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pk-album-card__placeholder {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--pk-muted);
  font-size: 12px;
}

.pk-album-card__badges {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 6px;
}

.pk-album-card__body {
  padding: 10px 12px 14px;
}

.pk-album-card__body h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.pk-album-card__body p {
  margin: 2px 0;
  font-size: 12px;
}

.pk-album-card__meta {
  display: flex;
  gap: 8px;
}

.pk-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
