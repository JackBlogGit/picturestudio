<script setup lang="ts">
/**
 * 成员与临时账号（PRD 8.2 第 3 页）。等级与开关的收口都在后端：
 * L3 只能碰 L1/L2、看不到 L4 的存在，超管转让要带 confirmTransfer 二次确认（12.4）。
 * 「网盘授权」是超管独占的个人授权（规则 13）：单独给某一个人开文件权限1~4 的某一档，
 * 只绕过他这一档的等级门槛，站点门槛本身不动。
 * D34：这一页的每一项改动（含行内的重置口令、续期、注销）提交前都要再验证一次当前账号口令。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  createTemp,
  createUser,
  deleteUser,
  destroyTemp,
  listAdminAlbums,
  listSettings,
  listTemps,
  listUsers,
  resetPassword,
  updateTemp,
  updateTempCredentials,
  updateUser,
  updateUserDriveGrants,
  updateUserFeatureGrants,
} from '@/api/admin';
import { driveTree } from '@/api/drive';
import { errorText, isApiError } from '@/api/client';
import type { AdminTempRow, AdminUserRow, CapKey, CapMode, DriveGrant, FeatureGrant, FolderNode, TempFlags, UserLevel } from '@/types/api';
import { CAP_DESC, CAP_KEYS, CAP_LABEL, CAP_MODE_LABEL, DRIVE_GRANT_LABEL, LEVEL_LABEL, RESERVED_CAPS, UserLevel as Level } from '@/types/api';
import { formatBytes, formatDate } from '@/utils/format';
import { askReauth, endReauth } from '@/utils/reauth';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const GB = 1024 * 1024 * 1024;

const tab = ref<'users' | 'temps'>('users');
const loading = ref(false);
const busy = ref(false);

const users = ref<AdminUserRow[]>([]);
const temps = ref<AdminTempRow[]>([]);
const userQuery = reactive({ level: undefined as number | undefined, keyword: '' });
const tempQuery = reactive({ onlyAlive: false, keyword: '' });

const albumOptions = ref<{ id: number; name: string }[]>([]);
const folderOptions = ref<{ id: number; label: string }[]>([]);

const userForm = reactive({
  open: false,
  mode: 'create' as 'create' | 'edit',
  uid: 0,
  username: '',
  nickname: '',
  position: '',
  level: 2 as UserLevel,
  quotaGb: 1,
  disabled: false,
  password: '',
  confirmPassword: '',
});

/** 成员弹窗打开那一刻的值，「重置」回到这里（口令框不参与） */
const userBase = ref<Pick<typeof userForm, 'username' | 'nickname' | 'position' | 'level' | 'quotaGb' | 'disabled'>>({
  username: '',
  nickname: '',
  position: '',
  level: 1,
  quotaGb: 1,
  disabled: false,
});

const FLAG_LABEL: Record<keyof TempFlags, string> = {
  preview: '预览',
  download: '下载',
  editTag: '改标签',
};

/** D27：传图与传文件两开关已作废——临时账号只能取图，写档能力由身份决定，不再是按授予 */
const EDITABLE_FLAG_KEYS: (keyof TempFlags)[] = ['preview', 'download', 'editTag'];

const tempForm = reactive({
  open: false,
  mode: 'create' as 'create' | 'edit',
  tempId: 0,
  displayName: '',
  days: 14,
  quotaGb: 1,
  flags: { preview: true, download: true, editTag: false } as TempFlags,
  albumIds: [] as number[],
  folderIds: [] as number[],
  /** D22：仅 L4 可改的登录凭据 */
  code: '',
  password: '',
  confirmPassword: '',
  originCode: '',
});

/** 临时账号弹窗打开那一刻的值，「重置」回到这里（口令框不参与） */
const tempBase = ref({
  displayName: '',
  days: 14,
  quotaGb: 1,
  flags: { preview: true, download: true, editTag: false } as TempFlags,
  albumIds: [] as number[],
  folderIds: [] as number[],
  code: '',
});

/** L4 才允许出现 4 这一档，否则前端会给出后端必拒的选项 */
const levelOptions = computed(() =>
  [1, 2, 3, 4].filter((l) => l <= (session.level === Level.SuperAdmin ? 4 : 3)),
);

function flattenFolders(nodes: FolderNode[], out: FolderNode[] = []): FolderNode[] {
  for (const node of nodes) {
    out.push(node);
    flattenFolders(node.children, out);
  }
  return out;
}

