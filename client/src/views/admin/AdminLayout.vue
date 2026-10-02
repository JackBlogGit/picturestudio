<script setup lang="ts">
/**
 * 后台骨架（PRD 8.2）。菜单只按能力位出现：L3 进得来看成员与相册，
 * 站点设置对 L3 只读、仅 L4 能写，这一点在设置页内部再收一次。
 */
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();

const MENUS = [
  { to: '/admin', label: '仪表盘' },
  { to: '/admin/albums', label: '相册管理' },
  { to: '/admin/members', label: '成员与临时账号' },
  { to: '/admin/tags', label: '标签库' },
  { to: '/admin/drive', label: '网盘管理' },
  { to: '/admin/shares', label: '返图链接' },
  { to: '/admin/logs', label: '日志审计' },
  { to: '/admin/settings', label: '站点设置' },
];

const writableSettings = computed(() => session.level === 4);
</script>

<template>
  <div class="pk-admin">
    <nav class="pk-card pk-admin__menu">
      <router-link
        v-for="item in MENUS"
        :key="item.to"
        :to="item.to"
        exact-active-class="pk-admin__on"
      >
        {{ item.label }}
      </router-link>
      <router-link to="/" class="pk-admin__back">返回前台</router-link>
    </nav>

    <div class="pk-admin__body">
      <p class="pk-muted pk-admin__who">
        当前身份 {{ session.displayName }}
        <template v-if="!writableSettings">· 站点设置为只读（PRD 6.1 仅超管可改核心配置）</template>
      </p>
      <router-view />
    </div>
  </div>
</template>

<style scoped>
.pk-admin__back {
  margin-top: 8px;
  border-top: 1px dashed var(--pk-line);
  padding-top: 12px;
}

.pk-admin__who {
  font-size: 12px;
  margin: 0 0 10px;
}
</style>
