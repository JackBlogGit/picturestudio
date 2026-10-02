<script setup lang="ts">
/**
 * 网盘管理（PRD 8.2 第 5 页 + 网盘 12 条规则）。这里是只读视角的总览：目录用途分布、
 * 四档文件权限门槛、上传白名单／黑名单与配额水位；真正增删文件仍在前台 /drive，避免两套写入口。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { listSettings, listTemps } from '@/api/admin';
import { driveTree, listFiles } from '@/api/drive';
import { errorText } from '@/api/client';
import type { AdminSettingRow, AdminTempRow, FileView, FolderKind, FolderNode, Visibility } from '@/types/api';
import { FOLDER_KIND_LABEL, LEVEL_LABEL, VISIBILITY_LABEL } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';

const folders = ref<FolderNode[]>([]);
const bigFiles = ref<FileView[]>([]);
const fileTotal = ref(0);
const settings = ref<AdminSettingRow[]>([]);
const temps = ref<AdminTempRow[]>([]);
const loading = ref(false);

function flatten(nodes: FolderNode[], out: FolderNode[] = []): FolderNode[] {
  for (const node of nodes) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

const flatFolders = computed(() => flatten(folders.value));

const totalBytes = computed(() => bigFiles.value.reduce((sum, f) => sum + f.fileSize, 0));

/** 目录用途是网盘权限的判定依据，分布按用途看比按展示档位看更有意义 */
const kindBuckets = computed(() => {
  const map = new Map<FolderKind, number>();
  for (const node of flatFolders.value) map.set(node.kind, (map.get(node.kind) ?? 0) + 1);
  return [...map.entries()].map(([kind, count]) => ({ kind, count }));
});

/** 被临时账号授权过的目录，管理员要能一眼看出外发面 */
const sharedFolders = computed(() => {
  const map = new Map<number, string[]>();
  for (const temp of temps.value) {
    for (const id of temp.folderIds) {
      map.set(id, [...(map.get(id) ?? []), temp.displayName]);
    }
  }
  return map;
});

const settingMap = computed(() => Object.fromEntries(settings.value.map((s) => [s.key, s.value])));

function parseList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(settingMap.value[key] ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(settingMap.value[key] ?? '')];
  }
}

const BYTE_KEYS = ['upload.max_file_size', 'upload.chunk_size', 'storage.default_quota'];
const PERM_KEYS = ['drive.perm1_workspace', 'drive.perm2_manage', 'drive.perm3_shared', 'drive.perm4_personal'];

const POLICY: { key: string; label: string; list: boolean }[] = [
  { key: 'upload.image_extensions', label: '图片白名单', list: true },
  { key: 'upload.file_extensions', label: '文件白名单', list: true },
  { key: 'upload.blocked_extensions', label: '一律拒绝', list: true },
  { key: 'upload.max_file_size', label: '单文件上限', list: false },
  { key: 'upload.chunk_size', label: '分片大小', list: false },
  { key: 'storage.default_quota', label: '默认配额', list: false },
  { key: 'drive.perm1_workspace', label: '文件权限1', list: false },
  { key: 'drive.perm2_manage', label: '文件权限2', list: false },
  { key: 'drive.perm3_shared', label: '文件权限3', list: false },
  { key: 'drive.perm4_personal', label: '文件权限4', list: false },
];

const POLICY_HINT: Record<string, string> = {
  'upload.blocked_extensions': '黑名单无条件拒，即使命中白名单（PRD 5.2）',
  'upload.image_extensions': '服务端还按魔数复核，不信扩展名与客户端 MIME',
  'drive.perm1_workspace': '「工作室」与「拍展」的读取／上传门槛（规则 2/3）',
  'drive.perm2_manage': '「管理」目录的门槛（规则 4）',
  'drive.perm3_shared': '成员及以上自动共享文件夹的门槛（规则 5）',
  'drive.perm4_personal': '管理员私人文件夹的门槛，填 5 表示对所有人关闭（规则 6）',
};