async function loadUsers(): Promise<void> {
  loading.value = true;
  try {
    users.value = await listUsers({
      level: userQuery.level,
      keyword: userQuery.keyword || undefined,
    });
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function loadTemps(): Promise<void> {
  loading.value = true;
  try {
    temps.value = await listTemps({
      onlyAlive: tempQuery.onlyAlive ? 1 : undefined,
      keyword: tempQuery.keyword || undefined,
    });
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function loadTab(): Promise<void> {
  if (tab.value === 'users') await loadUsers();
  else await loadTemps();
}

async function loadPools(): Promise<void> {
  try {
    const [albums, folders] = await Promise.all([
      listAdminAlbums({ pageSize: 100 }),
      driveTree(),
    ]);
    albumOptions.value = albums.list.map((a) => ({ id: a.id, name: a.name }));
    folderOptions.value = flattenFolders(folders).map((f) => ({
      id: f.id,
      label: `${'　'.repeat(Math.max(0, f.depth - 1))}${f.name}`,
    }));
  } catch {
    // 白名单候选拉不到时下拉是空的，保存仍由后端校验，不做本地兜底数据
  }
}

function fillUser(row?: AdminUserRow): void {
  userForm.password = '';
  userForm.confirmPassword = '';
  if (row) {
    userForm.mode = 'edit';
    userForm.uid = row.uid;
    userForm.username = row.username;
    userForm.nickname = row.nickname;
    userForm.position = row.position;
    userForm.level = row.level;
    userForm.quotaGb = Number((row.spaceQuota / GB).toFixed(2));
    userForm.disabled = row.disabled;
  } else {
    userForm.mode = 'create';
    userForm.uid = 0;
    userForm.username = '';
    userForm.nickname = '';
    userForm.position = '';
    userForm.level = 1;
    userForm.quotaGb = 1;
    userForm.disabled = false;
  }
  userBase.value = {
    username: userForm.username,
    nickname: userForm.nickname,
    position: userForm.position,
    level: userForm.level,
    quotaGb: userForm.quotaGb,
    disabled: userForm.disabled,
  };
  userForm.open = true;
}

function resetUser(): void {
  Object.assign(userForm, userBase.value);
  userForm.password = '';
  userForm.confirmPassword = '';
}

/** 口令只在提交时校验：建号必填，编辑时留空即不改；确认口令防手滑 */
function passwordError(): string | null {
  if (!userForm.password) {
    if (userForm.mode === 'create') return '请设置初始口令';
    return userForm.confirmPassword ? '请填写新口令' : null;
  }
  if (userForm.password.length < 8) return '口令至少 8 位';
  if (userForm.password !== userForm.confirmPassword) return '两次输入的口令不一致';
  return null;
}

async function submitUser(): Promise<void> {
  const pwdErr = passwordError();
  if (pwdErr) {
    ElMessage.error(pwdErr);
    return;
  }
  const spaceQuota = Math.round(userForm.quotaGb * GB);
  if (!(await askReauth(`${userForm.mode === 'create' ? '新建' : '编辑'}成员「${userForm.nickname || userForm.username}」`))) return;
  busy.value = true;
  try {
    if (userForm.mode === 'create') {
      await createUser({
        username: userForm.username,
        nickname: userForm.nickname,
        position: userForm.position,
        level: userForm.level,
        spaceQuota,
        password: userForm.password,
      });
      ElMessage.success('账号已创建');
    } else {
      await patchUserWithTransfer(userForm.uid, {
        username: userForm.username,
        nickname: userForm.nickname,
        position: userForm.position,
        level: userForm.level,
        spaceQuota,
        disabled: userForm.disabled,
      });
      if (userForm.password) {
        await resetPassword(userForm.uid, userForm.password);
        ElMessage.success('口令已重置');
      }
    }
    userForm.open = false;
    await loadUsers();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

/** 升到 L4 会被 409 挡住，确认后带 confirmTransfer 重发一次（PRD 12.4） */
async function patchUserWithTransfer(uid: number, body: Parameters<typeof updateUser>[1]): Promise<void> {
  try {
    await updateUser(uid, body);
    ElMessage.success('账号已更新');
  } catch (err) {
    if (!isApiError(err) || err.code !== 'SUPER_ADMIN_EXISTS') throw err;
    const confirmed = await ElMessageBox.confirm(err.message, '超管转让需二次确认', {
      type: 'warning',
      confirmButtonText: '确认转让',
      cancelButtonText: '放弃',
    }).catch(() => false);
    if (!confirmed) throw err;
    await updateUser(uid, { ...body, confirmTransfer: true });
    await ElMessageBox.alert('超管已在同一事务内转让，原持有者降为 L3。', '转让完成', { type: 'success' }).catch(
      () => undefined,
    );
  }
}

async function quickDisable(row: AdminUserRow): Promise<void> {
  if (!(await askReauth(`${row.disabled ? '启用' : '禁用'}「${row.nickname}」`))) return;
  busy.value = true;
  try {
    await updateUser(row.uid, { disabled: !row.disabled });
    await loadUsers();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

async function doResetPassword(row: AdminUserRow): Promise<void> {
  const input = await ElMessageBox.prompt(
    `为「${row.nickname}」设置新口令，至少 8 位。真接口存 bcrypt，日志只记「改了」。`,
    '重置口令',
    { inputType: 'password', inputValue: '', confirmButtonText: '重置', cancelButtonText: '取消' },
  ).catch(() => null);
  if (!input) return;
  if (!(await askReauth(`重置「${row.nickname}」的登录口令`))) return;
  busy.value = true;
  try {
    await resetPassword(row.uid, input.value);
    ElMessage.success('口令已重置');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

async function doDeleteUser(row: AdminUserRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除「${row.nickname}」后其相册与图片不会自动转移，请先确认归属。`,
    '删除账号',
    { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  if (!(await askReauth(`删除账号「${row.nickname}」`))) return;
  busy.value = true;
  try {
    await deleteUser(row.uid);
    ElMessage.success('账号已删除');
    await loadUsers();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

/** 四档文件权限：说明文案 + 对应的站点门槛配置键（规则 13 授权弹窗逐行渲染） */
const GRANT_META: { key: keyof DriveGrant; settingKey: string; desc: string }[] = [
  { key: 'perm1', settingKey: 'drive.perm1_workspace', desc: '「工作室」与「拍展」目录的读取／上传（规则 2/3）' },
  { key: 'perm2', settingKey: 'drive.perm2_manage', desc: '「管理」目录（规则 4）' },
  { key: 'perm3', settingKey: 'drive.perm3_shared', desc: '自动拥有以本人名称命名的共享文件夹（规则 1/5）' },
  { key: 'perm4', settingKey: 'drive.perm4_personal', desc: '私人文件夹（规则 6，彻底删除仍只认超管）' },
];

const grantForm = reactive({
  open: false,
  uid: 0,
  nickname: '',
  level: 1 as UserLevel,
  grant: { perm1: false, perm2: false, perm3: false, perm4: false } as DriveGrant,
});

/** 授权弹窗打开那一刻的四档开关，「重置」回到这里 */
const grantBase = ref<DriveGrant>({ perm1: false, perm2: false, perm3: false, perm4: false });

function resetGrant(): void {
  grantForm.grant = { ...grantBase.value };
}

/** 门槛值只是提示文案，第一次打开弹窗时拉一次站点设置就够了 */
const gateMap = ref<Record<string, string>>({});

function gateText(settingKey: string): string {
  const raw = gateMap.value[settingKey];
  if (raw === undefined) return '站点门槛未读取';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '站点门槛未读取';
  return n >= 5 ? '站点门槛：已对所有人关闭' : `站点门槛：L${n} ${LEVEL_LABEL[n] ?? ''}及以上`;
}

/** 他的等级本来就跨过这道门槛时提示一句，免得超管重复开 */
function coveredByLevel(settingKey: string): boolean {
  const n = Number(gateMap.value[settingKey]);
  return Number.isFinite(n) && n < 5 && grantForm.level >= n;
}

function grantedKeys(row: AdminUserRow): (keyof DriveGrant)[] {
  return (Object.keys(DRIVE_GRANT_LABEL) as (keyof DriveGrant)[]).filter((key) => row.driveGrant[key]);
}

async function fillGrant(row: AdminUserRow): Promise<void> {
  grantForm.uid = row.uid;
  grantForm.nickname = row.nickname;
  grantForm.level = row.level;
  grantForm.grant = { ...row.driveGrant };
  grantBase.value = { ...row.driveGrant };
  grantForm.open = true;
  if (Object.keys(gateMap.value).length) return;
  try {
    gateMap.value = Object.fromEntries((await listSettings()).map((s) => [s.key, s.value]));
  } catch {
    // 拉不到门槛照样能提交，后端才是权限的收口
  }
}

async function submitGrant(): Promise<void> {
  if (!(await askReauth(`保存「${grantForm.nickname}」的文件权限授权`))) return;
  busy.value = true;
  try {
    await updateUserDriveGrants(grantForm.uid, grantForm.grant);
    ElMessage.success(`已更新「${grantForm.nickname}」的文件权限授权`);
    grantForm.open = false;
    await loadUsers();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

// ---------------- D21：功能位三态授权 ----------------

/** 把整份 FeatureGrant 展平成每个键一个值的对象；缺键按 inherit 处理 */
function grantToModes(grant: FeatureGrant | undefined): Record<CapKey, CapMode> {
  const base = {} as Record<CapKey, CapMode>;
  for (const key of CAP_KEYS) base[key] = grant?.[key] ?? 'inherit';
  return base;
}

/** 模式 → 返回的实际值（保留位 disabled 状态不算） */
function disabledCapForLevel(key: CapKey, rowLevel: UserLevel): boolean {
  return RESERVED_CAPS.includes(key) && rowLevel !== Level.SuperAdmin;
}

const featureForm = reactive({
  open: false,
  uid: 0,
  nickname: '',
  level: 1 as UserLevel,
  modes: grantToModes(undefined),
});

/** 功能位弹窗打开那一刻的 11 个模式，「重置」回到这里 */
const featureBase = ref<Record<CapKey, CapMode>>(grantToModes(undefined));

function resetFeature(): void {
  featureForm.modes = { ...featureBase.value };
}

async function fillFeature(row: AdminUserRow): Promise<void> {
  featureForm.uid = row.uid;
  featureForm.nickname = row.nickname;
  featureForm.level = row.level;
  featureForm.modes = grantToModes(row.featureGrant);
  featureBase.value = { ...featureForm.modes };
  featureForm.open = true;
}

async function submitFeature(): Promise<void> {
  if (!(await askReauth(`保存「${featureForm.nickname}」的功能位覆盖`))) return;
  busy.value = true;
  try {
    const body: FeatureGrant = {};
    for (const key of CAP_KEYS) {
      const mode = featureForm.modes[key];
      if (mode === 'on' || mode === 'off') body[key] = mode;
    }
    await updateUserFeatureGrants(featureForm.uid, body);
    ElMessage.success(`已更新「${featureForm.nickname}」的功能位授权`);
    featureForm.open = false;
    await loadUsers();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

function fillTemp(row?: AdminTempRow): void {
  tempForm.mode = row ? 'edit' : 'create';
  tempForm.tempId = row?.tempId ?? 0;
  tempForm.displayName = row?.displayName ?? '';
  tempForm.days = 14;
  tempForm.quotaGb = Number(((row?.spaceQuota ?? GB) / GB).toFixed(2));
  tempForm.flags = { ...(row?.flags ?? { ...tempForm.flags }) };
  tempForm.albumIds = [...(row?.albumIds ?? [])];
  tempForm.folderIds = [...(row?.folderIds ?? [])];
  // D22: L4 credential editing
  tempForm.code = row?.code ?? '';
  tempForm.originCode = row?.code ?? '';
  tempForm.password = '';
  tempForm.confirmPassword = '';
  tempBase.value = {
    displayName: tempForm.displayName,
    days: tempForm.days,
    quotaGb: tempForm.quotaGb,
    flags: { ...tempForm.flags },
    albumIds: [...tempForm.albumIds],
    folderIds: [...tempForm.folderIds],
    code: tempForm.code,
  };
  tempForm.open = true;
  void loadPools();
}

function resetTemp(): void {
  tempForm.displayName = tempBase.value.displayName;
  tempForm.days = tempBase.value.days;
  tempForm.quotaGb = tempBase.value.quotaGb;
  tempForm.flags = { ...tempBase.value.flags };
  tempForm.albumIds = [...tempBase.value.albumIds];
  tempForm.folderIds = [...tempBase.value.folderIds];
  tempForm.code = tempBase.value.code;
  tempForm.password = '';
  tempForm.confirmPassword = '';
}

function tempPasswordError(): string {
  if (!tempForm.password && !tempForm.confirmPassword) return '';
  if (tempForm.password.length < 6) return '登录密码至少 6 位';
  if (tempForm.password !== tempForm.confirmPassword) return '两次输入的密码不一致';
  return '';
}

async function submitTemp(): Promise<void> {
  // D22: validate passwords when L4 is editing credentials
  if (tempForm.mode === 'edit' && session.level === 4 && (tempForm.password || tempForm.confirmPassword)) {
    const pwdErr = tempPasswordError();
    if (pwdErr) {
      ElMessage.error(pwdErr);
      return;
    }
  }

  const spaceQuota = Math.round(tempForm.quotaGb * GB);
  if (!(await askReauth(`${tempForm.mode === 'create' ? '新建' : '编辑'}临时账号「${tempForm.displayName}」`))) return;
  busy.value = true;
  try {
    if (tempForm.mode === 'create') {
      const created = await createTemp({
        displayName: tempForm.displayName,
        days: tempForm.days,
        flags: tempForm.flags,
        albumIds: tempForm.albumIds,
        folderIds: tempForm.folderIds,
        spaceQuota,
      });
      await ElMessageBox.alert(
        `帐户ID ${created.code}，把它连同口令交给对方即可（口令由创建者另行约定）；系统已在「拍展」下建好同名目录，就是他的取图目录。`,
        '临时账号已创建',
        { type: 'success' },
      ).catch(() => undefined);
    } else {
      // Edit mode: first update basic info
      await updateTemp(tempForm.tempId, {
        displayName: tempForm.displayName,
        flags: tempForm.flags,
        albumIds: tempForm.albumIds,
        folderIds: tempForm.folderIds,
        spaceQuota,
      });

      // D22: then update credentials if L4 changed them
      if (session.level === 4 && (tempForm.code !== tempForm.originCode || tempForm.password)) {
        // Confirm code change with warning about directory rename and re-login
        if (tempForm.code !== tempForm.originCode) {
          await ElMessageBox.confirm(
            `更改帐户ID后：\n1. 「拍展」下的共享目录名将同步更新\n2. 旧 ID 立即失效，需用新 ID + 新密码重新登录\n3. 审计日志将记录此操作`,
            '确认更改帐户ID',
            { type: 'warning', confirmButtonText: '确定更改', cancelButtonText: '取消' },
          ).catch(() => {
            throw new Error('CANCELLED');
          });
        }

        await updateTempCredentials(tempForm.tempId, {
          code: tempForm.code !== tempForm.originCode ? tempForm.code : undefined,
          password: tempForm.password || undefined,
        });
      }

      ElMessage.success('临时账号已更新');
    }
    tempForm.open = false;
    await loadTemps();
  } catch (err) {
    if ((err as Error)?.message === 'CANCELLED') {
      // User cancelled credential change — do nothing
    } else {
      ElMessage.error(errorText(err));
    }
  } finally {
    busy.value = false;
    endReauth();
  }
}

async function renew(row: AdminTempRow, days: number): Promise<void> {
  if (!(await askReauth(`${days > 0 ? '续期' : '缩短'}「${row.displayName}」的有效期`))) return;
  busy.value = true;
  try {
    await updateTemp(row.tempId, { addDays: days });
    ElMessage.success(days > 0 ? `已续期 ${days} 天` : '有效期已调整');
    await loadTemps();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

async function destroy(row: AdminTempRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `注销后「${row.displayName}」手里的令牌立即失效（真接口写 Redis 黑名单）。`,
    '注销临时账号',
    { type: 'warning', confirmButtonText: '确定注销', cancelButtonText: '取消' },
  ).catch(() => false);
  if (!confirmed) return;
  if (!(await askReauth(`注销临时账号「${row.displayName}」`))) return;
  busy.value = true;
  try {
    await destroyTemp(row.tempId);
    ElMessage.success('已注销');
    await loadTemps();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busy.value = false;
    endReauth();
  }
}

onMounted(loadTab);
</script>

<template>
  <section>
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">成员与临时账号</h2>
        <p class="pk-muted">
          编辑页一次开放等级／职务／配额／状态与口令，口令留空即不改；行内「重置口令」是同一接口的快捷入口。
          L3 只能操作 L1／L2 且看不到 L4，删除账号与「网盘授权」仅超管可用——后者单独给某个人开某一档文件权限（规则
          13），不动站点门槛。临时账号的五个开关与白名单每次请求都重读。任何改动提交前都要填一次当前账号的登录口令
          （PRD 6.1 / D34），弹窗里的「重置」只回到打开时的值。
        </p>
      </div>
      <el-button
        type="primary"
        size="small"
        @click="tab === 'users' ? fillUser() : fillTemp()"
      >
        {{ tab === 'users' ? '新建账号' : '新建临时账号' }}
      </el-button>
    </div>

    <el-tabs v-model="tab" class="pk-admin__tabs" @tab-change="loadTab">
      <el-tab-pane label="成员" name="users" />
      <el-tab-pane label="临时账号" name="temps" />
    </el-tabs>

    <template v-if="tab === 'users'">
      <div class="pk-admin__toolbar">
        <el-select v-model="userQuery.level" size="small" class="pk-admin__sel" placeholder="全部等级" clearable @change="loadUsers">
          <el-option v-for="l in [1, 2, 3, 4]" :key="l" :value="l" :label="LEVEL_LABEL[l]" />
        </el-select>
        <el-input
          v-model="userQuery.keyword"
          size="small"
          class="pk-admin__kw"
          placeholder="账号／昵称／职务"
          clearable
          @keyup.enter="loadUsers"
          @clear="loadUsers"
        />
        <el-button size="small" @click="loadUsers">查询</el-button>
        <span class="pk-muted">L3 视角会过滤掉超管行，这是有意的反枚举设计。</span>
      </div>

      <div class="pk-admin__table-wrap">
        <el-table v-loading="loading" :data="users" size="small" border>
          <el-table-column prop="uid" label="UID" width="58" />
          <el-table-column label="账号" min-width="150">
            <template #default="{ row }">
              {{ row.nickname }}
              <span class="pk-muted pk-admin__sub">
                @{{ row.username }}<template v-if="row.position"> · {{ row.position }}</template>
              </span>
            </template>
          </el-table-column>
          <el-table-column label="等级" width="106">
            <template #default="{ row }">
              <span :class="['pk-chip', row.level >= 3 ? '' : 'pk-chip--ghost']">{{ row.levelName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="网盘授权" min-width="150">
          <template #default="{ row }">
            <span v-for="key in grantedKeys(row)" :key="key" class="pk-chip pk-chip--warn">
              {{ DRIVE_GRANT_LABEL[key] }}
            </span>
            <span v-if="!grantedKeys(row).length" class="pk-muted">按等级</span>
          </template>
        </el-table-column>
        <el-table-column label="功能授权" min-width="180">
          <template #default="{ row }">
            <template v-if="row.capsOverridden?.length">
              <el-tooltip
                v-for="(k, idx) in row.capsOverridden"
                :key="k"
                :content="CAP_DESC[(k as CapKey) ?? 'download']"
                placement="top"
              >
                <span class="pk-chip pk-chip--warn">{{ CAP_LABEL[(k as CapKey) ?? 'download'] }}</span>
              </el-tooltip>
            </template>
            <span v-else class="pk-muted">按等级</span>
          </template>
        </el-table-column>
        <el-table-column label="空间" width="180">
          <template #default="{ row }">
            <div class="pk-admin__inline">
              <span class="pk-muted pk-admin__sub">
                {{ formatBytes(row.usedSpace) }} / {{ row.spaceQuota ? formatBytes(row.spaceQuota) : '不限' }}
              </span>
            </div>
            <el-progress
              :percentage="row.spaceQuota ? Math.min(100, Math.round((row.usedSpace / row.spaceQuota) * 100)) : 0"
              :stroke-width="5"
              :show-text="false"
            />
          </template>
        </el-table-column>
        <el-table-column label="相册／图片" width="104">
          <template #default="{ row }">{{ row.albumCount }} / {{ row.imageCount }}</template>
        </el-table-column>
        <el-table-column label="最近登录" width="126">
          <template #default="{ row }"><span class="pk-muted">{{ formatDate(row.lastLogin) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="78">
          <template #default="{ row }">
            <span :class="['pk-chip', row.disabled ? 'pk-chip--warn' : 'pk-chip--ghost']">
              {{ row.disabled ? '已禁用' : '正常' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="360" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="fillUser(row)">编辑</el-button>
            <el-button size="small" text @click="doResetPassword(row)">重置口令</el-button>
            <el-button size="small" text @click="quickDisable(row)">
              {{ row.disabled ? '启用' : '禁用' }}
            </el-button>
            <el-button v-if="session.level === 4" size="small" text @click="fillGrant(row)">网盘授权</el-button>
            <el-button v-if="session.level === 4" size="small" text @click="fillFeature(row)">功能授权</el-button>
            <el-button v-if="session.level === 4" size="small" text type="danger" @click="doDeleteUser(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </template>

    <template v-else>
      <div class="pk-admin__toolbar">
        <el-switch v-model="tempQuery.onlyAlive" size="small" active-text="只看未过期" @change="loadTemps" />
        <el-input
          v-model="tempQuery.keyword"
          size="small"
          class="pk-admin__kw"
          placeholder="帐户ID／显示名"
          clearable
          @keyup.enter="loadTemps"
          @clear="loadTemps"
        />
        <el-button size="small" @click="loadTemps">查询</el-button>
        <span class="pk-muted">过期时间双闸门：令牌 exp 与库内 expires_at 都要过。</span>
      </div>

      <div class="pk-admin__table-wrap">
        <el-table v-loading="loading" :data="temps" size="small" border>
          <el-table-column prop="tempId" label="ID" width="58" />
          <el-table-column label="临时账号" min-width="170">
            <template #default="{ row }">
              {{ row.displayName }}
              <span class="pk-admin__mono pk-admin__sub">{{ row.code }}</span>
            </template>
          </el-table-column>
        <el-table-column prop="ownerName" label="归属" width="126" />
        <el-table-column label="到期" width="132">
          <template #default="{ row }">
            <span class="pk-muted">{{ formatDate(row.expiresAt) }}</span>
            <span v-if="row.expired" class="pk-chip pk-chip--warn pk-admin__sub">已过期</span>
          </template>
        </el-table-column>
        <el-table-column label="开关" min-width="200">
          <template #default="{ row }">
            <span v-for="key in EDITABLE_FLAG_KEYS" :key="key" :class="['pk-chip', (row.flags as TempFlags)[key] ? '' : 'pk-chip--ghost']">
              {{ FLAG_LABEL[key] }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="白名单" width="112">
          <template #default="{ row }">
            <span class="pk-muted">相册 {{ row.albumIds.length }} · 目录 {{ row.folderIds.length }}</span>
          </template>
        </el-table-column>
        <el-table-column label="空间" width="140">
          <template #default="{ row }">
            <span class="pk-muted pk-admin__sub">
              {{ formatBytes(row.usedSpace) }} / {{ formatBytes(row.spaceQuota) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="232" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="fillTemp(row)">编辑</el-button>
            <el-button size="small" text @click="renew(row, 7)">+7天</el-button>
            <el-button size="small" text @click="renew(row, -7)">−7天</el-button>
            <el-button size="small" text type="danger" @click="destroy(row)">注销</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </template>

    <el-dialog v-model="userForm.open" :title="userForm.mode === 'create' ? '新建成员' : '编辑成员'" width="min(480px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="账号名">
          <el-input
            v-model="userForm.username"
            :disabled="userForm.mode === 'edit' && session.level !== 4"
            maxlength="32"
            placeholder="3~32 位字母数字与 _.-"
          />
          <p v-if="userForm.mode === 'edit' && session.level === 4" class="pk-muted pk-admin__hint">
            仅超级管理员可修改账号名，更改后需要用新账号名重新登录。
          </p>
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="userForm.nickname" maxlength="30" />
        </el-form-item>
        <el-form-item label="职务">
          <el-input v-model="userForm.position" maxlength="20" placeholder="如 后期主管，用于顶栏欢迎语与共享文件夹标签" />
        </el-form-item>
        <el-form-item label="等级">
          <el-select v-model="userForm.level" class="pk-admin__wide">
            <el-option
              v-for="l in levelOptions"
              :key="l"
              :value="l"
              :label="`${LEVEL_LABEL[l]}${l === 4 ? '（转让需二次确认）' : ''}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="空间配额（GB）">
          <el-input-number v-model="userForm.quotaGb" :min="0" :step="1" :precision="2" class="pk-admin__wide" />
        </el-form-item>
        <el-form-item :label="userForm.mode === 'create' ? '初始口令' : '新口令'">
          <el-input
            v-model="userForm.password"
            type="password"
            show-password
            autocomplete="new-password"
            maxlength="64"
            :placeholder="userForm.mode === 'create' ? '至少 8 位，交给本人后由其自行修改' : '留空表示不修改口令'"
          />
        </el-form-item>
        <el-form-item v-if="userForm.mode === 'create' || userForm.password" label="确认口令">
          <el-input
            v-model="userForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            maxlength="64"
            placeholder="再输入一次"
          />
        </el-form-item>
        <p class="pk-muted pk-admin__hint">
          口令走 bcrypt(cost 12) 存储，响应体与审计日志都不含明文（PRD 12.11）。演示层登录仍统一是 demo1234。
        </p>
        <el-form-item v-if="userForm.mode === 'edit'" label="账号状态">
          <el-switch v-model="userForm.disabled" active-text="禁用" />
          <p class="pk-muted pk-admin__hint">禁用会清掉能力位，不能禁自己，也不能禁唯一超管。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userForm.open = false">取消</el-button>
        <el-button @click="resetUser">重置</el-button>
        <el-button type="primary" :loading="busy" @click="submitUser">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="grantForm.open" :title="`网盘授权 · ${grantForm.nickname}`" width="min(520px, 94vw)">
      <p class="pk-muted pk-admin__hint">
        站点门槛是按等级卡住所有人的，这里只给<b>这一个人</b>单独开某一档文件权限：开了他就绕过那一档门槛，别人不受影响。
      </p>
      <div v-for="item in GRANT_META" :key="item.key" class="pk-admin__grant">
        <el-switch v-model="grantForm.grant[item.key]" size="small" :active-text="DRIVE_GRANT_LABEL[item.key]" />
        <div>
          <p class="pk-muted">{{ item.desc }}</p>
          <p class="pk-muted">
            {{ gateText(item.settingKey) }}
            <span v-if="coveredByLevel(item.settingKey)">· 他的等级本来就够，开不开都一样</span>
          </p>
        </div>
      </div>
      <p class="pk-muted pk-admin__hint">
        垃圾箱（规则 12）与爬虫（规则 11）不参与个人授权，仍然只有超管能进。开启文件权限3/4
        时系统当场补建对应的共享／私人目录；关掉某一档不会回收已经建好的目录，要收回得自己去网盘里删。
      </p>
      <template #footer>
        <el-button @click="grantForm.open = false">取消</el-button>
        <el-button @click="resetGrant">重置</el-button>
        <el-button type="primary" :loading="busy" @click="submitGrant">保存授权</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="featureForm.open" :title="`功能授权 · ${featureForm.nickname}`" width="min(620px, 94vw)">
      <p class="pk-muted pk-admin__hint">
        PRD 6.4 / D21：超管按人逐项覆盖 11 个功能能力位。<b>强制关</b> 优先于等级默认值（L4 给自己关也拦），
        <b>强制开</b> 只放动作、不放档位可见性。缺键表示跟随等级，JSON 不落 inherit。
      </p>
      <div class="pk-admin__feature">
        <div v-for="key in CAP_KEYS" :key="key" class="pk-admin__grant">
          <el-select
            v-model="featureForm.modes[key]"
            size="small"
            style="width: 140px"
            :disabled="disabledCapForLevel(key, featureForm.level)"
          >
            <el-option label="跟随等级" value="inherit" />
            <el-option label="强制开" value="on" />
            <el-option label="强制关" value="off" />
          </el-select>
          <div>
            <p class="pk-muted"><b>{{ CAP_LABEL[key] }}</b>：{{ CAP_DESC[key] }}</p>
            <p v-if="disabledCapForLevel(key, featureForm.level)" class="pk-muted">
              保留位：只能归超管，L{{ featureForm.level }} 无法开此位
            </p>
          </div>
        </div>
      </div>
      <p class="pk-muted pk-admin__hint">
        保留位 <b>writeSiteSettings</b> 不可下放给 L1–L3；唯一在职超管的 <b>adminConsole / writeSiteSettings</b> 不可关，
        否则再没人能进后台。改完最迟 60 秒全站生效（能力位不进 JWT，守卫每次现取）。
      </p>
      <template #footer>
        <el-button @click="featureForm.open = false">取消</el-button>
        <el-button @click="resetFeature">重置</el-button>
        <el-button type="primary" :loading="busy" @click="submitFeature">保存授权</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="tempForm.open"
      :title="tempForm.mode === 'create' ? '新建临时账号' : '编辑临时账号'"
      width="min(560px, 94vw)"
    >
      <el-form label-position="top">
        <el-form-item label="显示名">
          <el-input v-model="tempForm.displayName" maxlength="30" placeholder="一般填 coser 名" />
        </el-form-item>
        <div class="pk-admin__row">
          <el-form-item v-if="tempForm.mode === 'create'" label="有效期（天）" class="pk-admin__col">
            <el-input-number v-model="tempForm.days" :min="1" :max="365" class="pk-admin__wide" />
          </el-form-item>
          <el-form-item label="空间配额（GB）" class="pk-admin__col">
            <el-input-number v-model="tempForm.quotaGb" :min="0" :step="1" :precision="2" class="pk-admin__wide" />
          </el-form-item>
        </div>
        <el-form-item label="权限开关">
          <div class="pk-admin__flags">
            <el-switch
              v-for="key in EDITABLE_FLAG_KEYS"
              :key="key"
              v-model="tempForm.flags[key]"
              size="small"
              :active-text="FLAG_LABEL[key]"
            />
          </div>
        </el-form-item>
        <el-form-item label="可访问相册">
          <el-select v-model="tempForm.albumIds" multiple collapse-tags class="pk-admin__wide" placeholder="留空表示不给相册">
            <el-option v-for="a in albumOptions" :key="a.id" :value="a.id" :label="a.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="可访问目录">
          <el-select v-model="tempForm.folderIds" multiple collapse-tags class="pk-admin__wide" placeholder="祖先命中即放行子孙">
            <el-option v-for="f in folderOptions" :key="f.id" :value="f.id" :label="f.label" />
          </el-select>
        </el-form-item>
        <!-- D22：仅 L4 在编辑模式可见的凭据区 -->
        <template v-if="tempForm.mode === 'edit' && session.level === 4">
          <el-divider content-position="left">登录凭据（仅超管可改）</el-divider>
          <el-form-item label="帐户ID">
            <el-input
              v-model="tempForm.code"
              maxlength="24"
              placeholder="4~24 位大写字母、数字与短横线"
              @input="(val: string) => { tempForm.code = val.replace(/[^A-Z0-9-]/g, '').toUpperCase(); }"
            />
            <p class="pk-muted pk-admin__hint">更改后「拍展」下的共享目录名将同步更新，旧 ID 立即失效。</p>
          </el-form-item>
          <el-form-item label="新口令">
            <el-input
              v-model="tempForm.password"
              type="password"
              show-password
              autocomplete="new-password"
              maxlength="64"
              placeholder="留空表示不改口令"
            />
          </el-form-item>
          <el-form-item v-if="tempForm.password" label="确认口令">
            <el-input
              v-model="tempForm.confirmPassword"
              type="password"
              show-password
              autocomplete="new-password"
              maxlength="64"
              placeholder="再输入一次"
            />
            <p v-if="tempPasswordError()" class="pk-chip--warn pk-admin__hint">{{ tempPasswordError() }}</p>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="tempForm.open = false">取消</el-button>
        <el-button @click="resetTemp">重置</el-button>
        <el-button type="primary" :loading="busy" @click="submitTemp">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pk-admin__tabs {
  margin-top: 6px;
}

.pk-admin__sel {
  width: 130px;
}

.pk-admin__kw {
  width: 180px;
}

.pk-admin__sub {
  font-size: 11px;
  margin-left: 4px;
  color: var(--pk-muted);
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

.pk-admin__flags {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.pk-admin__grant {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--pk-line);
}

.pk-admin__grant p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
</style>
