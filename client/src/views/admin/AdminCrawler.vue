<script setup lang="ts">
/**
 * 站外来源登记（PRD 8.2 第 9 页 / 10.8，D28）。整页只对 L4 超管开放，路由与导航按等级收口。
 * 这一页只做一件事：把「谁在别处转了我们的返图」记成一条可跟进的台账——
 * 检索取回候选、手敲登记自己发现的，两条路都只落链接，不下载任何文件字节（第 18 章的版权约束）。
 *
 * 地址闸门（非法协议 / 内网 / 非常规端口 / 跟踪参数）在服务端做，前端不复算一遍：
 * 页面只负责把接口回的错误码位原样显示出来，重复登记带着已存在的 id 一起回显。
 *
 * D34：登记／改状态／删除都是后台改动，提交前要先过身份再验证；检索与读取标题只是查询，不拦。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  SEARCH_LIMITS,
  createCrawlerLink,
  deleteCrawlerLink,
  listCrawlerLinks,
  probeCrawler,
  searchCrawler,
  updateCrawlerLinkStatus,
} from '@/api/crawler';
import { errorText, isApiError } from '@/api/client';
import { askReauth, endReauth } from '@/utils/reauth';
import type {
  CrawlerLinkStatus,
  CrawlerLinkView,
  CrawlerPlatform,
  CrawlerProbeResult,
  CrawlerSearchHitView,
  CrawlerSearchResult,
} from '@/types/api';
import {
  CRAWLER_PLATFORMS,
  CRAWLER_PLATFORM_LABEL,
  CRAWLER_STATUSES,
  CRAWLER_STATUS_LABEL,
  CRAWLER_STATUS_TONE,
} from '@/types/api';
import { formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();

// ---------------- 检索 ----------------

const keyword = ref('');
const limit = ref(SEARCH_LIMITS.fallback);
const searching = ref(false);
const result = ref<CrawlerSearchResult | null>(null);

async function runSearch(): Promise<void> {
  const kw = keyword.value.trim();
  if (kw.length < 2) {
    ElMessage.warning('检索词至少 2 个字符');
    return;
  }
  searching.value = true;
  try {
    result.value = await searchCrawler(kw, limit.value);
    if (!result.value.hits.length) ElMessage.info('这次检索没有可用结果');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    searching.value = false;
  }
}

/** 结果行上直接登记：标题与摘要取检索带回的那一份，省得超管再抄一遍 */
async function registerHit(hit: CrawlerSearchHitView): Promise<void> {
  if (!(await askReauth(`登记站外来源「${hit.title || hit.url}」`))) return;
  try {
    const row = await createCrawlerLink({
      url: hit.url,
      title: hit.title,
      snippet: hit.snippet,
      keyword: result.value?.keyword ?? '',
    });
    ElMessage.success('已登记，状态从「待确认」开始');
    hit.registered = true;
    hit.linkId = row.id;
    await load();
  } catch (err) {
    ElMessage.error(existsNotice(err));
    if (isApiError(err) && err.code === 'LINK_EXISTS') await load();
  } finally {
    endReauth();
  }
}

// ---------------- 手敲登记 ----------------

const manual = reactive({ url: '', title: '', snippet: '' });
const probing = ref(false);
const registering = ref(false);
const probed = ref<CrawlerProbeResult | null>(null);

/** 手动登记卡片每次都是空白起步，「重置」即回到空白并丢掉读到的标题 */
function resetManual(): void {
  manual.url = '';
  manual.title = '';
  manual.snippet = '';
  probed.value = null;
}

async function runProbe(): Promise<void> {
  if (!manual.url.trim()) {
    ElMessage.warning('先把地址贴进来');
    return;
  }
  probing.value = true;
  try {
    probed.value = await probeCrawler(manual.url);
    manual.url = probed.value.url;
    if (probed.value.title) manual.title = probed.value.title;
    if (probed.value.description) manual.snippet = probed.value.description;
    if (probed.value.registered) ElMessage.warning(`这条已经在登记表里（#${probed.value.linkId}）`);
  } catch (err) {
    probed.value = null;
    ElMessage.error(errorText(err));
  } finally {
    probing.value = false;
  }
}

