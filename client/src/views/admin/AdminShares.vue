<script setup lang="ts">
/**
 * 返图链接管理（PRD 8.2 第 6 页 / 4.4）。L3+ 看全站、L2 只看本人创建；
 * 新建入口在相册详情页，因为只有那里能选到本册的标签与 coser。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listShareLinks, revokeShareLink } from '@/api/share';
import { errorText } from '@/api/client';
import type { ShareLinkView } from '@/types/api';
import { formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();

const rows = ref<ShareLinkView[]>([]);
const loading = ref(false);
const busy = ref(false);
const onlyAlive = ref(false);
const keyword = ref('');

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return rows.value;
  const source = (l: ShareLinkView) => (l.scope === 'person' ? l.albumNames.join(' ') : l.albumName);
  return rows.value.filter((l) => `${source(l)} ${l.coserName ?? ''} ${l.shareToken}`.toLowerCase().includes(kw));
});

const aliveCount = computed(() => rows.value.filter((l) => !l.expired && l.revoked === 0).length);
const totalVisits = computed(() => rows.value.reduce((sum, l) => sum + l.visitCount, 0));

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listShareLinks({ onlyAlive: onlyAlive.value ? 1 : undefined });
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function copy(link: ShareLinkView): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
    ElMessage.success('已复制');
  } catch {
    ElMessage.warning('浏览器拦了剪贴板，请手动选中地址栏的链接');
  }
}

async function revoke(link: ShareLinkView): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    '撤销后 coser 侧立刻返回 404，且不能恢复；历史访问次数保留在审计里。',
    `撤销「${link.coserName ?? link.albumName}」的返图链接`,
    { type: 'warning', confirmButtonText: '确定撤销', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  busy.value = true;
  try {
    await revokeShareLink(link.id);
    ElMessage.success('已撤销');
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
        <h2 class="pk-page-title">返图链接</h2>
        <p class="pk-muted">
          管理员可看全站链接，撤销走同一套 404 口径以免被枚举 token。当前身份 {{ session.displayName }}。
        </p>
      </div>
      <el-button size="small" @click="load">刷新</el-button>
    </div>

    <div class="pk-admin__stats">
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">链接总数</p>
        <p class="pk-stat__value">{{ rows.length }}</p>
        <p class="pk-stat__hint">含已撤销与已过期</p>
      </article>
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">在有效期</p>
        <p class="pk-stat__value">{{ aliveCount }}</p>
        <p class="pk-stat__hint">到期自动收回</p>
      </article>
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">累计访问</p>
        <p class="pk-stat__value">{{ totalVisits }}</p>
        <p class="pk-stat__hint">每次打开计一次</p>
      </article>
    </div>

    <div class="pk-admin__toolbar">
      <el-switch v-model="onlyAlive" size="small" active-text="只看有效" @change="load" />
      <el-input
        v-model="keyword"
        size="small"
        class="pk-admin__kw"
        placeholder="相册／coser／token"
        clearable
      />
      <span class="pk-muted">要新建请到相册详情页的「生成返图链接」。</span>
    </div>

    <div class="pk-admin__table-wrap">
      <el-table v-loading="loading" :data="filtered" size="small" border>
        <el-table-column prop="id" label="ID" width="54" />
        <el-table-column label="来源相册" min-width="180">
          <template #default="{ row }">
            <router-link v-if="row.scope === 'album'" class="pk-admin__link" :to="`/albums/${row.albumId}`">
              {{ row.albumName }}
            </router-link>
          <template v-else>
            <span class="pk-chip pk-chip--ghost">跨 {{ row.albumNames.length }} 个相册</span>
            <p class="pk-muted pk-admin__albums">{{ row.albumNames.join('、') }}</p>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="Coser" width="110">
        <template #default="{ row }">{{ row.coserName ?? '整册精选' }}</template>
      </el-table-column>
      <el-table-column label="token" width="130">
        <template #default="{ row }"><span class="pk-admin__mono">{{ row.shareToken }}</span></template>
      </el-table-column>
      <el-table-column label="模式" width="82">
        <template #default="{ row }">
          <span class="pk-chip pk-chip--ghost">{{ row.snapshot === 1 ? '快照' : '实时' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="命中" width="66">
        <template #default="{ row }">{{ row.imageCount }}</template>
      </el-table-column>
      <el-table-column label="口令" width="66">
        <template #default="{ row }">
          <span class="pk-muted">{{ row.hasPassword ? '已设' : '无' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="原图" width="66">
        <template #default="{ row }">
          <span :class="['pk-chip', row.allowDownload === 1 ? 'pk-chip--warn' : 'pk-chip--ghost']">
            {{ row.allowDownload === 1 ? '开放' : '关闭' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="访问" width="62">
        <template #default="{ row }">{{ row.visitCount }}</template>
      </el-table-column>
      <el-table-column label="到期" width="126">
        <template #default="{ row }">
          <span class="pk-muted">{{ formatDate(row.expireTime) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="82">
        <template #default="{ row }">
          <span v-if="row.revoked === 1" class="pk-chip pk-chip--warn">已撤销</span>
          <span v-else-if="row.expired" class="pk-chip pk-chip--warn">已过期</span>
          <span v-else class="pk-chip pk-chip--ghost">有效</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="188" align="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="copy(row)">复制</el-button>
          <el-link class="pk-admin__open" type="primary" :underline="false" :href="row.url" target="_blank">
            打开
          </el-link>
          <el-button
            size="small"
            text
            type="danger"
            :disabled="row.revoked === 1 || row.expired"
            @click="revoke(row)"
          >
            撤销
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>
  </section>
</template>

<style scoped>
.pk-admin__kw {
  width: 200px;
}

.pk-admin__link {
  color: var(--pk-brand);
}

.pk-admin__albums {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
}

.pk-admin__open {
  font-size: 12px;
  margin: 0 6px;
}
</style>
