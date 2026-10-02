<script setup lang="ts">
/** 仪表盘（PRD 8.2 第 1 页）：总量、存储水位、14 天上传趋势、最近审计。页面开着就是活的——每 10 秒重拉一次，数字滚动、柱体长高。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getDashboard } from '@/api/admin';
import { errorText } from '@/api/client';
import type { DashboardData } from '@/types/api';
import { VISIBILITY_LABEL } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';

type CountKey = keyof DashboardData['counts'];

const CARD_DEFS: { key: CountKey; label: string; hint: string }[] = [
  { key: 'albums', label: '相册', hint: '含各档位' },
  { key: 'images', label: '图片', hint: '未删的行数' },
  { key: 'folders', label: '网盘目录', hint: '最多 8 层' },
  { key: 'files', label: '网盘文件', hint: '按扩展名白名单' },
  { key: 'tags', label: '标签', hint: '五类' },
  { key: 'users', label: '成员', hint: '含禁用' },
  { key: 'tempActive', label: '在期临时账号', hint: '过期即失效' },
  { key: 'shareAlive', label: '有效返图链接', hint: '未过期未注销' },
];

const REFRESH_MS = 10_000;
const TWEEN_MS = 620;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const data = ref<DashboardData | null>(null);
const loading = ref(false);
const autoRefresh = ref(true);
const lastSync = ref<Date | null>(null);
const shown = ref<Partial<Record<CountKey, number>>>({});

const lastSyncText = computed(() => {
  const at = lastSync.value;
  if (!at) return '尚未同步';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
});

// ---------------- 计数滚动 ----------------

const tweens = new Map<CountKey, { raf: number; snap: number }>();

function stopTween(key: CountKey): void {
  const tween = tweens.get(key);
  if (!tween) return;
  cancelAnimationFrame(tween.raf);
  clearTimeout(tween.snap);
  tweens.delete(key);
}

function rollTo(key: CountKey, from: number, to: number): void {
  const start = performance.now();
  const state: { raf: number; snap: number } = { raf: 0, snap: 0 };
  const step = (now: number): void => {
    const p = Math.min(1, (now - start) / TWEEN_MS);
    shown.value[key] = Math.round(from + (to - from) * (1 - (1 - p) ** 3));
    if (p < 1) state.raf = requestAnimationFrame(step);
    else stopTween(key);
  };
  state.raf = requestAnimationFrame(step);
  // 后台标签页会冻结 rAF，兜底把数字落到真值，别让它停在半路
  state.snap = window.setTimeout(() => {
    shown.value[key] = to;
    stopTween(key);
  }, TWEEN_MS + 80);
  tweens.set(key, state);
}

function applyCounts(counts: DashboardData['counts'], animate: boolean): void {
  for (const { key } of CARD_DEFS) {
    const to = counts[key];
    const from = shown.value[key] ?? 0;
    stopTween(key);
    if (!animate || reduceMotion || from === to) shown.value[key] = to;
    else rollTo(key, from, to);
  }
}

// 首屏直接落值（没有旧值可滚），之后每次重拉才做差值动画
watch(
  () => data.value?.counts,
  (counts, prev) => {
    if (counts) applyCounts(counts, prev !== undefined);
  },
);

// ---------------- 轮询 ----------------

let timer: number | undefined;

async function load(opts: { silent?: boolean } = {}): Promise<void> {
  const silent = !!opts.silent;
  if (!silent) loading.value = true;
  try {
    data.value = await getDashboard();
    lastSync.value = new Date();
  } catch (err) {
    if (!silent) ElMessage.error(errorText(err));
    // 静默失败多半是会话掉了，再轮也只是空敲，先停住让状态可见
    else autoRefresh.value = false;
  } finally {
    if (!silent) loading.value = false;
  }
}

function tick(): void {
  if (document.hidden) return;
  load({ silent: true });
}

function onVisible(): void {
  if (!document.hidden && autoRefresh.value) load({ silent: true });
}

function restartTimer(): void {
  window.clearInterval(timer);
  timer = undefined;
  if (autoRefresh.value) timer = window.setInterval(tick, REFRESH_MS);
}

watch(autoRefresh, restartTimer);

onMounted(() => {
  load();
  restartTimer();
  document.addEventListener('visibilitychange', onVisible);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', onVisible);
  for (const key of [...tweens.keys()]) stopTween(key);
});

const trendMax = computed(() => Math.max(1, ...(data.value?.trend.map((t) => t.uploads) ?? [1])));
const trendLastIndex = computed(() => (data.value?.trend.length ?? 0) - 1);
</script>

<template>
  <section v-loading="loading">
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">仪表盘</h2>
        <p class="pk-muted">全站计数与存储水位。数据每次拉取实时聚合，没有缓存层。</p>
      </div>
      <div class="pk-live">
        <span class="pk-live__dot" :class="{ 'pk-live__dot--on': autoRefresh }" />
        <span class="pk-muted pk-live__text">
          <template v-if="autoRefresh">每 {{ REFRESH_MS / 1000 }} 秒自动拉取 · 上次同步 {{ lastSyncText }}</template>
          <template v-else>自动刷新已暂停</template>
        </span>
        <el-switch v-model="autoRefresh" size="small" active-text="自动刷新" />
        <el-button size="small" @click="load()">刷新</el-button>
      </div>
    </div>

    <el-alert
      v-if="data?.storage.warning"
      class="pk-admin__alert"
      type="warning"
      show-icon
      :closable="false"
      title="存储总量已超过 80%"
      :description="`已用 ${formatBytes(data.storage.used)} / 配额 ${formatBytes(data.storage.quota)}，先在站点设置里调默认配额或清理交付盘。`"
    />

    <div class="pk-admin__stats">
      <article v-for="(card, i) in CARD_DEFS" :key="card.label" class="pk-card pk-stat" :style="{ '--i': i }">
        <p class="pk-stat__label">{{ card.label }}</p>
        <p class="pk-stat__value">{{ shown[card.key] ?? 0 }}</p>
        <p class="pk-stat__hint">{{ card.hint }}</p>
      </article>
    </div>

    <div class="pk-admin__grid">
      <article class="pk-card pk-admin__card">
        <h3 class="pk-admin__card-title">近 14 天上传</h3>
        <div class="pk-trend">
          <div v-for="(day, i) in data?.trend ?? []" :key="day.date" class="pk-trend__col" :style="{ '--i': i }">
            <span class="pk-trend__bar" :class="{ 'pk-trend__bar--today': i === trendLastIndex }" :style="{ height: `${(day.uploads / trendMax) * 100}%` }" />
            <span class="pk-muted pk-trend__num">{{ day.uploads || '' }}</span>
            <span class="pk-muted pk-trend__date" :class="{ 'pk-trend__date--today': i === trendLastIndex }">
              {{ i === trendLastIndex ? '今天' : day.date.slice(5) }}
            </span>
          </div>
        </div>
        <p class="pk-muted pk-trend__note">趋势取自审计日志里的 image_upload 记录，没有记录就是 0。</p>
      </article>

      <article class="pk-card pk-admin__card">
        <h3 class="pk-admin__card-title">成员存储水位</h3>
        <div v-for="row in data?.storage.perUser ?? []" :key="row.uid" class="pk-usage">
          <div class="pk-usage__head">
            <span>{{ row.nickname }}</span>
            <span class="pk-muted">
              {{ formatBytes(row.used) }} / {{ row.quota ? formatBytes(row.quota) : '不限额' }}
            </span>
          </div>
          <el-progress
            :percentage="Math.min(100, Math.round(row.ratio * 100))"
            :stroke-width="6"
            :show-text="false"
            :status="row.ratio > 0.8 ? 'warning' : undefined"
          />
        </div>
      </article>
    </div>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">最新相册（前 5 组）</h3>
      <el-table :data="data?.albumList ?? []" size="small">
        <el-table-column prop="name" label="相册" min-width="200" />
        <el-table-column label="漫展" width="150">
          <template #default="{ row }">{{ row.eventName }} · {{ row.eventDate }}</template>
        </el-table-column>
        <el-table-column label="档位" width="94">
          <template #default="{ row }">
            <span class="pk-chip pk-chip--ghost">{{ VISIBILITY_LABEL[row.visibility as keyof typeof VISIBILITY_LABEL] }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="imagesCount" label="张数" width="70" />
        <el-table-column label="创建者" width="130">
          <template #default="{ row }">{{ row.createName }}</template>
        </el-table-column>
      </el-table>
    </article>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">最近审计</h3>
      <el-table :data="data?.recentLogs ?? []" size="small">
        <el-table-column label="时间" width="132">
          <template #default="{ row }">{{ formatDate(row.createTime) }}</template>
        </el-table-column>
        <el-table-column prop="userType" label="身份" width="72" />
        <el-table-column prop="action" label="操作" width="150" />
        <el-table-column prop="detail" label="详情" min-width="220" show-overflow-tooltip />
        <el-table-column label="结果" width="72">
          <template #default="{ row }">
            <span :class="['pk-chip', row.result === 1 ? 'pk-chip--ghost' : 'pk-chip--warn']">
              {{ row.result === 1 ? '成功' : '拒绝' }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </article>
  </section>
</template>

<style scoped>
.pk-admin__alert {
  margin: 14px 0;
}

.pk-admin__stats {
  margin: 14px 0;
}

.pk-admin__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 14px;
}

@media (max-width: 980px) {
  .pk-admin__grid {
    grid-template-columns: 1fr;
  }
}

.pk-live {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pk-live__text {
  font-size: 12px;
  white-space: nowrap;
}

.pk-live__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pk-muted);
  opacity: 0.45;
}

.pk-live__dot--on {
  background: #3fd08a;
  opacity: 1;
  animation: pk-pulse 1.8s ease-in-out infinite;
}

@keyframes pk-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgb(63 208 138 / 45%);
  }
  50% {
    box-shadow: 0 0 0 5px rgb(63 208 138 / 0%);
  }
}

.pk-stat {
  animation: pk-rise 0.45s ease-out both;
  animation-delay: calc(var(--i, 0) * 45ms);
}

@keyframes pk-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.pk-trend {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 130px;
}

.pk-trend__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  flex: 1;
  height: 100%;
  gap: 2px;
}

.pk-trend__bar {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  background: linear-gradient(180deg, var(--pk-brand), #b96bff);
  transition: height 0.55s cubic-bezier(0.22, 0.61, 0.36, 1);
  transition-delay: calc(var(--i, 0) * 28ms);
}

.pk-trend__bar--today {
  background: linear-gradient(180deg, #5ee0b0, var(--pk-brand));
}

.pk-trend__num {
  font-size: 11px;
}

.pk-trend__date {
  font-size: 10px;
}

.pk-trend__date--today {
  color: var(--pk-brand);
  font-weight: 700;
}

.pk-trend__note {
  font-size: 11px;
  margin: 10px 0 0;
}

.pk-usage {
  margin-bottom: 10px;
}

.pk-usage__head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 4px;
}

.pk-usage__head .pk-muted {
  font-size: 11px;
}

@media (prefers-reduced-motion: reduce) {
  .pk-stat,
  .pk-live__dot--on {
    animation: none;
  }

  .pk-trend__bar {
    transition: none;
  }
}
</style>
