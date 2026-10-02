<script setup lang="ts">
/**
 * 任务管理（手绘稿 23）：比任务列表多三样——状态筛选、排序、勾「已完成」与注销账号。
 * 筛选在前台本地做（要同时给每枚 chip 计数，拆成查询参数就得把判定写两遍），
 * 搜索与排序交给服务端；勾阶段是 L2 也能做的跟进动作，注销要 L3，
 * 归属越权由 mock/temps.ts 挡，页面只按 caps.adminConsole 决定按钮出不出现。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { errorText } from '@/api/error';
import { destroyTask, listTasks, setTaskStage } from '@/api/temp';
import type { TaskFilter, TempTaskRow } from '@/types/api';
import { formatDate } from '@/utils/format';
import TaskFilesDrawer from '@/components/TaskFilesDrawer.vue';
import { useSessionStore } from '@/stores/session';

const FILTERS: { key: TaskFilter | 'all'; label: string; hit: (row: TempTaskRow) => boolean }[] = [
  { key: 'all', label: '全部', hit: () => true },
  { key: 'stage1_open', label: '前期未完成', hit: (r) => !r.stage1 },
  { key: 'stage2_open', label: '后期未完成', hit: (r) => !r.stage2 },
  { key: 'stage1_done', label: '前期已完成', hit: (r) => !!r.stage1 },
  { key: 'stage2_done', label: '后期已完成', hit: (r) => !!r.stage2 },
  { key: 'all_done', label: '全部已完成', hit: (r) => !!r.stage1 && !!r.stage2 },
];

const session = useSessionStore();
const router = useRouter();

const keyword = ref('');
const scope = ref<'mine' | 'all'>('mine');
const sort = ref<'asc' | 'desc'>('asc');
const active = ref<TaskFilter | 'all'>('all');
const rows = ref<TempTaskRow[]>([]);
const loading = ref(false);
const opened = ref<TempTaskRow | null>(null);
const drawer = ref(false);

const counts = computed(() =>
  FILTERS.map((item) => ({ ...item, count: rows.value.filter(item.hit).length })),
);

const shown = computed(() => {
  const hit = FILTERS.find((item) => item.key === active.value)?.hit ?? (() => true);
  return rows.value.filter(hit);
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listTasks({
      keyword: keyword.value.trim() || undefined,
      scope: scope.value,
      sort: sort.value,
    });
  } catch (err) {
    ElMessage.error(errorText(err, '任务读不出来'));
  } finally {
    loading.value = false;
  }
}

/** 勾一下即改：失败就把整表重拉回来，界面不能留着没生效的对勾 */
async function toggleStage(row: TempTaskRow, stage: 1 | 2, done: boolean): Promise<void> {
  try {
    const next = await setTaskStage(row.tempId, { stage, done: done ? 1 : 0 });
    rows.value = rows.value.map((r) => (r.tempId === next.tempId ? next : r));
    ElMessage.success(`${row.code} 的${stage === 1 ? '前期' : '后期'}返图已标为${done ? '完成' : '未完成'}`);
  } catch (err) {
    ElMessage.error(errorText(err, '改不动'));
    await load();
  }
}

async function destroy(row: TempTaskRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `注销后 ${row.code} 立刻不能登录。它在「拍展」里的目录和已交付的文件都保留（规则 3），要清内容请去网盘。`,
      '注销帐号',
      { type: 'warning', confirmButtonText: '确认注销', cancelButtonText: '再等等' },
    );
  } catch {
    return;
  }
  try {
    await destroyTask(row.tempId);
    rows.value = rows.value.filter((r) => r.tempId !== row.tempId);
    ElMessage.success(`${row.code} 已注销`);
  } catch (err) {
    ElMessage.error(errorText(err, '注销失败'));
  }
}

onMounted(load);
</script>

