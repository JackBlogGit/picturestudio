<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Clock, WarningFilled } from '@element-plus/icons-vue';
import { useSessionStore } from '@/stores/session';

/** 图 9 顶部通栏：到期时刻由服务端下发，差值用服务端时钟算，改本机时间不能续命（PRD 8.5） */
const props = defineProps<{ expiresAt: string }>();

const session = useSessionStore();
const now = ref(session.serverNow());
let timer: number | undefined;

const rest = computed(() => Math.max(0, Date.parse(props.expiresAt) - now.value));
const days = computed(() => Math.floor(rest.value / 86_400_000));
const expired = computed(() => rest.value <= 0);
const urgent = computed(() => !expired.value && days.value <= 1);

const pad = (value: number): string => String(value).padStart(2, '0');
const value = computed(() => {
  if (expired.value) return '已到期';
  const left = rest.value % 86_400_000;
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `剩余 ${days.value} 天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
});

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = session.serverNow();
  }, 1000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <div class="pk-count" :class="{ 'pk-count--urgent': urgent, 'pk-count--expired': expired }">
    <el-icon class="pk-count__icon"><component :is="urgent || expired ? WarningFilled : Clock" /></el-icon>
    <div class="pk-count__text">
      <span class="pk-count__label">距离帐号销毁时长为：</span>
      <span class="pk-count__value">{{ value }}</span>
      <span v-if="urgent" class="pk-count__tip">即将销毁，请及时取图</span>
    </div>
  </div>
</template>

<style scoped>
.pk-count {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  background: var(--pk-card);
  border: 1px solid var(--pk-line);
  border-radius: var(--pk-radius);
  box-shadow: var(--pk-shadow);
}

.pk-count__icon {
  font-size: 22px;
  color: var(--pk-brand);
}

.pk-count__text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-count__label {
  color: var(--pk-muted);
  font-size: 13px;
}

.pk-count__value {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.pk-count__tip {
  font-size: 12px;
  font-weight: 600;
}

.pk-count--urgent,
.pk-count--expired {
  border-color: #f56c6c;
  background: #fef0f0;
}

.pk-count--urgent .pk-count__icon,
.pk-count--urgent .pk-count__value,
.pk-count--urgent .pk-count__tip,
.pk-count--expired .pk-count__icon,
.pk-count--expired .pk-count__value {
  color: #f56c6c;
}
</style>
