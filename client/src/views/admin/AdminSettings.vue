<script setup lang="ts">
/**
 * 站点设置（PRD 8.2 第 9 页 / 6.1）。L3 只读、仅 L4 可写；类型校验放在服务端，
 * 页面不重复实现规则，只收集脏值整体提交，把 400 的原样回执显示出来。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { listSettings, updateSettings } from '@/api/admin';
import { errorText } from '@/api/client';
import type { AdminSettingRow, ContactChannel } from '@/types/api';
import { CONTACT_TYPES, parseContactChannels } from '@/utils/contact';
import { formatBytes } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();

const rows = ref<AdminSettingRow[]>([]);
const loading = ref(false);
const busy = ref(false);
/** 只存被改过的键；未改动的键不提交，免得把整表覆写一遍 */
const draft = ref<Record<string, string>>({});
/** 联系方式的编辑态：逐行改比手写 JSON 靠谱，改动即时序列化回 draft */
const contacts = ref<ContactChannel[]>([]);

const BOOL_KEYS = ['watermark.enabled'];
const BYTE_KEYS = ['upload.max_image_size', 'upload.max_file_size', 'upload.chunk_size', 'storage.default_quota'];
const GROUP_ORDER = ['上传', '派生图', '水印', '存储与配额', '安全与限流', '站点信息', '其他'];

const canWrite = computed(() => session.caps.writeSiteSettings);
const dirtyKeys = computed(() => Object.keys(draft.value));

/** 按后端给的 group 分桶，顺序跟着 GROUP_ORDER，未知组兜到「其他」 */
const groups = computed(() => {
  const map = new Map<string, AdminSettingRow[]>();
  for (const row of rows.value) {
    const list = map.get(row.group) ?? [];
    list.push(row);
    map.set(row.group, list);
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g) as AdminSettingRow[] }));
});

function valueOf(row: AdminSettingRow): string {
  return draft.value[row.key] ?? row.value;
}

function isDirty(row: AdminSettingRow): boolean {
  return draft.value[row.key] !== undefined && draft.value[row.key] !== row.value;
}

function setValue(row: AdminSettingRow, value: string): void {
  if (value === row.value) delete draft.value[row.key];
  else draft.value[row.key] = value;
}

function isBool(row: AdminSettingRow): boolean {
  return BOOL_KEYS.includes(row.key);
}

function boolOf(row: AdminSettingRow): boolean {
  const value = valueOf(row);
  return value === 'true' || value === '1';
}

/** 长文案（站点简介）用多行框，别的键保持单行 */
function isText(row: AdminSettingRow): boolean {
  return row.key === 'site.intro' || row.value.includes('\n');
}

function byteHint(row: AdminSettingRow): string {
  if (!BYTE_KEYS.includes(row.key)) return '';
  const n = Number(valueOf(row));
  return Number.isFinite(n) ? `≈ ${formatBytes(n)}` : '不是数字，保存会被服务端挡住';
}

/** 扩展名白/黑名单这类 JSON 数组键，先把解析结果摊开给人看，避免手写引号 */
function listHint(row: AdminSettingRow): string {
  if (!row.key.endsWith('_extensions')) return '';
  try {
    const parsed: unknown = JSON.parse(valueOf(row));
    if (!Array.isArray(parsed)) return '不是 JSON 数组';
    return `${parsed.length} 项：${parsed.map(String).join(' ')}`;
  } catch {
    return 'JSON 解析失败，保存会返回 400';
  }
}

// ---------------- 联系方式（site.contact） ----------------

const CONTACT_KEY = 'site.contact';

function isContact(row: AdminSettingRow): boolean {
  return row.key === CONTACT_KEY;
}

function contactRow(): AdminSettingRow | undefined {
  return rows.value.find(isContact);
}

function seedContacts(): void {
  const row = contactRow();
  contacts.value = row ? parseContactChannels(row.value).map((channel) => ({ ...channel })) : [];
}

/** 空行不落库：刚点「添加一条」还没填的那行不该被存成空壳渠道 */
function commitContacts(): void {
  const row = contactRow();
  if (!row) return;
  const kept = contacts.value.filter((channel) => channel.value.trim() || channel.label.trim());
  setValue(row, JSON.stringify(kept));
}

watch(contacts, commitContacts, { deep: true });

function addContact(): void {
  contacts.value.push({ type: 'other', label: '', value: '' });
}

function removeContact(at: number): void {
  contacts.value.splice(at, 1);
}

