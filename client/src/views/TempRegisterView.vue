<script setup lang="ts">
/**
 * 临时账号注册页（手绘稿 20，画里写的「游客」就是临时账号）。
 * 帐户ID 由服务端发（GET /temp-tasks/next-code），「换一个」只是重新抽一个还没占用的号；
 * 它同时是规则 3 里挂在隐藏「拍展」子树下的目录名，所以创立成功后，右侧暂存的文件直接落到那个目录，
 * 而不是先挑目的地——注册页不该关心目的地，是目录跟着账号长出来。
 * 权限开关画里没有，一律由服务端按默认值给（D27 起只剩预览／下载／改标签三位，上传不再授予给临时账号）；
 * 时长上限也随取号一起下发（D9：L1/L2 只有 7 天，且不给改标签）。
 * 名称（PRD 6.2 的 display_name）画里同样没有，但它是账号对外署名的字段——不填的话对方登录后满屏看到的就是一串帐户ID。
 * 登录密码支持「随机生成」（D35）：明文只在这一页生成、由创建者复制转交，服务端收到的仍是一条普通 password。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { errorText } from '@/api/error';
import { nextAccountCode, registerTemp } from '@/api/temp';
import { uploadFileMeta } from '@/api/drive';
import type { TempTaskRow } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';
import { generateTempPassword } from '@/utils/random-password';
import { useSessionStore } from '@/stores/session';

interface Attachment {
  key: number;
  name: string;
  size: number;
  type: string;
  state: '待传' | '已传' | '失败';
  detail: string;
  file: File;
}

const session = useSessionStore();
const router = useRouter();

const form = reactive({
  code: '',
  displayName: '',
  password: '',
  confirm: '',
  shootContent: '',
  recycling: '',
  days: 14,
});
const attachments = ref<Attachment[]>([]);
/** 帐号时长上限：由 /temp-tasks/next-code 按身份下发（D9 给 L1/L2 的是 7 天） */
const maxDays = ref(365);
const creating = ref(false);
const created = ref<TempTaskRow | null>(null);
const createdAttachments = ref<{ ok: number; failed: string[] }>({ ok: 0, failed: [] });
const fileInput = ref<HTMLInputElement | null>(null);

const mismatch = computed(() => !!form.confirm && form.confirm !== form.password);
const canSubmit = computed(
  () =>
    !!form.code &&
    !!form.displayName.trim() &&
    form.password.length >= 6 &&
    form.confirm === form.password &&
    !creating.value,
);

async function rollCode(): Promise<void> {
  try {
    const next = await nextAccountCode();
    form.code = next.code;
    maxDays.value = next.maxDays;
    if (form.days > next.maxDays) form.days = next.maxDays;
  } catch (err) {
    ElMessage.error(errorText(err, '取号失败'));
  }
}

/** 随机口令由创建者生成后转交，所以两个框一起填满——确认框防手滑的口径不为随机串破例 */
function rollPassword(): void {
  const pwd = generateTempPassword();
  form.password = pwd;
  form.confirm = pwd;
  ElMessage.success(`已随机生成 ${pwd.length} 位登录密码，点「复制帐号信息」就能连同帐户ID 交给对方`);
}

function pickFiles(): void {
  fileInput.value?.click();
}

function onFiles(event: Event): void {
  const picked = Array.from((event.target as HTMLInputElement).files ?? []);
  let key = Date.now();
  for (const file of picked) {
    if (attachments.value.some((a) => a.name === file.name && a.size === file.size)) continue;
    attachments.value.push({ key: (key += 1), name: file.name, size: file.size, type: file.type, state: '待传', detail: '', file });
  }
  (event.target as HTMLInputElement).value = '';
}

function dropAttachment(key: number): void {
  attachments.value = attachments.value.filter((a) => a.key !== key);
}

/** 复制给 coser 的那一段：帐户ID、密码、登录入口与到期日，一次拷走 */
async function copyInfo(): Promise<void> {
  const text = created.value
    ? [
        `皮克社工作室 · 返图账号`,
        `帐户ID：${created.value.code}`,
        `名称：${created.value.displayName}`,
        `登录密码：${form.password}`,
        `有效期：至 ${formatDate(created.value.expiresAt)}（剩 ${created.value.daysLeft} 天）`,
        `取图目录：拍展／${created.value.taskFolderName}`,
        `登录入口：${location.origin}/login`,
      ].join('\n')
    : [
        `皮克社工作室 · 返图账号`,
        `帐户ID：${form.code}`,
        `名称：${form.displayName.trim() || '（还没填）'}`,
        `登录密码：${form.password}`,
        `帐号时长：${form.days} 天`,
        `登录入口：${location.origin}/login`,
      ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('帐号信息已复制，直接发给对方即可');
  } catch {
    ElMessage.warning('当前环境不给写剪贴板，请手动记下帐户ID 与密码');
  }
}

