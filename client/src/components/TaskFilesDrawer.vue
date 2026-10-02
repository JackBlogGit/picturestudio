<script setup lang="ts">
/**
 * 任务页的「查看交付」抽屉（手绘稿 22、23 行尾的 →）。
 * 帐户 ID 目录整棵挂在隐藏的「拍展」子树下，网盘列表看不见它（规则 3），
 * 所以这里直接按目录 id 拉文件清单，而不是把用户丢进一个找不到入口的网盘页。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { errorText } from '@/api/error';
import { listFiles } from '@/api/drive';
import type { FileView, TempTaskRow } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';

const props = defineProps<{ task: TempTaskRow | null; open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

const files = ref<FileView[]>([]);
const loading = ref(false);

const totalBytes = computed(() => files.value.reduce((sum, f) => sum + f.fileSize, 0));

async function load(task: TempTaskRow): Promise<void> {
  loading.value = true;
  try {
    // deep=1：子目录里的交付也算进来，只勾平铺那一层会漏
    const page = await listFiles({ folder: task.taskFolderId, deep: 1, pageSize: 200 });
    files.value = page.list;
  } catch (err) {
    files.value = [];
    ElMessage.error(errorText(err, '读不到这个目录'));
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.task?.tempId] as const,
  ([isOpen, tempId]) => {
    if (isOpen && props.task && tempId) void load(props.task);
  },
  { immediate: true },
);

const uploader = (file: FileView): string =>
  file.uploadTempId ? `游客 #${file.uploadTempId}` : `成员 #${file.uploadUid ?? '-'}`;
</script>

<template>
  <el-drawer
    :model-value="open"
    size="480px"
    :title="task ? `拍展／${task.taskFolderName} 的交付` : '交付清单'"
    @update:model-value="emit('update:open', $event)"
  >
    <div v-loading="loading" class="pk-task-files">
      <p class="pk-muted">
        共 {{ files.length }} 个文件 · {{ formatBytes(totalBytes) }} · 已用配额
        {{ task ? formatBytes(task.usedSpace) : '-' }} / {{ task ? formatBytes(task.spaceQuota) : '-' }}
      </p>
      <ul v-if="files.length" class="pk-task-files__list">
        <li v-for="file in files" :key="file.id">
          <div class="pk-task-files__name">{{ file.filename }}</div>
          <div class="pk-muted">
            {{ formatBytes(file.fileSize) }} · {{ formatDate(file.createTime) }} · {{ uploader(file) }}
          </div>
        </li>
      </ul>
      <p v-else-if="!loading" class="pk-muted">这个目录还是空的，对方一张都还没传。</p>
    </div>
  </el-drawer>
</template>

<style scoped>
.pk-task-files__list {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.pk-task-files__list li {
  padding: 9px 0;
  border-bottom: 1px dashed var(--pk-line);
  font-size: 12px;
  line-height: 1.6;
}

.pk-task-files__name {
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
}
</style>
