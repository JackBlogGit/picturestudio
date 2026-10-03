<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { USE_MOCK } from '@/api/client';
import { resetSessionRestore } from '@/router';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

/** 工作台顶栏只留三段（logo / 欢迎语 / 身份徽标），站级导航让位给宫格（PRD 8.5） */
const workbar = computed(() => route.meta.workbar === true);

onMounted(() => {
  void session.bootstrap();
});

const DEMO_IDENTITIES = [
  { token: 'mock.user.4', label: 'L1 见习 · 小满', hint: '不能批量、不能设公开、禁下载' },
  { token: 'mock.user.3', label: 'L2 成员 · 阿澄', hint: '可批量与下载，仅编辑本人上传' },
  { token: 'mock.user.2', label: 'L3 管理员 · 白泽', hint: '可见 admin 档，可编辑任意' },
  { token: 'mock.user.1', label: 'L4 超管 · 夜刃', hint: '可见 private，能改站点配置' },
  { token: 'mock.temp.301', label: '临时账号 · 柚子', hint: '白名单相册，下载开关为关' },
  { token: 'mock.temp.302', label: '临时账号 · 青野', hint: '后期已完成，取图清单有货' },
];

const navItems = computed(() => [
  session.loggedIn ? { to: '/home', label: '工作台' } : { to: '/', label: '首页' },
  { to: '/albums', label: '相册' },
  ...(session.loggedIn && !session.isTemp ? [{ to: '/drive', label: '网盘' }] : []),
  // 手绘稿 21 / 22：入口页与任务列表只认正式成员（D9 里 L1 也能开号，只是强制降权），临时账号与游客不给链接
  ...(session.isMember ? [{ to: '/entry', label: '入口' }, { to: '/tasks', label: '任务' }] : []),
  ...(session.caps.adminConsole ? [{ to: '/admin', label: '后台' }] : []),
  ...(session.loggedIn ? [{ to: '/me', label: '我的' }] : []),
]);

async function switchIdentity(token: string): Promise<void> {
  await session.impersonate(token);
  ElMessage.success(`已切换为 ${session.displayName}`);
  await router.push(session.loggedIn ? '/home' : '/');
}

async function signOut(): Promise<void> {
  await session.logout();
  resetSessionRestore();
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="pk-shell">
    <header class="pk-header">
      <div class="pk-header__inner">
        <router-link class="pk-logo" to="/">
          <img class="pk-logo__mark" src="/brand/logo-mark.png" alt="" />
          <span class="pk-logo__word">
            <strong>皮克社工作室</strong>
            <em>Picture</em>
          </span>
        </router-link>

        <p v-if="workbar" class="pk-welcome">{{ session.welcome }}</p>
        <nav v-else class="pk-nav">
          <router-link v-for="item in navItems" :key="item.to" :to="item.to">{{ item.label }}</router-link>
          <!-- 两个上传入口都只认 caps.upload：D27 起这一位不给临时账号，它只能取图 -->
          <router-link v-if="session.caps.upload" to="/drive?tab=upload">传文件</router-link>
          <router-link v-if="session.caps.upload" to="/albums?tab=upload">拍展传图</router-link>
        </nav>

        <div class="pk-header__user">
          <el-dropdown v-if="USE_MOCK" trigger="click" @command="switchIdentity">
            <el-button size="small" text>演示身份</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="item in DEMO_IDENTITIES" :key="item.token" :command="item.token">
                  <div class="pk-demo-item">
                    <strong>{{ item.label }}</strong>
                    <span class="pk-muted">{{ item.hint }}</span>
                  </div>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <el-dropdown v-if="session.loggedIn" trigger="click" @command="signOut">
            <span class="pk-identity">{{ session.identityLabel }}</span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ session.displayName }}</el-dropdown-item>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button v-else size="small" type="primary" @click="router.push('/login')">登录</el-button>
        </div>
      </div>
    </header>

    <main class="pk-main">
      <router-view v-slot="{ Component }">
        <Transition name="pk-fade" mode="out-in">
          <component :is="Component" />
        </Transition>
      </router-view>
    </main>

    <footer class="pk-footer">
      皮克社返图平台 · 前端演示
      <template v-if="USE_MOCK">（mock 模式：数据在内存里，刷新即重置，未连后端与数据库）</template>
    </footer>
  </div>
</template>

<style scoped>
.pk-header__user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pk-welcome {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 7px 14px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--pk-muted);
  background: var(--pk-card);
  border: 1px solid var(--pk-line);
  border-radius: 10px;
}

.pk-identity {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  background: var(--pk-card);
  border: 1px solid var(--pk-line);
  border-radius: 999px;
}

.pk-demo-item {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  padding: 2px 0;
}

.pk-demo-item .pk-muted {
  font-size: 12px;
}

.pk-fade-enter-active,
.pk-fade-leave-active {
  transition: opacity 0.18s ease;
}

.pk-fade-enter-from,
.pk-fade-leave-to {
  opacity: 0;
}
</style>