async function registerManual(): Promise<void> {
  if (!manual.url.trim()) {
    ElMessage.warning('先把地址贴进来');
    return;
  }
  if (!(await askReauth('手动登记一条站外来源'))) return;
  registering.value = true;
  try {
    const row = await createCrawlerLink({ url: manual.url, title: manual.title, snippet: manual.snippet });
    ElMessage.success(`已登记 #${row.id}`);
    resetManual();
    await load();
  } catch (err) {
    ElMessage.error(existsNotice(err));
    if (isApiError(err) && err.code === 'LINK_EXISTS') await load();
  } finally {
    registering.value = false;
    endReauth();
  }
}

/** 409 的 data 里带已存在那条的 id 与状态，直接拼进提示，省得回列表里翻 */
function existsNotice(err: unknown): string {
  if (!isApiError(err) || err.code !== 'LINK_EXISTS') return errorText(err);
  const data = err.data as { id?: number; status?: CrawlerLinkStatus } | null;
  if (!data?.id) return err.message;
  const status = data.status === undefined ? '' : ` · ${CRAWLER_STATUS_LABEL[data.status]}`;
  return `${err.message}：#${data.id}${status}`;
}

// ---------------- 登记表 ----------------

const rows = ref<CrawlerLinkView[]>([]);
const total = ref(0);
const loading = ref(false);
const query = reactive({
  status: '' as CrawlerLinkStatus | '',
  platform: '' as CrawlerPlatform | '',
  q: '',
  page: 1,
  pageSize: 20,
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const page = await listCrawlerLinks({
      status: query.status === '' ? undefined : query.status,
      platform: query.platform === '' ? undefined : query.platform,
      q: query.q.trim() || undefined,
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

function reload(): void {
  query.page = 1;
  void load();
}

const pendingCount = computed(() => rows.value.filter((row) => row.status === 0).length);

const dialog = reactive({ open: false, row: null as CrawlerLinkView | null, status: 0 as CrawlerLinkStatus, note: '' });
const saving = ref(false);

function openStatus(row: CrawlerLinkView): void {
  dialog.row = row;
  dialog.status = row.status;
  dialog.note = row.note;
  dialog.open = true;
}

/** 改乱了直接回到打开弹窗时那条记录的原值 */
function resetStatus(): void {
  if (!dialog.row) return;
  dialog.status = dialog.row.status;
  dialog.note = dialog.row.note;
}

async function saveStatus(): Promise<void> {
  if (!dialog.row) return;
  if (!(await askReauth(`改「${dialog.row.title || dialog.row.domain}」的处置状态`))) return;
  saving.value = true;
  try {
    await updateCrawlerLinkStatus(dialog.row.id, { status: dialog.status, note: dialog.note });
    ElMessage.success('状态已更新');
    dialog.open = false;
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
    endReauth();
  }
}

async function removeRow(row: CrawlerLinkView): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    '只删这条登记记录，不触碰站外原帖；删完历史无法在页面上找回，审计日志里仍留着一次 crawler_link_removed。',
    `删除 #${row.id} ${row.title || row.domain}`,
    { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  if (!(await askReauth(`删除站外来源 #${row.id}`))) return;
  try {
    await deleteCrawlerLink(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    endReauth();
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">站外来源登记</h2>
        <p class="pk-muted">
          只登记链接与处置状态，服务器不下载任何文件字节。当前身份 {{ session.displayName }}，仅 L4 超管可操作；
          登记、改状态、删除提交前都要填一次当前账号的登录口令（PRD 6.1 / D34），检索与读取标题属于查询，不拦。
        </p>
      </div>
      <el-button size="small" @click="load">刷新</el-button>
    </div>

    <div class="pk-admin__stats">
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">登记总数</p>
        <p class="pk-stat__value">{{ total }}</p>
        <p class="pk-stat__hint">按当前筛选条件计数</p>
      </article>
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">本页待确认</p>
        <p class="pk-stat__value">{{ pendingCount }}</p>
        <p class="pk-stat__hint">还没人跟进的条目</p>
      </article>
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">单次检索上限</p>
        <p class="pk-stat__value">{{ SEARCH_LIMITS.max }}</p>
        <p class="pk-stat__hint">捞太多只会带回无关转载</p>
      </article>
    </div>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">检索候选来源</h3>
      <div class="pk-admin__inline">
        <el-input
          v-model="keyword"
          size="small"
          class="pk-crawler__kw"
          placeholder="作品名 / 社团名 / 关键词"
          clearable
          @keyup.enter="runSearch"
        />
        <el-input-number v-model="limit" size="small" :min="SEARCH_LIMITS.min" :max="SEARCH_LIMITS.max" controls-position="right" />
        <el-button size="small" type="primary" :loading="searching" @click="runSearch">检索</el-button>
        <span v-if="result" class="pk-muted">
          采集 {{ result.fetched }} 条，闸门丢弃 {{ result.dropped }} 条，命中 {{ result.hits.length }} 条
        </span>
      </div>

      <el-alert
        v-if="result && result.dropped"
        class="pk-crawler__alert"
        type="info"
        :closable="false"
        show-icon
        title="被丢弃的条目指向内网、非常规端口或非 http(s) 地址，服务器不会访问，也不会落库"
      />

      <div v-if="result" class="pk-admin__table-wrap pk-crawler__hits">
        <el-table :data="result.hits" size="small" border>
          <el-table-column label="标题 / 摘要" min-width="260">
            <template #default="{ row }">
              <el-link type="primary" underline="never" :href="row.url" target="_blank" rel="noopener noreferrer">
                {{ row.title || row.url }}
              </el-link>
              <p class="pk-muted pk-crawler__snippet">{{ row.snippet }}</p>
            </template>
          </el-table-column>
          <el-table-column label="站点" width="130">
            <template #default="{ row }">
              <span class="pk-admin__mono">{{ row.domain }}</span>
            </template>
          </el-table-column>
          <el-table-column label="平台" width="92">
            <template #default="{ row }">
              <span class="pk-chip pk-chip--ghost">{{ CRAWLER_PLATFORM_LABEL[row.platform as CrawlerPlatform] }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="122" align="right">
            <template #default="{ row }">
              <span v-if="row.registered" class="pk-muted">已登记 #{{ row.linkId }}</span>
              <el-button v-else size="small" text type="primary" @click="registerHit(row)">登记</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </article>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">手动登记一条</h3>
      <div class="pk-admin__inline">
        <el-input v-model="manual.url" size="small" class="pk-crawler__url" placeholder="粘贴完整链接（http / https，默认端口）" clearable />
        <el-button size="small" :loading="probing" @click="runProbe">读取标题</el-button>
      </div>
      <p v-if="probed" class="pk-muted pk-crawler__probed">
        规范化后 {{ probed.url }} · {{ CRAWLER_PLATFORM_LABEL[probed.platform] }}
        <template v-if="probed.registered">· 这条已在登记表里（#{{ probed.linkId }}）</template>
        <template v-else-if="!probed.description">· 页面摘要没读到，标题与摘要自己填</template>
      </p>
      <div class="pk-admin__inline pk-crawler__form">
        <el-input v-model="manual.title" size="small" class="pk-crawler__url" maxlength="255" placeholder="标题（选填）" />
        <el-input v-model="manual.snippet" size="small" class="pk-admin__wide" maxlength="500" placeholder="摘要 / 备注（选填）" />
        <el-button size="small" @click="resetManual">重置</el-button>
        <el-button size="small" type="primary" :loading="registering" @click="registerManual">登记</el-button>
      </div>
      <p class="pk-muted pk-crawler__hint">
        手动登记不带检索词，来源一律记为「手敲」；带关键词进来的才记「检索」。
      </p>
    </article>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">登记表</h3>
      <div class="pk-admin__toolbar">
        <el-select v-model="query.status" size="small" class="pk-crawler__filter" placeholder="全部状态" clearable @change="reload">
          <el-option v-for="s in CRAWLER_STATUSES" :key="s" :value="s" :label="CRAWLER_STATUS_LABEL[s]" />
        </el-select>
        <el-select v-model="query.platform" size="small" class="pk-crawler__filter" placeholder="全部平台" clearable @change="reload">
          <el-option v-for="p in CRAWLER_PLATFORMS" :key="p" :value="p" :label="CRAWLER_PLATFORM_LABEL[p]" />
        </el-select>
        <el-input
          v-model="query.q"
          size="small"
          class="pk-crawler__filter"
          placeholder="标题 / 域名 / 地址"
          clearable
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-button size="small" @click="reload">查询</el-button>
      </div>

      <div class="pk-admin__table-wrap pk-crawler__links">
        <el-table v-loading="loading" :data="rows" size="small" border>
          <el-table-column prop="id" label="ID" width="54" />
          <el-table-column label="来源" min-width="220">
            <template #default="{ row }">
              <el-link type="primary" underline="never" :href="row.url" target="_blank" rel="noopener noreferrer">
                {{ row.title || row.url }}
              </el-link>
              <p class="pk-admin__mono pk-muted">{{ row.url }}</p>
            </template>
          </el-table-column>
          <el-table-column label="平台" width="92">
            <template #default="{ row }">
              <span class="pk-chip pk-chip--ghost">{{ CRAWLER_PLATFORM_LABEL[row.platform as CrawlerPlatform] }}</span>
            </template>
          </el-table-column>
          <el-table-column label="检索词" width="110">
            <template #default="{ row }">
              <span class="pk-muted">{{ row.keyword || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="来源方式" width="82">
            <template #default="{ row }">
              <span class="pk-muted">{{ row.source === 'search' ? '检索' : '手敲' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="104">
            <template #default="{ row }">
              <span :class="['pk-chip', `pk-chip--${CRAWLER_STATUS_TONE[row.status as CrawlerLinkStatus]}`]">
                {{ CRAWLER_STATUS_LABEL[row.status as CrawlerLinkStatus] }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="处置备注" min-width="180">
            <template #default="{ row }">
              <span class="pk-muted">{{ row.note || '—' }}</span>
              <p v-if="row.auditUid" class="pk-muted pk-crawler__audit">
                由 uid {{ row.auditUid }} 于 {{ formatDate(row.auditTime) }} 盖章
              </p>
            </template>
          </el-table-column>
          <el-table-column label="登记时间" width="122">
            <template #default="{ row }">
              <span class="pk-muted">{{ formatDate(row.createTime) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="128" align="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="openStatus(row)">改状态</el-button>
              <el-button size="small" text type="danger" @click="removeRow(row)">删除</el-button>
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
        :page-sizes="[20, 50, 100]"
        @current-change="(p: number) => { query.page = p; void load(); }"
        @size-change="(s: number) => { query.pageSize = s; reload(); }"
      />
    </article>

    <el-dialog v-model="dialog.open" title="处置状态" width="420px">
      <p class="pk-muted pk-crawler__dialog-url">{{ dialog.row?.url }}</p>
      <el-select v-model="dialog.status" size="small" class="pk-admin__wide">
        <el-option v-for="s in CRAWLER_STATUSES" :key="s" :value="s" :label="CRAWLER_STATUS_LABEL[s]" />
      </el-select>
      <el-input
        v-model="dialog.note"
        class="pk-admin__wide pk-crawler__note"
        type="textarea"
        :rows="3"
        maxlength="500"
        show-word-limit
        placeholder="处置备注（谁联系的平台、工单号、判定无关的理由…）"
      />
      <p class="pk-muted pk-crawler__hint">落库同时盖章审计人与时间，审计里留一条 crawler_link_status（旧状态 → 新状态）；保存前要先填当前账号的登录口令。</p>
      <template #footer>
        <el-button size="small" @click="dialog.open = false">取消</el-button>
        <el-button size="small" @click="resetStatus">重置</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="saveStatus">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-crawler__kw {
  width: 260px;
}

.pk-crawler__url {
  width: 380px;
}

.pk-crawler__filter {
  width: 150px;
}

.pk-crawler__form {
  margin-top: 10px;
}

.pk-crawler__snippet {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
}

.pk-crawler__probed {
  margin: 8px 0 0;
  font-size: 12px;
}

.pk-crawler__hint {
  margin: 8px 0 0;
  font-size: 12px;
}

.pk-crawler__alert {
  margin-top: 10px;
}

.pk-crawler__audit {
  margin: 2px 0 0;
  font-size: 11px;
}

.pk-crawler__dialog-url {
  margin: 0 0 10px;
  font-size: 12px;
  word-break: break-all;
}

.pk-crawler__note {
  margin-top: 10px;
}

@media (max-width: 768px) {
  .pk-crawler__kw,
  .pk-crawler__url,
  .pk-crawler__filter {
    width: 100%;
  }
}
</style>
