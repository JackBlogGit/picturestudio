<script setup lang="ts">
import { computed } from 'vue';
import ImageTile from '@/components/ImageTile.vue';
import type { ImageView, TakeGroup } from '@/types/api';

const props = defineProps<{
  group: TakeGroup;
  selectable: boolean;
  selected: number[];
}>();

const emit = defineEmits<{
  (e: 'toggle', id: number): void;
  (e: 'toggleGroup', ids: number[]): void;
  (e: 'open', image: ImageView): void;
}>();

const groupIds = computed(() => props.group.images.map((i) => i.id));
</script>

<template>
  <div>
    <div class="pk-admin__head">
      <div>
        <h3 class="pk-section__title">{{ group.name }}</h3>
        <p class="pk-muted">{{ group.subtitle }} · {{ group.images.length }} 张</p>
      </div>
      <div v-if="selectable" class="pk-admin__inline">
        <el-button size="small" @click="emit('toggleGroup', groupIds)">本组全选 / 取消</el-button>
      </div>
    </div>

    <div class="pk-image-grid">
      <ImageTile
        v-for="img in group.images"
        :key="img.id"
        :image="img"
        :selectable="selectable"
        :selected="selected.includes(img.id)"
        @toggle="emit('toggle', $event)"
        @open="emit('open', $event)"
      />
    </div>
  </div>
</template>