function policyText(item: { key: string; label: string; list: boolean }): string {
  if (item.list) return parseList(item.key).join(' / ') || '未配置';
  const raw = settingMap.value[item.key];
  if (raw === undefined || raw === '') return '未配置';
  if (PERM_KEYS.includes(item.key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    return n >= 5 ? '已对所有人关闭' : `L${n} ${LEVEL_LABEL[n] ?? ''}及以上`;
  }
  return BYTE_KEYS.includes(item.key) ? formatBytes(Number(raw) || 0) : raw;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [tree, page, rows, list] = await Promise.all([
      driveTree(),
      listFiles({ all: 1, pageSize: 20 }),
      listSettings(),
      listTemps({ onlyAlive: 1 }),
    ]);
    folders.value = tree;
    fileTotal.value = page.total;
    bigFiles.value = [...page.list].sort((a, b) => b.fileSize - a.fileSize).slice(0, 12);
    settings.value = rows;
    temps.value = list;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading">
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">网盘管理</h2>
        <p class="pk-muted">
          目录最多 8 层，能不能看、能不能改由「目录用途 + 文件权限 1~4」决定，四档门槛在
          <router-link class="pk-admin__link" to="/admin/settings">站点设置</router-link>
          的 drive.perm 族里改，改完对所有人同时生效；只想放开某一个人，去
          <router-link class="pk-admin__link" to="/admin/members">成员管理</router-link>
          的行内「网盘授权」给他单独开那一档（规则 13）。文件与目录的增删在前台
          <router-link class="pk-admin__link" to="/drive">网盘</router-link>
          里做，这里只做总览与策略核对。
        </p>
      </div>
      <el-button size="small" @click="load">刷新</el-button>
    </div>

    <div class="pk-admin__stats">
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">可见目录</p>
        <p class="pk-stat__value">{{ flatFolders.length }}</p>
        <p class="pk-stat__hint">按当前身份裁剪</p>
      </article>
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">可见文件</p>
        <p class="pk-stat__value">{{ fileTotal }}</p>
        <p class="pk-stat__hint">不含无权分支</p>
      </article>
      <article class="pk-card pk-stat">
        <p class="pk-stat__label">样本合计</p>
        <p class="pk-stat__value">{{ formatBytes(totalBytes) }}</p>
        <p class="pk-stat__hint">体积前 12 个文件合计</p>
      </article>
      <article class="pk-card pk-stat" v-for="bucket in kindBuckets" :key="bucket.kind">
        <p class="pk-stat__label">{{ FOLDER_KIND_LABEL[bucket.kind] }}目录</p>
        <p class="pk-stat__value">{{ bucket.count }}</p>
        <p class="pk-stat__hint">按用途分布</p>
      </article>
    </div>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">上传与存储策略（站点设置只读快照）</h3>
      <dl class="pk-policy">
        <template v-for="item in POLICY" :key="item.key">
          <dt>{{ item.label }}</dt>
          <dd>
            <span class="pk-admin__mono">{{ policyText(item) }}</span>
            <p v-if="POLICY_HINT[item.key]" class="pk-muted">{{ POLICY_HINT[item.key] }}</p>
          </dd>
        </template>
      </dl>
    </article>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">目录树</h3>
      <div class="pk-admin__table-wrap">
        <el-table :data="flatFolders" size="small" border>
          <el-table-column prop="id" label="ID" width="58" />
          <el-table-column label="名称" min-width="200">
            <template #default="{ row }">
              <span :style="{ paddingLeft: `${(row.depth - 1) * 14}px` }">{{ row.name }}</span>
              <span v-if="row.description" class="pk-muted pk-admin__sub">{{ row.description }}</span>
            </template>
        </el-table-column>
        <el-table-column label="层级" width="66">
          <template #default="{ row }">{{ row.depth }} / 8</template>
        </el-table-column>
        <el-table-column label="用途" width="88">
          <template #default="{ row }">
            <span class="pk-chip pk-chip--ghost">{{ FOLDER_KIND_LABEL[row.kind as FolderKind] }}</span>
          </template>
        </el-table-column>
        <el-table-column label="归属" width="96">
          <template #default="{ row }">
            <span v-if="row.owner" class="pk-muted">{{ row.owner.nickname }}</span>
            <span v-else class="pk-muted">公共</span>
          </template>
        </el-table-column>
        <el-table-column label="档位(展示)" width="96">
          <template #default="{ row }">
            <span class="pk-chip pk-chip--ghost">{{ VISIBILITY_LABEL[row.visibility as Visibility] }}</span>
          </template>
        </el-table-column>
        <el-table-column label="可见文件" width="86">
          <template #default="{ row }">{{ row.fileCount }}</template>
        </el-table-column>
        <el-table-column label="物化路径" min-width="140">
          <template #default="{ row }"><span class="pk-admin__mono">{{ row.path }}</span></template>
        </el-table-column>
        <el-table-column label="外发授权" min-width="150">
          <template #default="{ row }">
            <span v-if="sharedFolders.has(row.id)" class="pk-chip pk-chip--warn">
              {{ sharedFolders.get(row.id)?.join('、') }}
            </span>
            <span v-else class="pk-muted pk-admin__sub">未授权给临时账号</span>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <p class="pk-muted pk-admin__hint">看不到不代表不存在：无权的分支与文件一律不返回，而不是给空壳。</p>
    </article>

    <article class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">体积最大的文件（前 12）</h3>
      <div class="pk-admin__table-wrap">
        <el-table :data="bigFiles" size="small" border>
          <el-table-column prop="filename" label="文件" min-width="220" show-overflow-tooltip />
          <el-table-column label="体积" width="96">
            <template #default="{ row }">{{ formatBytes(row.fileSize) }}</template>
        </el-table-column>
        <el-table-column label="类型" min-width="150">
          <template #default="{ row }"><span class="pk-muted">{{ row.mimeType || '未知' }}</span></template>
        </el-table-column>
        <el-table-column label="档位" width="92">
          <template #default="{ row }">
            <span class="pk-chip pk-chip--ghost">{{ VISIBILITY_LABEL[row.visibility as Visibility] }}</span>
          </template>
        </el-table-column>
        <el-table-column label="上传方" width="104">
          <template #default="{ row }">
            <span class="pk-muted">{{ row.uploadTempId ? `临时 #${row.uploadTempId}` : `#${row.uploadUid}` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="126">
          <template #default="{ row }"><span class="pk-muted">{{ formatDate(row.createTime) }}</span></template>
        </el-table-column>
      </el-table>
      </div>
    </article>
  </section>
</template>

<style scoped>
.pk-admin__link {
  color: var(--pk-brand);
}

.pk-admin__sub {
  font-size: 11px;
  margin-left: 6px;
  color: var(--pk-muted);
}

.pk-admin__hint {
  font-size: 11px;
  margin: 8px 0 0;
  line-height: 1.6;
}

.pk-policy {
  display: grid;
  grid-template-columns: 108px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;
  font-size: 13px;
}

@media (max-width: 768px) {
  .pk-policy {
    grid-template-columns: 1fr;
  }
}

.pk-policy dt {
  color: var(--pk-muted);
}

.pk-policy dd {
  margin: 0;
}

.pk-policy dd p {
  margin: 2px 0 0;
  font-size: 11px;
}
</style>
