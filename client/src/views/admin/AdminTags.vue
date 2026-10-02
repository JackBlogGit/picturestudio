<script setup lang="ts">
/**
 * 标签库（PRD 8.2 第 4 页 / 4.6）。列表按使用频次排序，冗余标签靠它清理；
 * 合并只允许同类型，跨类型会毁掉筛选语义，后端直接 409。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { createTag, deleteTag, listTags, mergeTag, renameTag } from '@/api/admin';
import { errorText } from '@/api/client';
import type { AdminTagRow, TagType } from '@/types/api';
import { TAG_TYPE_LABEL } from '@/types/api';

const rows = ref<AdminTagRow[]>([]);
const loading = ref(false);
const busy = ref(false);
const query = reactive({ type: '' as '' | TagType, keyword: '' });

const form = reactive({ open: false, type: 'coser' as TagType, name: '' });

const mergeState = reactive({ open: false, fromId: 0, toId: undefined as number | undefined });

const TYPES = Object.keys(TAG_TYPE_LABEL) as TagType[];

const mergeCandidates = computed(() => {
  const from = rows.value.find((t) => t.id === mergeState.fromId);
  if (!from) return [];
  return rows.value.filter((t) => t.type === from.type && t.id !== from.id);
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listTags({ type: query.type || undefined, keyword: query.keyword || undefined });
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function submitCreate(): Promise<void> {
  busy.value = true;
  try {
    await createTag({ type: form.type, name: form.name });
    ElMessage.success('标签已创建');
    form.open = false;
    form.name = '';
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

async function doRename(row: AdminTagRow): Promise<void> {
  const input = await ElMessageBox.prompt(`「${row.name}」当前挂在 ${row.useCount} 张图上`, '改名', {
    inputValue: row.name,
    confirmButtonText: '保存',
    cancelButtonText: '取消',
  }).catch(() => null);
  if (!input) return;
  busy.value = true;
  try {
    await renameTag(row.id, input.value);
    ElMessage.success('已改名，引用处同步生效');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

function openMerge(row: AdminTagRow): void {
  mergeState.fromId = row.id;
  mergeState.toId = undefined;
  mergeState.open = true;
}

async function submitMerge(): Promise<void> {
  if (!mergeState.toId) {
    ElMessage.warning('请选择合并到哪个标签');
    return;
  }
  const from = rows.value.find((t) => t.id === mergeState.fromId);
  busy.value = true;
  try {
    const result = await mergeTag(mergeState.fromId, mergeState.toId);
    ElMessage.success(`「${from?.name}」的 ${result.moved} 张引用已迁走，源标签已删除`);
    mergeState.open = false;
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

async function remove(row: AdminTagRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    row.useCount
      ? `「${row.name}」还挂在 ${row.useCount} 张图上，删除会一并解除引用`
      : `删除未被使用的「${row.name}」`,
    '删除标签',
    { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  busy.value = true;
  try {
    const result = await deleteTag(row.id);
    ElMessage.success(`已删除，解除 ${result.cleaned} 张图的引用`);
    await load();
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
        <h2 class="pk-page-title">标签库</h2>
        <p class="pk-muted">
          五种类型：{{ TYPES.map((t) => TAG_TYPE_LABEL[t]).join('／') }}。输入即建的去重在上传侧做，这里负责收敛与合并。
        </p>
      </div>
      <el-button type="primary" size="small" @click="form.open = true">新建标签</el-button>
    </div>

    <div class="pk-admin__toolbar">
      <el-select v-model="query.type" size="small" class="pk-admin__sel" placeholder="全部类型" clearable @change="load">
        <el-option v-for="t in TYPES" :key="t" :value="t" :label="TAG_TYPE_LABEL[t]" />
      </el-select>
      <el-input
        v-model="query.keyword"
        size="small"
        class="pk-admin__kw"
        placeholder="标签名"
        clearable
        @keyup.enter="load"
        @clear="load"
      />
      <el-button size="small" @click="load">查询</el-button>
      <span class="pk-muted">按使用频次倒序，0 次的是清理候选。</span>
    </div>

    <div class="pk-admin__table-wrap">
      <el-table v-loading="loading" :data="rows" size="small" border>
        <el-table-column prop="id" label="ID" width="58" />
        <el-table-column prop="name" label="标签" min-width="170" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <span :class="['pk-chip', row.type === 'status' ? 'pk-chip--warn' : 'pk-chip--ghost']">
              {{ TAG_TYPE_LABEL[row.type as TagType] }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="useCount" label="使用次数" width="92" />
      <el-table-column label="操作" width="210" align="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="doRename(row)">改名</el-button>
          <el-button size="small" text @click="openMerge(row)">合并到…</el-button>
          <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>

    <el-dialog v-model="form.open" title="新建标签" width="min(420px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="类型">
          <el-select v-model="form.type" class="pk-admin__wide">
            <el-option v-for="t in TYPES" :key="t" :value="t" :label="TAG_TYPE_LABEL[t]" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签名">
          <el-input v-model="form.name" maxlength="30" placeholder="同类型下不可重复" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="form.open = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeState.open" title="合并标签" width="min(440px, 94vw)">
      <p class="pk-muted pk-admin__hint">
        把源标签的图片引用整体迁到目标标签，源标签随后删除；只允许同类型。
      </p>
      <el-form label-position="top">
        <el-form-item label="源标签">
          <el-input
            readonly
            :model-value="rows.find((t) => t.id === mergeState.fromId)?.name ?? ''"
          />
        </el-form-item>
        <el-form-item label="合并到">
          <el-select v-model="mergeState.toId" class="pk-admin__wide" filterable placeholder="选择同类型的目标标签">
            <el-option
              v-for="t in mergeCandidates"
              :key="t.id"
              :value="t.id"
              :label="`${t.name}（${t.useCount} 次）`"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mergeState.open = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitMerge">确定合并</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-admin__sel {
  width: 122px;
}

.pk-admin__kw {
  width: 180px;
}

.pk-admin__hint {
  font-size: 12px;
  line-height: 1.7;
  margin: 0 0 10px;
}
</style>
