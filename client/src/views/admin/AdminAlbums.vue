<script setup lang="ts">
/**
 * 相册管理（PRD 8.2 第 2 页）。列表带张数与创建者，写操作全部走前台同一组路由，
 * 归档／锁定后的拒绝回执会原样弹出来，不在界面上做二次判断。
 * D25：超管在这里逐册关掉册内功能（「功能开关」），判定落在 policy 层的相册级闸门，
 * 与按人的能力位（PRD 6.4）是两条独立的轴，两道都放行才做得成。
 * D34：这一页的每一项改动提交前都要再验证一次当前账号口令。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  createAlbum,
  deleteAlbum,
  listAdminAlbums,
  setAlbumStatus,
  updateAlbum,
  updateAlbumCaps,
} from '@/api/admin';
import { errorText } from '@/api/client';
import type { AlbumCapKey, AlbumRowView, AlbumStage, Page, Visibility } from '@/types/api';
import {
  ALBUM_CAP_DESC,
  ALBUM_CAP_KEYS,
  ALBUM_CAP_LABEL,
  ALBUM_STATUS_LABEL,
  AlbumStatus,
  STAGE_LABEL,
  VISIBILITY_LABEL,
} from '@/types/api';
import { formatDate } from '@/utils/format';
import { askReauth, endReauth } from '@/utils/reauth';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();

const rows = ref<AlbumRowView[]>([]);
const total = ref(0);
const loading = ref(false);
const busy = ref(false);

const query = reactive({
  visibility: '' as '' | Visibility,
  status: undefined as number | undefined,
  stage: '' as '' | AlbumStage,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const form = reactive({
  open: false,
  mode: 'create' as 'create' | 'edit',
  id: 0,
  name: '',
  eventName: '',
  eventDate: '',
  location: '',
  description: '',
  visibility: 'member' as Visibility,
  stage: 'post' as AlbumStage,
});

/** 弹窗打开那一刻的字段值，「重置」回到这里 */
const formBase = ref<Pick<typeof form, 'name' | 'eventName' | 'eventDate' | 'location' | 'description' | 'visibility' | 'stage'>>({
  name: '',
  eventName: '',
  eventDate: '',
  location: '',
  description: '',
  visibility: 'member',
  stage: 'post',
});

const statusText = (status: AlbumStatus): string => ALBUM_STATUS_LABEL[status];

const visOptions = computed(() => session.visibilityOptions as readonly Visibility[]);

function fill(row?: AlbumRowView): void {
  if (row) {
    form.mode = 'edit';
    form.id = row.id;
    form.name = row.name;
    form.eventName = row.eventName;
    form.eventDate = row.eventDate;
    form.location = row.location;
    form.description = row.description;
    form.visibility = row.visibility;
    form.stage = row.stage;
  } else {
    form.mode = 'create';
    form.id = 0;
    form.name = '';
    form.eventName = '';
    form.eventDate = new Date().toISOString().slice(0, 10);
    form.location = '';
    form.description = '';
    form.visibility = 'member';
    form.stage = 'post';
  }
  formBase.value = {
    name: form.name,
    eventName: form.eventName,
    eventDate: form.eventDate,
    location: form.location,
    description: form.description,
    visibility: form.visibility,
    stage: form.stage,
  };
  form.open = true;
}

