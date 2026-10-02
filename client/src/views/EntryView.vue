<script setup lang="ts">
/**
 * 三入口页（手绘稿 21）。登录后的第一屏只给三扇门：开临时账号、返图·视频、查看任务。
 * 门后能进什么是按身份裁的：注册与任务两扇门只认正式成员（D9 里 L1 也能开号，服务端强制降权），
 * 所以第三扇门只链到任务列表，管理入口留在列表页里按 caps 出现。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { Plus, Tickets, VideoCamera } from '@element-plus/icons-vue';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();

const doors = computed(() => [
  {
    key: 'temp-account',
    title: '开临时账号',
    hint: '给到场的 coser 开一个临时账号，帐户ID 就是他的取图目录',
    icon: Plus,
    to: '/guest/new',
    hidden: !session.isMember,
  },
  {
    key: 'deliver',
    title: '返图·视频',
    hint: '场照与成片传进相册；视频这类文件走网盘的「上传」标签',
    icon: VideoCamera,
    to: '/albums?tab=upload',
    hidden: !session.caps.upload,
  },
  {
    key: 'tasks',
    title: '查看任务',
    hint: '跟一下每个帐户ID 的前期、后期返图交没交',
    icon: Tickets,
    to: '/tasks',
    hidden: !session.isMember,
  },
]);

const visible = computed(() => doors.value.filter((door) => !door.hidden));
</script>

<template>
  <section class="pk-entry">
    <h1 class="pk-page-title">{{ session.welcome || '从这里进' }}</h1>
    <p class="pk-muted pk-entry__lead">三扇门对应返图这一天要办的三件事，看不见的门不会出现，而不是点了才知道没权限。</p>

    <div class="pk-entry__grid">
      <button
        v-for="door in visible"
        :key="door.key"
        type="button"
        class="pk-entry__door pk-card"
        @click="router.push(door.to)"
      >
        <span class="pk-entry__icon"><el-icon :size="30"><component :is="door.icon" /></el-icon></span>
        <span class="pk-entry__name">{{ door.title }}</span>
        <span class="pk-entry__hint">{{ door.hint }}</span>
      </button>
    </div>

    <p v-if="!visible.length" class="pk-muted pk-entry__lead">当前身份没有可用的入口，请从相册页浏览公开内容或登录。</p>
  </section>
</template>

<style scoped>
.pk-entry__lead {
  margin: 6px 0 18px;
  font-size: 12px;
}

.pk-entry__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.pk-entry__door {
  display: block;
  padding: 0;
  overflow: hidden;
  font: inherit;
  color: inherit;
  text-align: center;
  cursor: pointer;
  background: var(--pk-card);
  border: 1px solid var(--pk-line);
  border-radius: var(--pk-radius);
  box-shadow: var(--pk-shadow);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.pk-entry__door:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(31, 31, 41, 0.1);
}

.pk-entry__door:focus-visible {
  outline: 2px solid var(--pk-brand);
  outline-offset: 2px;
}

.pk-entry__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 7;
  background: var(--pk-brand-soft);
  color: var(--pk-brand);
}

.pk-entry__name {
  display: block;
  padding: 12px 8px 2px;
  font-size: 15px;
  font-weight: 700;
}

.pk-entry__hint {
  display: block;
  padding: 0 12px 14px;
  color: var(--pk-muted);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 820px) {
  .pk-entry__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
