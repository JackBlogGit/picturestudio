<script setup lang="ts">
/**
 * 联系我们（PRD 18 章的「联系我们」格）。公开页，不登录也能看。
 * 渠道列表来自后台站点设置的 site.contact，前端只做展示与复制。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { errorText } from '@/api/client';
import { getSiteInfo } from '@/api/public';
import type { ContactChannel, SiteInfo } from '@/types/api';
import { contactTypeLabel } from '@/utils/contact';

const site = ref<SiteInfo | null>(null);
const loading = ref(false);

const channels = computed<ContactChannel[]>(() => site.value?.contact ?? []);
/** 邮箱和群号这类短值点开就能复制，链接型的值直接跳出去 */
const isLink = (row: ContactChannel): boolean => /^(https?:\/\/|www\.)/i.test(row.value);

async function copy(row: ContactChannel): Promise<void> {
  try {
    await navigator.clipboard.writeText(row.value);
    ElMessage.success(`已复制${row.label}`);
  } catch {
    // 非安全上下文（http 直连）拿不到剪贴板，别静默失败
    ElMessage.warning('浏览器不允许写入剪贴板，请手动选中复制');
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    site.value = await getSiteInfo();
  } catch (err) {
    ElMessage.error(errorText(err, '联系方式读取失败'));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="pk-contact">
    <div class="pk-admin__head">
      <div>
        <h2 class="pk-page-title">联系我们</h2>
        <p class="pk-muted">{{ site?.title ?? '皮克社工作室' }} · 约稿、返图与商务合作都从这里进。</p>
      </div>
    </div>

    <div class="pk-contact__grid">
      <article class="pk-card pk-contact__card">
        <h3 class="pk-section__title">联系方式</h3>
        <ul v-if="channels.length" class="pk-contact__list">
          <li v-for="row in channels" :key="`${row.type}-${row.value}`">
            <span class="pk-contact__type">{{ row.label || contactTypeLabel(row.type) }}</span>
            <a v-if="isLink(row)" class="pk-link pk-contact__value" :href="`https://${row.value.replace(/^www\./, '')}`" target="_blank" rel="noopener">
              {{ row.value }}
            </a>
            <span v-else class="pk-contact__value">{{ row.value }}</span>
            <el-button v-if="!isLink(row)" size="small" text @click="copy(row)">复制</el-button>
          </li>
        </ul>
        <p v-else class="pk-muted">工作室还没在后台填写联系方式，先去「站点设置 · 站点信息」补上。</p>
      </article>

      <article class="pk-card pk-contact__card">
        <h3 class="pk-section__title">拿图</h3>
        <p>
          手里的返图还没领？把工作室发的链接或口令贴进来就行
          <router-link class="pk-link" to="/take">取图入口</router-link>
          。
        </p>
        <p class="pk-muted">
          约稿请附上漫展名称、期望交付时间与张数，方便工作室按档期排。
        </p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.pk-contact__grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 14px;
}

@media (max-width: 820px) {
  .pk-contact__grid {
    grid-template-columns: 1fr;
  }
}

.pk-contact__card {
  padding: 16px 18px;
}

.pk-contact__card p {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.8;
}

.pk-contact__list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}

.pk-contact__list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px dashed var(--pk-line);
  font-size: 13px;
}

.pk-contact__list li:last-child {
  border-bottom: none;
}

.pk-contact__type {
  flex: 0 0 88px;
  color: var(--pk-muted);
}

.pk-contact__value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
</style>
