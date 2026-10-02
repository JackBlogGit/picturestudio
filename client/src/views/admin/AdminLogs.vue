<script setup lang="ts">
/**
 * 日志审计（PRD 8.2 第 8 页 / 12.11-12.12）。导出走的是同一套筛选条件，
 * CSV 由后端生成并转义公式前缀，前端只负责把字符串落成文件。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { exportLogs, listLogs } from '@/api/admin';
import { errorText } from '@/api/client';
import type { LogRow, LogUserType, Page } from '@/types/api';
import { formatDate } from '@/utils/format';

const rows = ref<LogRow[]>([]);
const total = ref(0);
const loading = ref(false);
const busy = ref(false);

const query = reactive({
  userType: '' as '' | LogUserType,
  action: '',
  result: undefined as 0 | 1 | undefined,
  from: '',
  to: '',
  keyword: '',
  page: 1,
  pageSize: 20,
});

const TYPES: LogUserType[] = ['user', 'temp', 'guest', 'system'];

const TYPES_LABEL: Record<string, string> = {
  user: '正式成员',
  temp: '临时账号',
  guest: '未登录',
  system: '系统',
};

/** 常用的几个动作做成快捷项，其余仍可手填 */
const ACTIONS = [
  'login',
  'login_failed',
  'logout',
  'image_upload',
  'batch_tags',
  'visibility_change',
  'share_create',
  'share_visit',
  'settings_update',
  'user_create',
  'logs_export',
];

function currentFilter(): Parameters<typeof listLogs>[0] {
  return {
    userType: query.userType || undefined,
    action: query.action || undefined,
    result: query.result,
    from: query.from || undefined,
    to: query.to || undefined,
    keyword: query.keyword || undefined,
    page: query.page,
    pageSize: query.pageSize,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const page: Page<LogRow> = await listLogs(currentFilter());
    rows.value = page.list;
    total.value = page.total;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

function reset(): void {
  query.page = 1;
  void load();
}

async function doExport(): Promise<void> {
  busy.value = true;
  try {
    const result = await exportLogs({ ...currentFilter(), page: 1, pageSize: 200 });
    // 真接口回的是文件流，这里把 mock 的字符串按同一口径落成文件
    const blob = new Blob(['\uFEFF' + result.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
    ElMessage.success(`已导出 ${result.filename}（最多 200 行）`);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">日志审计</h2>
        <p class="pk-muted">
          写操作与失败尝试都会落表；详情列绝不含密码与令牌全文。导出走同一组筛选条件，CSV 里以
          <span class="pk-admin__mono">= + - @</span>
          开头的单元格会被转义，防止公式注入。
        </p>
      </div>
      <div class="pk-admin__inline">
        <el-button size="small" @click="load">刷新</el-button>
        <el-button size="small" type="primary" :loading="busy" @click="doExport">导出 CSV</el-button>
      </div>
    </div>

    <div class="pk-admin__toolbar">
      <el-select v-model="query.userType" size="small" class="pk-admin__sel" placeholder="全部身份" clearable @change="reset">
        <el-option v-for="t in TYPES" :key="t" :value="t" :label="TYPES_LABEL[t]" />
      </el-select>
      <el-select
        v-model="query.action"
        size="small"
        class="pk-admin__action"
        placeholder="全部动作"
        clearable
        filterable
        allow-create
        @change="reset"
      >
        <el-option v-for="a in ACTIONS" :key="a" :value="a" :label="a" />
      </el-select>
      <el-select v-model="query.result" size="small" class="pk-admin__sel" placeholder="全部结果" clearable @change="reset">
        <el-option :value="1" label="成功" />
        <el-option :value="0" label="被拒" />
      </el-select>
      <el-date-picker
        v-model="query.from"
        type="date"
        size="small"
        value-format="YYYY-MM-DD"
        placeholder="起始日"
        class="pk-admin__date"
        @change="reset"
      />
      <el-date-picker
        v-model="query.to"
        type="date"
        size="small"
        value-format="YYYY-MM-DD"
        placeholder="截止日"
        class="pk-admin__date"
        @change="reset"
      />
      <el-input
        v-model="query.keyword"
        size="small"
        class="pk-admin__kw"
        placeholder="详情／目标／IP"
        clearable
        @keyup.enter="reset"
        @clear="reset"
      />
      <el-button size="small" @click="load">查询</el-button>
      <span class="pk-muted">共 {{ total }} 条</span>
    </div>

    <div class="pk-admin__table-wrap">
      <el-table v-loading="loading" :data="rows" size="small" border>
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column label="时间" width="132">
          <template #default="{ row }"><span class="pk-muted">{{ formatDate(row.createTime) }}</span></template>
        </el-table-column>
        <el-table-column label="身份" width="78">
          <template #default="{ row }">
          <span class="pk-chip pk-chip--ghost">{{ TYPES_LABEL[row.userType] }}</span>
        </template>
      </el-table-column>
      <el-table-column label="账号" width="88">
        <template #default="{ row }">
          <span class="pk-muted pk-admin__mono">
            {{ row.uid !== null ? `#${row.uid}` : row.tempId !== null ? `T${row.tempId}` : '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="action" label="动作" width="150" />
      <el-table-column label="目标" width="130">
        <template #default="{ row }">
          <span class="pk-muted">{{ row.targetType }}{{ row.targetId !== null ? ` #${row.targetId}` : '' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="detail" label="详情" min-width="260" show-overflow-tooltip />
      <el-table-column prop="ip" label="IP" width="118">
        <template #default="{ row }"><span class="pk-admin__mono">{{ row.ip }}</span></template>
      </el-table-column>
      <el-table-column label="结果" width="76">
        <template #default="{ row }">
          <span :class="['pk-chip', row.result === 1 ? 'pk-chip--ghost' : 'pk-chip--warn']">
            {{ row.result === 1 ? '成功' : '拒绝' }}
          </span>
        </template>
      </el-table-column>
    </el-table>
    </div>

    <el-pagination
      class="pk-admin__pager"
      layout="prev, pager, next, sizes, total"
      :total="total"
      :page-size="query.pageSize"
      :current-page="query.page"
      :page-sizes="[20, 50, 100, 200]"
      @current-change="(p: number) => ((query.page = p), void load())"
      @size-change="
        (size: number) => {
          query.pageSize = size;
          reset();
        }
      "
    />
  </section>
</template>

<style scoped>
.pk-admin__sel {
  width: 116px;
}

.pk-admin__action {
  width: 156px;
}

.pk-admin__date {
  width: 138px;
}

.pk-admin__kw {
  width: 190px;
}
</style>
