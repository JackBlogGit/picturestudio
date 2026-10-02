<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { errorText } from '@/api/error';
import { resetSessionRestore } from '@/router';
import { cellsFor, type WorkCell } from '@/config/workbench';
import DestroyCountdown from '@/components/DestroyCountdown.vue';
import WorkGrid from '@/components/WorkGrid.vue';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();

const cells = computed(() => cellsFor(session.profile));
const expiresAt = computed(() => (session.profile?.kind === 'temp' ? session.profile.expiresAt : ''));
/** 倒计时归零到真实失效之间最长 5 分钟窗口，以接口 401 为准，这里不做兜底放行 */
const expired = computed(() => !!expiresAt.value && session.serverNow() >= Date.parse(expiresAt.value));

async function openCell(cell: WorkCell): Promise<void> {
  if (cell.danger) {
    await destroySelf();
    return;
  }
  if (cell.to) {
    await router.push(cell.to);
    return;
  }
  ElMessage.info(cell.pendingHint ?? `${cell.label}尚未开放`);
}

/** D15 危险格：手输帐户ID 后 6 位才放行，销毁不可逆 */
async function destroySelf(): Promise<void> {
  const tail = session.accountId.slice(-6);
  let typed: string;
  try {
    const res = await ElMessageBox.prompt(
      `此操作不可逆。确认后立即失效并退出，已上传的作品仍归工作室保留。请输入帐户ID ${session.accountId} 的后 6 位。`,
      '一键销毁帐号',
      {
        inputPlaceholder: '帐户ID 后 6 位',
        confirmButtonText: '确认销毁',
        cancelButtonText: '取消',
        type: 'warning',
        inputValidator: (value: string) => String(value ?? '').trim() === tail || '与帐户ID 后 6 位不一致',
      },
    );
    typed = String(res.value ?? '').trim();
  } catch {
    return;
  }
  try {
    await session.tempDestroy(typed);
    resetSessionRestore();
    ElMessage.success('账号已销毁，已上传的作品仍归工作室保留');
    await router.push('/');
  } catch (err) {
    ElMessage.error(errorText(err, '销毁失败'));
  }
}
</script>

<template>
  <section class="pk-work">
    <DestroyCountdown v-if="session.isTemp" :expires-at="expiresAt" />

    <WorkGrid :cells="cells" @select="openCell" />

    <p v-if="expired" class="pk-work__hint pk-muted">显示归零后仍可能短时可访问，接口一旦回 401 会立即清会话跳回展示首页。</p>
    <p v-else-if="!cells.length" class="pk-work__hint pk-muted">当前身份没有可用的功能格。</p>
  </section>
</template>

<style scoped>
.pk-work__hint {
  margin: 14px 0 0;
  font-size: 12px;
}
</style>