async function create(): Promise<void> {
  if (!canSubmit.value) {
    ElMessage.warning(
      !form.displayName.trim()
        ? '先填名称（一般是 coser 名），登录与署名都展示它'
        : form.password.length < 6
          ? '登录密码至少 6 位'
          : '两次输入的密码要一致',
    );
    return;
  }
  creating.value = true;
  try {
    const row = await registerTemp({
      code: form.code,
      displayName: form.displayName.trim(),
      password: form.password,
      shootContent: form.shootContent.trim(),
      recycling: form.recycling.trim(),
      days: form.days,
    });
    created.value = row;
    // 附件跟着账号挂进它自己的帐户 ID 目录，不合格的文件留下原因，不静默丢
    const result = { ok: 0, failed: [] as string[] };
    for (const item of attachments.value) {
      try {
        await uploadFileMeta({ folderId: row.taskFolderId, filename: item.name, fileSize: item.size, mimeType: item.type });
        item.state = '已传';
        result.ok += 1;
      } catch (err) {
        item.state = '失败';
        item.detail = errorText(err, '登记失败');
        result.failed.push(`${item.name}：${item.detail}`);
      }
    }
    createdAttachments.value = result;
    ElMessage.success(
      result.failed.length
        ? `账号已创立，${result.ok} 个附件已入目录，${result.failed.length} 个被拒`
        : `账号已创立，帐户ID ${row.code} 现在可以登录`,
    );
  } catch (err) {
    ElMessage.error(errorText(err, '创立失败'));
  } finally {
    creating.value = false;
  }
}

function cancel(): void {
  if (created.value) {
    void router.push({ name: 'tasks' });
    return;
  }
  void router.back();
}

onMounted(rollCode);
</script>

