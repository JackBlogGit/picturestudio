<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errorText } from '@/api/client';
import { VISIBILITY_LABEL } from '@/types/api';
import { formatBytes, formatDate, percent } from '@/utils/format';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const busy = ref(false);
const pwd = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });

const profile = computed(() => session.profile);

const CAPABILITY_ROWS = [
  { key: 'download', label: '下载原图' },
  { key: 'zip', label: '批量打包下载' },
  { key: 'upload', label: '上传返图' },
  { key: 'editOwn', label: '编辑本人资源' },
  { key: 'editAny', label: '编辑任意资源' },
  { key: 'delete', label: '删除资源' },
  { key: 'changeVisibility', label: '调整可见档位' },
  { key: 'canSetPublic', label: '可设为公开' },
  { key: 'shareLink', label: '生成返图链接' },
  { key: 'adminConsole', label: '进入后台' },
  { key: 'writeSiteSettings', label: '修改站点配置' },
] as const;

const FLAG_ROWS = [
  { key: 'preview', label: '预览' },
  { key: 'download', label: '下载' },
  { key: 'editTag', label: '打标签' },
] as const;

const quota = computed(() => {
  const p = profile.value;
  if (!p) return { used: 0, total: 0, pct: 0 };
  return { used: p.usedSpace, total: p.spaceQuota, pct: percent(p.usedSpace, p.spaceQuota) };
});

async function changePassword(): Promise<void> {
  if (pwd.newPassword.length < 8) {
    ElMessage.warning('新密码至少 8 位');
    return;
  }
  if (pwd.newPassword !== pwd.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致');
    return;
  }
  busy.value = true;
  try {
    await api.put('/auth/password', { oldPassword: pwd.oldPassword, newPassword: pwd.newPassword });
    ElMessage.success('密码已更新');
    pwd.oldPassword = '';
    pwd.newPassword = '';
    pwd.confirmPassword = '';
  } catch (err) {
    ElMessage.error(errorText(err, '密码修改失败'));
  } finally {
    busy.value = false;
  }
}

function signOut(): void {
  void session.logout();
}
</script>

<template>
  <section v-if="profile" class="pk-me">
    <div class="pk-card pk-me__main">
      <div class="pk-me__head">
        <div class="pk-avatar">{{ (profile.kind === 'user' ? profile.nickname : profile.displayName).slice(0, 1) }}</div>
        <div>
          <h2 class="pk-page-title">{{ session.displayName }}</h2>
          <p class="pk-muted">
            <template v-if="profile.kind === 'user'">
              {{ profile.levelName }} · 账号 {{ profile.username }} · UID {{ profile.uid }}
            </template>
            <template v-else>
              游客 · 由 UID {{ profile.ownerUid }} 创建 · 到期 {{ formatDate(profile.expiresAt) }}
            </template>
          </p>
        </div>
      </div>

      <div class="pk-quota">
        <div class="pk-quota__row">
          <span>存储空间</span>
          <span class="pk-muted">
            {{ formatBytes(quota.used) }}
            <template v-if="quota.total"> / 配额 {{ formatBytes(quota.total) }}</template>
            <template v-else>（不限量）</template>
          </span>
        </div>
        <el-progress :percentage="quota.pct" :show-text="false" :stroke-width="8" />
      </div>

      <template v-if="profile.kind === 'temp'">
        <h3 class="pk-block-title">权限开关</h3>
        <div class="pk-flags">
          <el-tag v-for="row in FLAG_ROWS" :key="row.key" :type="profile.flags[row.key] ? 'success' : 'info'" effect="plain">
            {{ row.label }}{{ profile.flags[row.key] ? ' ✓' : ' ✕' }}
          </el-tag>
        </div>
        <h3 class="pk-block-title">授权范围</h3>
        <p class="pk-muted">
          相册 {{ profile.allowedAlbumIds.length ? profile.allowedAlbumIds.join(' / ') : '无' }} ·
          网盘目录 {{ profile.allowedFolderIds.length ? profile.allowedFolderIds.join(' / ') : '无' }}
        </p>
      </template>

      <template v-else>
        <h3 class="pk-block-title">当前能力位（服务端下发）</h3>
        <div class="pk-caps">
          <div v-for="row in CAPABILITY_ROWS" :key="row.key" class="pk-caps__item">
            <span :class="profile.capabilities[row.key] ? 'pk-dot pk-dot--on' : 'pk-dot'"></span>
            <span>{{ row.label }}</span>
            <el-tooltip
              v-if="profile.kind === 'user' && profile.capsOverridden.includes(row.key)"
              :content="`超管已覆盖此位（${profile.capabilities[row.key] ? '强制开' : '强制关'}），不跟随等级默认值`"
              placement="top"
            >
              <span class="pk-chip pk-chip--warn pk-caps__badge">超管授权</span>
            </el-tooltip>
          </div>
        </div>
        <h3 class="pk-block-title">可见档位上限</h3>
        <p class="pk-muted">
          {{ session.visibilityOptions.map((v) => VISIBILITY_LABEL[v]).join(' ／ ') }}
        </p>
      </template>

      <div class="pk-me__actions">
        <router-link to="/albums"><el-button>继续浏览相册</el-button></router-link>
        <el-button type="danger" plain @click="signOut">退出登录</el-button>
      </div>
    </div>

    <div v-if="profile.kind === 'user'" class="pk-card pk-me__side">
      <h3 class="pk-block-title">修改密码</h3>
      <el-form label-position="top">
        <el-form-item label="当前密码">
          <el-input v-model="pwd.oldPassword" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwd.newPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pwd.confirmPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-button type="primary" :loading="busy" block @click="changePassword">保存</el-button>
      </el-form>
      <p class="pk-muted pk-tip">口令用 bcrypt(cost 12) 存储，接口响应体里不含任何密码字段（PRD 12.1 / 12.11）。</p>
    </div>
  </section>

  <el-empty v-else description="请先登录" />
</template>

<style scoped>
.pk-me {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(260px, 1fr);
  gap: 14px;
  align-items: start;
}

@media (max-width: 860px) {
  .pk-me {
    grid-template-columns: 1fr;
  }
}

.pk-me__main,
.pk-me__side {
  padding: 18px 20px 22px;
}

.pk-me__head {
  display: flex;
  gap: 14px;
  align-items: center;
}

.pk-avatar {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--pk-brand), #b96bff);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 20px;
  font-weight: 700;
}

.pk-me__head .pk-muted {
  margin: 4px 0 0;
  font-size: 13px;
}

.pk-quota {
  margin-top: 18px;
}

.pk-quota__row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 6px;
}

.pk-block-title {
  font-size: 14px;
  margin: 20px 0 8px;
}

.pk-flags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pk-caps {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px 12px;
}

.pk-caps__item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.pk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d3d6e2;
  flex: none;
}

.pk-dot--on {
  background: #2ec27e;
}

.pk-me__actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
}

.pk-tip {
  font-size: 12px;
  line-height: 1.7;
  margin: 12px 0 0;
}
</style>
