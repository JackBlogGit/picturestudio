<script setup lang="ts">
/**
 * 任务列表（手绘稿 22）：按帐户ID 查自己登记的临时账号，一行一个号，右侧两枚阶段标记 + 进入交付清单。
 * 这一页只读——勾「已完成」和注销账号是任务管理页（手绘稿 23）的事，L3 才给进；
 * 服务端按归属裁行（L2 只看自己登记的），页面不自己判断这该归谁。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { errorText } from '@/api/error';
import { listTasks } from '@/api/temp';
import type { TempTaskRow } from '@/types/api';
import { formatDate } from '@/utils/format';
import TaskFilesDrawer from '@/components/TaskFilesDrawer.vue';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();

const keyword = ref('');
const rows = ref<TempTaskRow[]>([]);
const loading = ref(false);
const opened = ref<TempTaskRow | null>(null);
const drawer = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listTasks({ keyword: keyword.value.trim() || undefined });
  } catch (err) {
    ElMessage.error(errorText(err, '任务读不出来'));
  } finally {
    loading.value = false;
  }
}

function openTask(row: TempTaskRow): void {
  opened.value = row;
  drawer.value = true;
}

onMounted(load);
</script>

<template>
  <section class="pk-tasks">
    <header class="pk-tasks__head">
      <div>
        <h1 class="pk-page-title">任务列表</h1>
        <p class="pk-muted">按帐户ID 跟一下前期、后期返图交到哪一步了。</p>
      </div>
      <div class="pk-tasks__ops">
        <el-button v-if="session.isMember" @click="router.push({ name: 'guest-register' })">开临时账号</el-button>
        <el-button v-if="session.isMember" @click="router.push({ name: 'task-manage' })">任务管理</el-button>
      </div>
    </header>

    <div class="pk-tasks__bar pk-card">
      <el-input v-model="keyword" placeholder="搜索 帐户ID / 名称 / 拍摄内容" clearable @keyup.enter="load" />
      <el-button type="primary" :loading="loading" @click="load">搜索</el-button>
    </div>

    <div v-loading="loading" class="pk-tasks__list">
      <article v-for="row in rows" :key="row.tempId" class="pk-task pk-card">
        <div class="pk-task__id">
          <strong>{{ row.code }}</strong>
          <span class="pk-muted">
            <template v-if="row.displayName !== row.code">{{ row.displayName }} · </template>归属 {{ row.ownerName }}
          </span>
          <span v-if="row.shootContent" class="pk-muted">{{ row.shootContent }}</span>
        </div>

        <div class="pk-task__stages">
          <span class="pk-chip" :class="{ 'pk-chip--warn': !row.stage1 }">前期返图 {{ row.stage1 ? '已完成' : '未完成' }}</span>
          <span class="pk-chip" :class="{ 'pk-chip--warn': !row.stage2 }">后期返图 {{ row.stage2 ? '已完成' : '未完成' }}</span>
        </div>

        <div class="pk-task__meta">
          <span class="pk-muted">已交付 {{ row.fileCount }} 个文件</span>
          <span class="pk-muted">到期 {{ formatDate(row.expiresAt) }}</span>
          <span class="pk-chip pk-chip--ghost" :class="{ 'pk-chip--warn': row.expired }">
            {{ row.expired ? '已过期' : `剩 ${row.daysLeft} 天` }}
          </span>
        </div>

        <el-button text class="pk-task__go" @click="openTask(row)">→</el-button>
      </article>

      <p v-if="!loading && !rows.length" class="pk-muted pk-tasks__empty">
        还没有登记过游客账号。注册一个之后，帐户ID 会带着它在「拍展」里的专属目录一起长出来（规则 3）。
      </p>
    </div>

    <TaskFilesDrawer :task="opened" v-model:open="drawer" />
  </section>
</template>

<style scoped>
.pk-tasks__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.pk-tasks__head p {
  margin: 6px 0 0;
  font-size: 12px;
}

.pk-tasks__ops {
  display: flex;
  gap: 8px;
}

.pk-tasks__bar {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
}

.pk-tasks__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  min-height: 80px;
}

.pk-task {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1fr) 44px;
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

.pk-task__stages,
.pk-task__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}

.pk-task__go {
  font-size: 18px;
  justify-self: end;
}

.pk-tasks__empty {
  padding: 26px 4px;
  text-align: center;
  font-size: 12px;
}

@media (max-width: 900px) {
  .pk-task {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

@media (max-width: 640px) {
  .pk-task {
    grid-template-columns: 1fr;
  }
}
</style>
