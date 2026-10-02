<script setup lang="ts">
import { computed } from 'vue';
import { previewSrc } from '@/api/client';
import type { ImageView } from '@/types/api';
import { VISIBILITY_LABEL } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';

const props = defineProps<{
  image: ImageView;
  selectable: boolean;
  selected: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle', id: number): void;
  (e: 'open', image: ImageView): void;
}>();

const src = computed(() => previewSrc(props.image.links.preview));
/** 竖图给 3/4、横图给 4/3，瀑布流才不会全部挤成同一个比例 */
const ratio = computed(() => (props.image.width >= props.image.height ? '4 / 3' : '3 / 4'));
</script>

<template>
  <figure class="pk-tile" :style="{ aspectRatio: ratio }" @click="emit('open', image)">
    <img :src="src" :alt="image.filename" loading="lazy" />

    <button
      v-if="selectable"
      type="button"
      class="pk-tile__pick"
      :class="{ 'is-on': selected }"
      @click.stop="emit('toggle', image.id)"
    >
      <span v-if="selected">✓</span>
    </button>

    <div class="pk-tile__badges">
      <span v-if="image.visibility !== 'public'" class="pk-chip pk-chip--warn">
        {{ VISIBILITY_LABEL[image.visibility] }}
      </span>
      <span v-if="image.watermarked" class="pk-chip pk-chip--ghost">水印</span>
    </div>

    <figcaption>
      <strong class="pk-ellipsis">{{ image.filename }}</strong>
      <span class="pk-muted">
        {{ image.width }}×{{ image.height }} · {{ formatBytes(image.fileSize) }} ·
        {{ image.shotTime ? formatDate(image.shotTime) : 'EXIF 缺失' }}
      </span>
      <span v-if="image.tags.length" class="pk-tile__tags">
        <span v-for="tag in image.tags.slice(0, 4)" :key="tag.id" class="pk-chip">{{ tag.name }}</span>
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.pk-tile {
  position: relative;
  margin: 0;
  border-radius: 12px;
  overflow: hidden;
  background: #e9ebf3;
  cursor: zoom-in;
}

.pk-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pk-tile figcaption {
  position: absolute;
  inset: auto 0 0 0;
  padding: 26px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.68));
  font-size: 12px;
}

.pk-tile figcaption .pk-muted {
  color: rgba(255, 255, 255, 0.78);
}

.pk-tile__badges {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
}

.pk-tile__tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.pk-tile__pick {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.32);
  color: #fff;
  display: grid;
  place-items: center;
  cursor: pointer;
  font-size: 12px;
}

.pk-tile__pick.is-on {
  background: var(--pk-brand);
  border-color: var(--pk-brand);
}
</style>
