<template>
  <section class="pk-card pk-404">
    <h2 class="pk-page-title">404</h2>
    <p class="pk-muted">页面不存在，或者它不在当前身份的可见范围内——后端对这两种情况给的是同一个 404。</p>
    <router-link to="/"><el-button type="primary">回首页</el-button></router-link>
  </section>
</template>

<style scoped>
.pk-404 {
  max-width: 520px;
  margin: 40px auto;
  padding: 26px 24px;
  text-align: center;
}

.pk-404 .pk-muted {
  line-height: 1.8;
  margin: 10px 0 18px;
}
</style>