<template>
  <section class="pk-manage">
    <header class="pk-manage__head">
      <div>
        <h1 class="pk-page-title">任务管理</h1>
        <p class="pk-muted">查帐户ID、筛状态、勾前期与后期返图，到期没回收的在这里注销。</p>
      </div>
      <el-button text @click="router.push({ name: 'tasks' })">返回任务列表</el-button>
    </header>

    <div class="pk-manage__bar pk-card">
      <el-input v-model="keyword" placeholder="查询 帐户ID / 名称 / 拍摄内容" clearable @keyup.enter="load" />
      <el-button type="primary" :loading="loading" @click="load">搜索</el-button>
      <el-radio-group v-if="session.caps.adminConsole" v-model="scope" @change="load">
        <el-radio-button value="mine">我登记的</el-radio-button>
        <el-radio-button value="all">全部成员</el-radio-button>
      </el-radio-group>
      <el-select v-model="sort" style="width: 140px" @change="load">
        <el-option label="时间递增" value="asc" />
        <el-option label="时间递减" value="desc" />
      </el-select>
    </div>

    <div class="pk-manage__chips">
      <button
        v-for="item in counts"
        :key="item.key"
        type="button"
        class="pk-chip pk-manage__chip"
        :class="{ 'pk-manage__chip--on': active === item.key }"
        @click="active = item.key"
      >
        {{ item.label }} {{ item.count }}
      </button>
    </div>

    <div v-loading="loading" class="pk-manage__list">
      <article v-for="row in shown" :key="row.tempId" class="pk-task pk-card">
        <div class="pk-task__id">
          <strong>{{ row.code }}</strong>
          <span class="pk-muted">
            <template v-if="row.displayName !== row.code">{{ row.displayName }} · </template>{{ row.ownerName }}（{{ row.ownerPosition }}）
          </span>
          <span v-if="row.recycling" class="pk-muted">后期回收：{{ row.recycling }}</span>
        </div>

        <div class="pk-task__switches">
          <label class="pk-task__switch">
            <span>前期传图</span>
            <el-switch
              :model-value="!!row.stage1"
              @update:model-value="(value: boolean) => toggleStage(row, 1, value)"
            />
          </label>
          <label class="pk-task__switch">
            <span>后期传图</span>
            <el-switch
              :model-value="!!row.stage2"
              @update:model-value="(value: boolean) => toggleStage(row, 2, value)"
            />
          </label>
        </div>

        <div class="pk-task__meta">
          <span class="pk-muted">已交付 {{ row.fileCount }} 个文件</span>
          <span class="pk-muted">到期 {{ formatDate(row.expiresAt) }}</span>
          <span class="pk-chip pk-chip--ghost" :class="{ 'pk-chip--warn': row.expired }">
            {{ row.expired ? '已过期' : `剩 ${row.daysLeft} 天` }}
          </span>
        </div>

        <div class="pk-task__ops">
          <el-button text class="pk-task__go" @click="((opened = row), (drawer = true))">→</el-button>
          <el-button v-if="session.caps.adminConsole" size="small" text @click="destroy(row)">注销帐号</el-button>
        </div>
      </article>

      <p v-if="!loading && !shown.length" class="pk-muted pk-manage__empty">
        {{ rows.length ? '这一筛子下没有任务，换一枚 chip 看看。' : '手上还没有可管理的游客任务。' }}
      </p>
    </div>

    <TaskFilesDrawer :task="opened" v-model:open="drawer" />
  </section>
</template>

<style scoped>
.pk-manage__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.pk-manage__head p {
  margin: 6px 0 0;
  font-size: 12px;
}

.pk-manage__bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
}

.pk-manage__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.pk-manage__chip {
  font: inherit;
  cursor: pointer;
}

.pk-manage__chip--on {
  background: var(--pk-brand);
  border-color: var(--pk-brand);
  color: #fff;
}

.pk-manage__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  min-height: 80px;
}

.pk-task {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
}

.pk-task__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}

.pk-task__id strong {
  font-size: 14px;
  letter-spacing: 0.4px;
}

.pk-task__switches {
  display: flex;
  gap: 16px;
}

.pk-task__switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.pk-task__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}

.pk-task__ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pk-task__go {
  font-size: 18px;
}

.pk-manage__empty {
  padding: 26px 4px;
  text-align: center;
  font-size: 12px;
}

@media (max-width: 1000px) {
  .pk-task {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

@media (max-width: 640px) {
  .pk-task {
    grid-template-columns: 1fr;
  }

  .pk-manage__bar .el-select {
    width: 100%;
  }
}
</style>
