<script setup lang="ts">
/**
 * 相册 + 拍展传图 合一页（drive?tab=upload 模式的复用）：
 * 默认标签是相册列表，正式成员额外多一个「拍展传图」标签。
 * 标签态挂在查询串 ?tab=xxx 上，刷新与前进后退都能回到原标签，
 * 深链 /albums?tab=upload 与 /albums?tab=upload&album=5 都有效。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import AlbumCard from '@/components/AlbumCard.vue';
import ShootUploadView from './ShootUploadView.vue';
import { errorText } from '@/api/client';
import { listAlbums, type AlbumRow } from '@/api/albums';
import { ALBUM_STATUS_LABEL, STAGE_LABEL } from '@/types/api';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

type TabName = 'list' | 'upload';

/**
 * TABS 必须是 computed——能力位随 profile 异步恢复，首帧时可能还是空，
 * session 恢复后 tab 栏要能跟着出现。
 */
const TABS = computed(() => [
  { name: 'list' as TabName, label: '相册' },
  // 传图入口认的是 caps.upload，而这一位只属于正式成员（D27：临时账号只能取图）
  // 与入口页那一格、路由守卫同源；超管按人关掉这一位时，标签与深链一起消失
  ...(session.caps.upload ? [{ name: 'upload' as TabName, label: '拍展传图' }] : []),
]);

const rows = ref<AlbumRow[]>([]);
const total = ref(0);
const loading = ref(false);
const query = reactive({
  keyword: '',
  status: undefined as number | undefined,
  includeArchived: false,
  stage: 'all' as 'all' | 'pre' | 'post',
  page: 1,
  pageSize: 12,
});

function tabFromQuery(): TabName {
  const raw = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab;
  return TABS.value.some((item) => item.name === raw) ? (raw as TabName) : 'list';
}

const tab = ref<TabName>(tabFromQuery());

function selectTab(next: TabName): void {
  tab.value = next;
  const q: Record<string, string> = {};
  for (const [key, value] of Object.entries(route.query)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (key !== 'tab' && single !== null && single !== undefined) q[key] = single;
  }
  if (next !== 'list') q.tab = next;
  void router.replace({ query: q });
}

// 路由查询串变化时同步 tab
watch(
  () => route.query.tab,
  () => {
    tab.value = tabFromQuery();
  },
);

// session 恢复后 tab 栏从 1 格变 2 格时，重新校验 tab 合法性（竞态修复）
watch(TABS, () => {
  tab.value = tabFromQuery();
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const page = await listAlbums({
      keyword: query.keyword || undefined,
      status: query.status,
      includeArchived: query.includeArchived ? 'true' : undefined,
      stage: query.stage === 'all' ? undefined : query.stage,
      page: query.page,
      pageSize: query.pageSize,
    });
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

onMounted(load);
watch(() => [query.page, query.includeArchived, query.status, query.stage], load);
</script>

<template>
  <section class="pk-albums">
    <!-- tab 栏：正式成员才有两个 tab，游客/临时账号只看相册列表 -->
    <div v-if="TABS.length > 1" class="pk-tabs">
      <button
        v-for="item in TABS"
        :key="item.name"
        type="button"
        class="pk-tab"
        :class="{ 'is-active': tab === item.name }"
        @click="selectTab(item.name)"
      >
        {{ item.label }}
      </button>
    </div>

    <!-- 相册列表 tab -->
    <div v-show="tab === 'list'" v-loading="loading">
      <div class="pk-section__head">
        <div>
          <h2 class="pk-page-title">相册</h2>
          <p class="pk-muted">按漫展日期倒序，共 {{ total }} 组。当前身份：{{ session.displayName }}</p>
        </div>
        <div class="pk-filters">
          <el-radio-group v-model="query.stage" size="default" @change="reset">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="pre">前期</el-radio-button>
            <el-radio-button value="post">后期</el-radio-button>
          </el-radio-group>
          <el-input v-model="query.keyword" placeholder="搜相册名或漫展" clearable size="default" @change="reset" />
          <el-select v-model="query.status" placeholder="状态" clearable size="default" @change="reset">
            <el-option v-for="(label, value) in ALBUM_STATUS_LABEL" :key="value" :label="label" :value="Number(value)" />
          </el-select>
          <el-tooltip v-if="session.isMember" content="成员可以显式带出归档相册" placement="top">
            <el-switch v-model="query.includeArchived" active-text="含归档" @change="reset" />
          </el-tooltip>
        </div>
      </div>

      <div v-if="rows.length" class="pk-masonry">
        <AlbumCard v-for="album in rows" :key="album.id" :album="album" :images-count="album.imagesCount" />
      </div>
      <el-empty v-else-if="!loading" description="这个身份下没有可见相册" />

      <el-pagination
        v-if="total > query.pageSize"
        class="pk-pager"
        layout="prev, pager, next"
        :total="total"
        :page-size="query.pageSize"
        :current-page="query.page"
        @current-change="(p: number) => (query.page = p)"
      />
    </div>

    <!-- 拍展传图 tab：复用原 ShootUploadView，它自己会读 route.query.album 做预选 -->
    <!-- v-if 按身份挂/卸（D27：临时账号与游客连隐藏面板都不该有），v-show 保住成员切 tab 时的队列 -->
    <ShootUploadView v-if="session.caps.upload" v-show="tab === 'upload'" />
  </section>
</template>

<style scoped>
.pk-tabs {
  display: flex;
  gap: 4px;
  margin: 0 0 14px;
  border-bottom: 1px solid var(--pk-line);
}

.pk-tab {
  border: 0;
  background: none;
  padding: 8px 14px;
  font-size: 14px;
  color: var(--pk-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.pk-tab.is-active {
  color: var(--pk-brand);
  border-bottom-color: var(--pk-brand);
  font-weight: 600;
}

.pk-filters {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.pk-filters :deep(.el-input) {
  width: 220px;
}

.pk-filters :deep(.el-select) {
  width: 130px;
}

.pk-pager {
  margin-top: 20px;
  justify-content: center;
}

@media (max-width: 820px) {
  .pk-section__head {
    display: block;
  }

  .pk-filters {
    margin-top: 12px;
  }

  .pk-filters :deep(.el-input) {
    width: 100%;
  }
}

.pk-muted {
  margin: 2px 0 0;
  font-size: 13px;
}
</style>
