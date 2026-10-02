<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { USE_MOCK } from '@/api/client';
import { errorText } from '@/api/error';
import { resetSessionRestore } from '@/router';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const tab = ref<'user' | 'temp'>('user');
const busy = ref(false);

const userForm = reactive({ username: '', password: '' });
const tempForm = reactive({ accessToken: '', password: '' });

const QUICK = [
  { label: 'L4 超管', username: 'admin' },
  { label: 'L3 管理员', username: 'baize' },
  { label: 'L2 成员', username: 'acheng' },
  { label: 'L1 见习', username: 'xiaoman' },
];

async function afterLogin(): Promise<void> {
  resetSessionRestore();
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/home';
  await router.push(redirect);
}

async function submitUser(): Promise<void> {
  busy.value = true;
  try {
    await session.login(userForm.username.trim(), userForm.password);
    ElMessage.success(`欢迎回来，${session.displayName}`);
    await afterLogin();
  } catch (err) {
    ElMessage.error(errorText(err, '登录失败'));
  } finally {
    busy.value = false;
  }
}

async function submitTemp(): Promise<void> {
  busy.value = true;
  try {
    await session.loginTemp(tempForm.accessToken.trim(), tempForm.password);
    ElMessage.success(`已进入 ${session.displayName}`);
    await afterLogin();
  } catch (err) {
    ElMessage.error(errorText(err, '登录失败'));
  } finally {
    busy.value = false;
  }
}

function fill(user: (typeof QUICK)[number]): void {
  userForm.username = user.username;
  userForm.password = 'demo1234';
}
</script>

<template>
  <section class="pk-login">
    <div class="pk-card pk-login__card">
      <div class="pk-login__brand">
        <img class="pk-login__logo" src="/brand/logo-mark.png" alt="" />
        <div class="pk-login__wordmark">
          <strong>皮克社工作室</strong>
          <span>Picture</span>
        </div>
      </div>
      <h2 class="pk-page-title">登录</h2>
      <p class="pk-muted">成员账号由后台创建，本站点不开放注册。</p>

      <el-tabs v-model="tab">
        <el-tab-pane label="成员登录" name="user">
          <el-form label-position="top" @submit.prevent="submitUser">
            <el-form-item label="账号">
              <el-input v-model="userForm.username" placeholder="admin / baize / acheng / xiaoman" autocomplete="username" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input
                v-model="userForm.password"
                type="password"
                show-password
                autocomplete="current-password"
                @keyup.enter="submitUser"
              />
            </el-form-item>
            <el-button type="primary" :loading="busy" block @click="submitUser">进入</el-button>
          </el-form>

          <div v-if="USE_MOCK" class="pk-quick">
            <span class="pk-muted">演示一键填充：</span>
            <el-button v-for="item in QUICK" :key="item.username" size="small" text @click="fill(item)">
              {{ item.label }}
            </el-button>
          </div>
        </el-tab-pane>

        <el-tab-pane label="游客 / 返图链接" name="temp">
          <el-form label-position="top" @submit.prevent="submitTemp">
            <el-form-item label="帐户ID">
              <el-input v-model="tempForm.accessToken" placeholder="PK-2026-0913" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input
                v-model="tempForm.password"
                type="password"
                show-password
                autocomplete="current-password"
                @keyup.enter="submitTemp"
              />
            </el-form-item>
            <el-button type="primary" :loading="busy" block @click="submitTemp">进入</el-button>
            <p class="pk-muted pk-note">
              帐户ID 与口令由派发人在线下给你，就是「拍展／你的帐户ID」那个取图目录名。游客受帐户ID
              与到期时间双闸门约束，过期或注销后链接永久失效（PRD 12.6）。演示口令统一 demo1234。
            </p>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </div>
  </section>
</template>

<style scoped>
.pk-login {
  display: grid;
  place-items: center;
  padding-top: 28px;
}

.pk-login__card {
  width: min(440px, 100%);
  padding: 22px 24px 26px;
}

.pk-login__brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.pk-login__logo {
  height: 84px;
  width: auto;
}

.pk-login__wordmark {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.15;
}

.pk-login__wordmark strong {
  font-size: 19px;
  letter-spacing: 1px;
  color: #002a5e;
}

.pk-login__wordmark span {
  font-size: 11px;
  letter-spacing: 3px;
  color: #f5821f;
}

.pk-login__card .pk-muted {
  font-size: 13px;
}

.pk-quick {
  margin-top: 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 12px;
}

.pk-note {
  margin-top: 12px;
  line-height: 1.7;
}
</style>