function resetForm(): void {
  Object.assign(form, formBase.value);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const page: Page<AlbumRowView> = await listAdminAlbums({
      visibility: query.visibility || undefined,
      status: query.status,
      stage: query.stage || undefined,
      keyword: query.keyword || undefined,
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

async function submit(): Promise<void> {
  if (!(await askReauth(`${form.mode === 'create' ? '新建' : '编辑'}相册「${form.name || '未命名'}」`))) return;
  busy.value = true;
  try {
    if (form.mode === 'create') {
      await createAlbum({
        name: form.name,
        eventName: form.eventName,
        eventDate: form.eventDate,
        location: form.location,
        description: form.description,
        visibility: form.visibility,
        stage: form.stage,
      });
      ElMessage.success('相册已创建');
    } else {
      await updateAlbum(form.id, {
        name: form.name,
        eventName: form.eventName,
        eventDate: form.eventDate,
        location: form.location,
        description: form.description,
        visibility: form.visibility,
        stage: form.stage,
      });
      ElMessage.success('相册已更新');
    }
    form.open = false;
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

const NEXT_STATUS: Record<number, { to: number; label: string }> = {
  [AlbumStatus.Normal]: { to: AlbumStatus.Archived, label: '归档' },
  [AlbumStatus.Archived]: { to: AlbumStatus.Normal, label: '恢复' },
  [AlbumStatus.Locked]: { to: AlbumStatus.Normal, label: '解锁' },
};

async function changeStatus(row: AlbumRowView, target: number): Promise<void> {
  if (!(await askReauth(`把「${row.name}」改为${target === AlbumStatus.Normal ? '正常' : target === AlbumStatus.Archived ? '归档' : '锁定'}`))) return;
  busy.value = true;
  try {
    await setAlbumStatus(row.id, target);
    ElMessage.success(target === AlbumStatus.Normal ? '已恢复正常' : '状态已更新');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

async function lock(row: AlbumRowView): Promise<void> {
  if (!(await askReauth(`锁定相册「${row.name}」`))) return;
  busy.value = true;
  try {
    await setAlbumStatus(row.id, AlbumStatus.Locked);
    ElMessage.success('已锁定，后续写操作会被逐条拒绝');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

async function remove(row: AlbumRowView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `「${row.name}」的 ${row.imagesCount} 张图会级联删除，不可恢复`,
      '删除相册',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  if (!(await askReauth(`删除相册「${row.name}」`))) return;
  busy.value = true;
  try {
    const result = await deleteAlbum(row.id);
    ElMessage.success(`已删除相册与其中 ${result.removedImages} 张图`);
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

// ---------------- D25：相册级功能开关 ----------------

const capsForm = reactive({
  open: false,
  id: 0,
  name: '',
  /** 开关按「允许」渲染，落库按「关闭」存，这里保存的是取反后的直观值 */
  allowed: {} as Record<AlbumCapKey, boolean>,
  /** 从父册带下来的关闭项：只读展示，子册不能越过父册去打开 */
  inherited: [] as AlbumCapKey[],
});

/** 关闭项集合换算成「每一项是否允许」，弹窗打开时的基线与当前值都走这里 */
function capsAllowedFrom(ownOff: AlbumCapKey[], inherited: AlbumCapKey[]): Record<AlbumCapKey, boolean> {
  const allowed = {} as Record<AlbumCapKey, boolean>;
  for (const key of ALBUM_CAP_KEYS) allowed[key] = !ownOff.includes(key) && !inherited.includes(key);
  return allowed;
}

/** 开关弹窗打开那一刻的允许状态，「重置」回到这里 */
const capsBase = ref<Record<AlbumCapKey, boolean>>(capsAllowedFrom([], []));

function resetCaps(): void {
  capsForm.allowed = { ...capsBase.value };
}

function fillCaps(row: AlbumRowView): void {
  const ownOff = row.capsOwnOff ?? [];
  const inherited = row.capsInheritedOff ?? [];
  capsForm.id = row.id;
  capsForm.name = row.name;
  capsForm.inherited = inherited;
  const allowed = capsAllowedFrom(ownOff, inherited);
  capsForm.allowed = allowed;
  capsBase.value = { ...allowed };
  capsForm.open = true;
}

async function submitCaps(): Promise<void> {
  if (!(await askReauth(`保存「${capsForm.name}」的册内功能开关`))) return;
  busy.value = true;
  try {
    // 只写本册自己的决定：父册带下来的项不进子册的 albumCaps（子册也没资格替父册打开）
    const off = ALBUM_CAP_KEYS.filter((key) => !capsForm.inherited.includes(key) && !capsForm.allowed[key]);
    await updateAlbumCaps(capsForm.id, off);
    ElMessage.success(`已更新「${capsForm.name}」的册内功能开关`);
    capsForm.open = false;
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

/** 列表里的关闭标记：区分「本册关的」与「父册带下来的」，前者可点进去改，后者要先改父册 */
function capNote(key: AlbumCapKey, row: AlbumRowView): string {
  const inherited = (row.capsInheritedOff ?? []).includes(key);
  const own = (row.capsOwnOff ?? []).includes(key);
  if (inherited && own) return `${ALBUM_CAP_LABEL[key]}：本册与父册都关了`;
  if (inherited) return `${ALBUM_CAP_LABEL[key]}：由父相册关闭，需回父册打开`;
  return `${ALBUM_CAP_LABEL[key]}：本册已关闭`;
}

onMounted(load);
</script>

<template>
  <section>
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">相册管理</h2>
        <p class="pk-muted">
          L3 看得到 public／member／admin 三档，private 只有超管能筛；收紧档位时册内图片会被一并收紧。
        </p>
      </div>
      <el-button type="primary" size="small" @click="fill()">新建相册</el-button>
    </div>

    <div class="pk-admin__toolbar">
      <el-select v-model="query.visibility" size="small" class="pk-admin__sel" placeholder="全部档位" clearable @change="reset">
        <el-option v-for="v in visOptions" :key="v" :label="VISIBILITY_LABEL[v]" :value="v" />
      </el-select>
      <el-select v-model="query.status" size="small" class="pk-admin__sel" placeholder="全部状态" clearable @change="reset">
        <el-option :value="1" label="正常" />
        <el-option :value="2" label="已归档" />
        <el-option :value="3" label="已锁定" />
      </el-select>
      <el-select v-model="query.stage" size="small" class="pk-admin__sel" placeholder="全部阶段" clearable @change="reset">
        <el-option :value="'pre'" label="前期" />
        <el-option :value="'post'" label="后期" />
      </el-select>
      <el-input
        v-model="query.keyword"
        size="small"
        class="pk-admin__kw"
        placeholder="名称／漫展／地点"
        clearable
        @keyup.enter="reset"
        @clear="reset"
      />
      <el-button size="small" @click="load">查询</el-button>
      <span class="pk-muted">共 {{ total }} 组</span>
    </div>

    <el-table v-loading="loading" :data="rows" size="small" border>
      <el-table-column prop="id" label="ID" width="58" />
      <el-table-column label="相册" min-width="220">
        <template #default="{ row }">
          <router-link class="pk-admin__link" :to="`/albums/${row.id}`">
            <template v-if="row.parentId !== null">↳ </template>{{ row.name }}
          </router-link>
          <p v-if="row.parentId !== null" class="pk-muted pk-admin__sub">
            子相册 · 父 ID {{ row.parentId }}
          </p>
          <p v-else-if="row.description" class="pk-muted pk-admin__sub">{{ row.description }}</p>
          <p v-if="row.capsOff?.length" class="pk-album__caps">
            <el-tooltip v-for="key in row.capsOff" :key="key" :content="capNote(key as AlbumCapKey, row)" placement="top">
              <span class="pk-chip pk-chip--warn">{{ ALBUM_CAP_LABEL[key as AlbumCapKey] }}</span>
            </el-tooltip>
          </p>
        </template>
      </el-table-column>
      <el-table-column label="漫展" width="160">
        <template #default="{ row }">{{ row.eventName }} · {{ row.eventDate }}</template>
      </el-table-column>
      <el-table-column label="档位" width="92">
        <template #default="{ row }">
          <span class="pk-chip pk-chip--ghost">{{ VISIBILITY_LABEL[row.visibility as Visibility] }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="92">
        <template #default="{ row }">
          <span :class="['pk-chip', row.status === 1 ? 'pk-chip--ghost' : 'pk-chip--warn']">
            {{ statusText(row.status) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="阶段" width="80">
        <template #default="{ row }">
          <span class="pk-chip pk-chip--ghost">{{ STAGE_LABEL[row.stage as AlbumStage] }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="imagesCount" label="张数" width="66" />
      <el-table-column label="创建者" width="120">
        <template #default="{ row }">{{ row.createName }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="126">
        <template #default="{ row }"><span class="pk-muted">{{ formatDate(row.createTime) }}</span></template>
      </el-table-column>
      <el-table-column label="操作" width="300" align="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="fill(row)">编辑</el-button>
          <el-button v-if="session.level === 4" size="small" text @click="fillCaps(row)">功能开关</el-button>
          <el-button
            v-if="row.status !== 3"
            size="small"
            text
            :disabled="row.status === 2"
            @click="lock(row)"
          >
            锁定
          </el-button>
          <el-button
            v-if="NEXT_STATUS[row.status as AlbumStatus]"
            size="small"
            text
            @click="changeStatus(row, NEXT_STATUS[row.status as AlbumStatus].to)"
          >
            {{ NEXT_STATUS[row.status as AlbumStatus].label }}
          </el-button>
          <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pk-admin__pager"
      layout="prev, pager, next, sizes, total"
      :total="total"
      :page-size="query.pageSize"
      :current-page="query.page"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="(p: number) => ((query.page = p), void load())"
      @size-change="
        (size: number) => {
          query.pageSize = size;
          reset();
        }
      "
    />

    <el-dialog v-model="form.open" :title="form.mode === 'create' ? '新建相册' : '编辑相册'" width="min(560px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="相册名">
          <el-input v-model="form.name" maxlength="60" placeholder="例如 CP29 · 雷电将军全场返图" />
        </el-form-item>
        <div class="pk-admin__row">
          <el-form-item label="漫展" class="pk-admin__col">
            <el-input v-model="form.eventName" maxlength="40" />
          </el-form-item>
          <el-form-item label="日期" class="pk-admin__col">
            <el-date-picker v-model="form.eventDate" type="date" value-format="YYYY-MM-DD" class="pk-admin__wide" />
          </el-form-item>
        </div>
        <el-form-item label="地点">
          <el-input v-model="form.location" maxlength="60" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="档位">
          <el-select v-model="form.visibility" class="pk-admin__wide">
            <el-option v-for="v in visOptions" :key="v" :value="v" :label="VISIBILITY_LABEL[v]" />
          </el-select>
          <p class="pk-muted pk-admin__hint">册内图片的档位不会宽于相册，收紧时一并下调（PRD 3.2）。</p>
        </el-form-item>
        <el-form-item label="阶段">
          <el-radio-group v-model="form.stage">
            <el-radio-button value="pre">前期</el-radio-button>
            <el-radio-button value="post">后期</el-radio-button>
          </el-radio-group>
          <p class="pk-muted pk-admin__hint">前期 = 拍展/原片/审稿；后期 = 精修/交付完成。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="form.open = false">取消</el-button>
        <el-button @click="resetForm">重置</el-button>
        <el-button type="primary" :loading="busy" @click="submit">保存</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="capsForm.open" :title="`册内功能开关 · ${capsForm.name}`" width="min(620px, 94vw)">
      <p class="pk-muted pk-admin__hint">
        PRD 6.5 / D25：这里逐册关掉某项功能，<b>只收紧不放宽</b>——关掉一定拦得住，打开也只是回到等级与个人授权（PRD 6.4）
        的原有判定。父相册关掉的那一项会带下来，子相册里同样打不开。
      </p>
      <div class="pk-album__caplist">
        <div v-for="key in ALBUM_CAP_KEYS" :key="key" class="pk-album__cap">
          <el-switch
            v-model="capsForm.allowed[key]"
            size="small"
            :disabled="capsForm.inherited.includes(key)"
            active-text="允许"
            inactive-text="关闭"
          />
          <div>
            <p class="pk-muted"><b>{{ ALBUM_CAP_LABEL[key] }}</b>：{{ ALBUM_CAP_DESC[key] }}</p>
            <p v-if="capsForm.inherited.includes(key)" class="pk-muted pk-album__from">
              由父相册关闭，需回父册打开
            </p>
          </div>
        </div>
      </div>
      <p class="pk-muted pk-admin__hint">
        改名、改档位、锁定／归档、删除相册与改这批开关本身属于「相册管理」，<b>不受这批开关约束</b>，
        超管不会把自己锁在相册外面；已发出的返图链接也不回溯收回，关掉「建返图链接」只拦新建。
        点「保存开关」要先填当前账号的登录口令（PRD 6.1 / D34），「重置」只回到打开时的状态。
      </p>
      <template #footer>
        <el-button @click="capsForm.open = false">取消</el-button>
        <el-button @click="resetCaps">重置</el-button>
        <el-button type="primary" :loading="busy" @click="submitCaps">保存开关</el-button>
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

.pk-admin__link {
  color: var(--pk-brand);
}

.pk-admin__sub {
  font-size: 11px;
  margin: 2px 0 0;
}

.pk-admin__hint {
  font-size: 11px;
  margin: 6px 0 0;
  line-height: 1.6;
}

.pk-admin__row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.pk-admin__col {
  flex: 1 1 180px;
}

.pk-album__caps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0 0;
}

.pk-album__caplist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 10px 0 4px;
}

.pk-album__cap {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.pk-album__cap > div {
  flex: 1;
  min-width: 0;
}

.pk-album__from {
  font-size: 11px;
  margin: 2px 0 0;
}
</style>