function resetDraft(): void {
  draft.value = {};
  seedContacts();
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listSettings();
    resetDraft();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!dirtyKeys.value.length) return;
  busy.value = true;
  try {
    const settings: Record<string, string> = {};
    for (const key of dirtyKeys.value) settings[key] = draft.value[key] as string;
    rows.value = await updateSettings(settings);
    resetDraft();
    ElMessage.success(`已保存 ${Object.keys(settings).length} 项，后端下次读取即生效`);
  } catch (err) {
    // 服务端逐键校验，脏值原样保留在输入框里，改对了再提交
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading">
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">站点设置</h2>
        <p class="pk-muted">
          配置项照抄 <code>site_settings</code> 的键名，值全部按字符串存；上传上限、派生图尺寸、水印都在这里改。
          当前身份 {{ session.displayName }}。
        </p>
      </div>
      <div class="pk-admin__inline">
        <el-button size="small" :disabled="loading" @click="load">重新读取</el-button>
        <el-button size="small" :disabled="!dirtyKeys.length" @click="resetDraft">放弃修改</el-button>
        <el-button
          size="small"
          type="primary"
          :disabled="!canWrite || !dirtyKeys.length"
          :loading="busy"
          @click="save"
        >
          保存 {{ dirtyKeys.length ? `(${dirtyKeys.length})` : '' }}
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="!canWrite"
      class="pk-admin__alert"
      type="warning"
      :closable="false"
      show-icon
      title="只读"
      description="PRD 6.1：核心配置只有超级管理员能改，普通管理员可以查看。想改请用演示身份切到 L4。"
    />
    <p v-else-if="dirtyKeys.length" class="pk-muted pk-admin__dirty">
      已改动 {{ dirtyKeys.length }} 项，未保存前不影响线上行为。
    </p>

    <article v-for="bucket in groups" :key="bucket.group" class="pk-card pk-admin__card">
      <h3 class="pk-admin__card-title">{{ bucket.group }}</h3>
      <div v-for="row in bucket.items" :key="row.key" class="pk-setting">
        <div class="pk-setting__name">
          <span class="pk-admin__mono">{{ row.key }}</span>
          <span v-if="row.readOnlyNote" class="pk-chip pk-chip--warn">待定稿</span>
          <span v-if="isDirty(row)" class="pk-chip">已改动</span>
          <p v-if="row.readOnlyNote" class="pk-muted pk-setting__note">{{ row.readOnlyNote }}</p>
        </div>

        <div class="pk-setting__ctl">
          <div v-if="isContact(row)" class="pk-contacts">
            <div v-for="(channel, at) in contacts" :key="at" class="pk-contacts__row">
              <el-select v-model="channel.type" size="small" :disabled="!canWrite" class="pk-contacts__type">
                <el-option v-for="item in CONTACT_TYPES" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <el-input
                v-model="channel.label"
                size="small"
                :disabled="!canWrite"
                placeholder="展示名（留空用类型名）"
                class="pk-contacts__label"
              />
              <el-input
                v-model="channel.value"
                size="small"
                :disabled="!canWrite"
                placeholder="账号 / 群号 / 邮箱 / 链接"
                class="pk-contacts__value"
              />
              <el-button size="small" text type="danger" :disabled="!canWrite" @click="removeContact(at)">删除</el-button>
            </div>
            <div class="pk-contacts__foot">
              <el-button size="small" :disabled="!canWrite" @click="addContact">添加一条</el-button>
              <span class="pk-muted">对外页面按这里的顺序展示；value 为空的行不会落库。</span>
            </div>
          </div>
          <el-switch
            v-else-if="isBool(row)"
            :model-value="boolOf(row)"
            :disabled="!canWrite"
            size="small"
            active-text="开"
            inactive-text="关"
            @update:model-value="setValue(row, $event ? 'true' : 'false')"
          />
          <el-input
            v-else
            :model-value="valueOf(row)"
            size="small"
            :disabled="!canWrite"
            :type="isText(row) ? 'textarea' : 'text'"
            :autosize="isText(row) ? { minRows: 3, maxRows: 8 } : undefined"
            @update:model-value="setValue(row, String($event))"
          />
          <p v-if="byteHint(row) || listHint(row)" class="pk-muted pk-setting__hint">
            {{ byteHint(row) || listHint(row) }}
          </p>
        </div>
      </div>
    </article>

    <p class="pk-muted pk-admin__note">
      上传与配额这一族键后端每次读取、改完不需要重启，mock 也按同一套规则在建会话那一关挡类型、超限与超配额；
      水印只影响之后生成的预览，已入库的派生图不会重跑。
      站点简介这一族键 schema.sql 里还没有，落库时要补默认值（PRD 12.9 配置走环境变量，不写死在代码里）。
    </p>
  </section>
</template>

<style scoped>
.pk-admin__alert {
  margin-bottom: 14px;
}

.pk-admin__dirty {
  margin: -6px 0 12px;
}

.pk-setting {
  display: grid;
  grid-template-columns: minmax(200px, 300px) minmax(0, 1fr);
  gap: 6px 16px;
  align-items: start;
  padding: 10px 0;
  border-top: 1px solid var(--pk-line);
}

.pk-setting:first-of-type {
  border-top: none;
}

.pk-setting__name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.pk-setting__note {
  flex-basis: 100%;
  font-size: 12px;
  line-height: 1.5;
}

.pk-setting__hint {
  font-size: 12px;
  margin-top: 4px;
  line-height: 1.5;
  word-break: break-all;
}

.pk-contacts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pk-contacts__row {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr) minmax(0, 1.5fr) auto;
  gap: 8px;
  align-items: center;
}

.pk-contacts__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  font-size: 12px;
}

.pk-admin__note {
  font-size: 12px;
  line-height: 1.7;
  margin-top: 4px;
}

@media (max-width: 860px) {
  .pk-setting {
    grid-template-columns: minmax(0, 1fr);
  }

  .pk-contacts__row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
</style>