<template>
  <section class="pk-reg">
    <header class="pk-reg__head pk-card">
      <div>
        <h1 class="pk-page-title">{{ session.welcome || '开临时账号' }}</h1>
        <p class="pk-muted">
          开一个临时账号，帐户ID 同时是它在「拍展」里的目录名（规则 3），对方拿这个号与密码登录后只能看到自己的那一棵。
        </p>
      </div>
      <span class="pk-chip">{{ session.identityLabel }}</span>
    </header>

    <div class="pk-reg__body">
      <div class="pk-reg__form pk-card">
        <div class="pk-reg__field">
          <label>帐户ID（唯一）</label>
          <div class="pk-reg__row">
            <el-input v-model="form.code" maxlength="24" placeholder="大写字母、数字与短横线，4~24 位" />
            <el-button @click="rollCode">换一个</el-button>
          </div>
        </div>

        <div class="pk-reg__field">
          <label>名称（必填）</label>
          <el-input v-model="form.displayName" maxlength="30" placeholder="一般填 coser 名，登录与署名都展示它" />
        </div>

        <div class="pk-reg__field">
          <label>登录密码（必填）</label>
          <div class="pk-reg__row">
            <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
            <el-button @click="rollPassword">随机生成</el-button>
          </div>
        </div>

        <div class="pk-reg__field">
          <label>再次确认（必填）</label>
          <el-input
            v-model="form.confirm"
            type="password"
            show-password
            placeholder="再输一遍"
            :class="{ 'is-error': mismatch }"
          />
          <p v-if="mismatch" class="pk-reg__err">两次输入不一致</p>
        </div>

        <div class="pk-reg__field">
          <label>拍摄内容（选填）</label>
          <el-input v-model="form.shootContent" type="textarea" :rows="2" maxlength="120" placeholder="例如：CP29 场照 + 棚拍返图" />
        </div>

        <div class="pk-reg__field">
          <label>帐号时长</label>
          <div class="pk-reg__row pk-reg__row--days">
            <el-input-number v-model="form.days" :min="1" :max="maxDays" />
            <span class="pk-muted">
              天后自动到期，到期即销毁<span v-if="maxDays < 365">（D9：见习与成员开号最多 {{ maxDays }} 天）</span>
            </span>
          </div>
        </div>

        <div class="pk-reg__field">
          <label>后期回收（选填）</label>
          <el-input v-model="form.recycling" type="textarea" :rows="2" maxlength="120" placeholder="例如：精修完把 PSD 源文件传回同一个目录" />
        </div>

        <div class="pk-reg__actions">
          <el-button @click="copyInfo">复制帐号信息</el-button>
          <el-button type="primary" :loading="creating" :disabled="!canSubmit" @click="create">创立</el-button>
          <el-button text @click="cancel">取消</el-button>
        </div>
      </div>

      <aside class="pk-reg__side pk-card">
        <div class="pk-reg__side-head">
          <strong>本地上传文件</strong>
          <el-button size="small" circle @click="pickFiles">+</el-button>
        </div>
        <p class="pk-muted pk-reg__side-hint">
          参考图、色卡这类附件在创立后挂进这个账号自己的目录，不给别人看见。
        </p>
        <input ref="fileInput" type="file" multiple hidden @change="onFiles" />

        <ul v-if="attachments.length" class="pk-reg__files">
          <li v-for="item in attachments" :key="item.key">
            <div>
              <span class="pk-reg__name">{{ item.name }}</span>
              <span class="pk-muted">{{ formatBytes(item.size) }}</span>
            </div>
            <span class="pk-chip pk-chip--ghost">{{ item.state }}</span>
            <button type="button" class="pk-reg__del" :disabled="item.state === '已传'" @click="dropAttachment(item.key)">移除</button>
            <p v-if="item.detail" class="pk-reg__err">{{ item.detail }}</p>
          </li>
        </ul>
        <p v-else class="pk-muted pk-reg__empty">还没有选文件</p>

        <div v-if="created" class="pk-reg__done">
          <strong>{{ created.displayName }} · {{ created.code }}</strong>
          <p>目录：拍展／{{ created.taskFolderName }}（id {{ created.taskFolderId }}）</p>
          <p>有效期：至 {{ formatDate(created.expiresAt) }}</p>
          <p v-if="createdAttachments.failed.length" class="pk-reg__err">
            {{ createdAttachments.ok }} 个已入目录，被拒 {{ createdAttachments.failed.length }} 个
          </p>
          <p v-else-if="createdAttachments.ok" class="pk-muted">{{ createdAttachments.ok }} 个附件已入目录</p>
          <el-button size="small" @click="router.push({ name: 'tasks' })">查看任务</el-button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.pk-reg__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
}

.pk-reg__head p {
  margin: 6px 0 0;
  font-size: 12px;
  max-width: 720px;
}

.pk-reg__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 14px;
  margin-top: 14px;
}

.pk-reg__form {
  padding: 18px;
}

.pk-reg__field {
  margin-bottom: 14px;
}

.pk-reg__field > label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}

.pk-reg__row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pk-reg__row--days {
  gap: 12px;
}

.pk-reg__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
}

.pk-reg__side {
  align-self: start;
  padding: 14px 16px;
}

.pk-reg__side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pk-reg__side-hint {
  margin: 8px 0 12px;
  font-size: 12px;
  line-height: 1.6;
}

.pk-reg__files {
  margin: 0;
  padding: 0;
  list-style: none;
}

.pk-reg__files li {
  padding: 8px 0;
  border-bottom: 1px dashed var(--pk-line);
  font-size: 12px;
}

.pk-reg__files li > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.pk-reg__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pk-reg__del {
  margin-left: 8px;
  font: inherit;
  color: var(--pk-muted);
  cursor: pointer;
  background: none;
  border: 0;
  padding: 0;
}

.pk-reg__del:disabled {
  color: var(--pk-line);
  cursor: not-allowed;
}

.pk-reg__empty {
  margin: 0;
  font-size: 12px;
}

.pk-reg__err {
  margin: 4px 0 0;
  color: #d64545;
  font-size: 12px;
}

.pk-reg__done {
  margin-top: 14px;
  padding: 12px;
  background: var(--pk-brand-soft);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.7;
}

.pk-reg__done p {
  margin: 2px 0;
}

@media (max-width: 900px) {
  .pk-reg__body {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .pk-reg__head {
    flex-wrap: wrap;
  }

  .pk-reg__row {
    flex-wrap: wrap;
  }

  .pk-reg__actions {
    flex-direction: column;
  }

  .pk-reg__actions .el-button {
    width: 100%;
  }
}
</style>
