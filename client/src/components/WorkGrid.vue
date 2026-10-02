<script setup lang="ts">
/**
 * 首页功能宫格的渲染壳（PRD 8.5 的上图下文卡片 + 按格数定列数）。
 * 工作台与游客展示首页共用，点击一律抛给父层：危险格要弹二次确认、
 * 未实现的格要弹提示，这些判断不该长在格子里。
 */
import type { WorkCell } from '@/config/workbench';
import { columnsFor } from '@/config/workbench';

const props = defineProps<{ cells: WorkCell[]; cols?: number }>();
const emit = defineEmits<{ (e: 'select', cell: WorkCell): void }>();

const columns = () => props.cols ?? columnsFor(props.cells.length);
</script>

<template>
  <div class="pk-work__grid" role="group" aria-label="功能宫格" :style="{ '--pk-cols': columns() }">
    <button
      v-for="cell in cells"
      :key="cell.key"
      type="button"
      class="pk-work__cell"
      :class="{ 'pk-work__cell--danger': cell.danger }"
      @click="emit('select', cell)"
    >
      <span class="pk-work__icon"><el-icon :size="28"><component :is="cell.icon" /></el-icon></span>
      <span class="pk-work__name">{{ cell.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.pk-work__grid {
  display: grid;
  grid-template-columns: repeat(var(--pk-cols), minmax(0, 1fr));
  gap: 14px;
  margin-top: 14px;
}

.pk-work__cell {
  display: block;
  padding: 0;
  overflow: hidden;
  font: inherit;
  color: inherit;
  text-align: center;
  cursor: pointer;
  background: var(--pk-card);
  border: 1px solid var(--pk-line);
  border-radius: var(--pk-radius);
  box-shadow: var(--pk-shadow);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.pk-work__cell:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(31, 31, 41, 0.1);
}

.pk-work__cell:focus-visible {
  outline: 2px solid var(--pk-brand);
  outline-offset: 2px;
}

/* 上图下文：图标区约 4:3，横线分隔，格名写在线下方而不是浮在图上 */
.pk-work__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
}

.pk-work__name {
  display: block;
  padding: 9px 6px;
  border-top: 1px solid var(--pk-line);
  font-size: 13px;
  font-weight: 600;
}

.pk-work__cell--danger {
  border-color: #f56c6c;
}

.pk-work__cell--danger .pk-work__icon {
  background: #fef0f0;
  color: #f56c6c;
}

.pk-work__cell--danger .pk-work__name {
  border-top-color: #fbc4c4;
  color: #f56c6c;
}

@media (max-width: 640px) {
  .pk-work__grid {
    --pk-cols: 2 !important;
    gap: 10px;
  }
}
</style>
