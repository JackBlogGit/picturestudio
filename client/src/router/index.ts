import { createRouter, createWebHistory } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '@/stores/session';
import { UserLevel } from '@/types/api';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'showcase', component: () => import('@/views/HomeView.vue'), meta: { title: '首页' } },
    { path: '/home', name: 'home', component: () => import('@/views/WorkbenchView.vue'), meta: { auth: true, workbar: true, title: '工作台' } },
    { path: '/albums', name: 'albums', component: () => import('@/views/AlbumsView.vue'), meta: { title: '相册' } },
    {
      path: '/albums/:id',
      name: 'album',
      component: () => import('@/views/AlbumDetailView.vue'),
      props: true,
      meta: { title: '相册详情' },
    },
    // D18：上传面板只在网盘页的「上传」标签里，旧入口一律落到那一格
    { path: '/upload', redirect: { name: 'drive', query: { tab: 'upload' } } },
    // 拍展传图已并入相册页的第二个 tab（drive?tab=upload 模式），原入口一律重定向
    { path: '/shoot', redirect: { name: 'albums', query: { tab: 'upload' } } },
    // D21 三入口页 + 手绘稿 20/22/23 的临时账号任务流；档位越权由接口 403 兜住
    { path: '/entry', name: 'entry', component: () => import('@/views/EntryView.vue'), meta: { auth: true, title: '入口' } },
    {
      path: '/guest/new',
      name: 'guest-register',
      component: () => import('@/views/TempRegisterView.vue'),
      meta: { auth: true, member: true, title: '注册游客' },
    },
    { path: '/tasks', name: 'tasks', component: () => import('@/views/TaskListView.vue'), meta: { auth: true, title: '任务列表' } },
    {
      path: '/tasks/manage',
      name: 'task-manage',
      component: () => import('@/views/TaskManageView.vue'),
      meta: { auth: true, title: '任务管理' },
    },
    { path: '/drive', name: 'drive', component: () => import('@/views/DriveView.vue'), meta: { title: '网盘', auth: true, member: true } },
    // D26：加密空间是网盘下的独立页，与 /drive 同一道闸门（游客 401、临时账号 403，PRD D19）
    {
      path: '/drive/encrypted',
      name: 'vault',
      component: () => import('@/views/VaultView.vue'),
      meta: { title: '加密空间', auth: true, member: true },
    },
    { path: '/me', name: 'me', component: () => import('@/views/MeView.vue'), meta: { title: '个人中心', auth: true } },
    // 取图与联系我们都对未登录用户开放（PRD 8.4 的公开列），所以两页都不挂 meta.auth
    { path: '/take', name: 'take', component: () => import('@/views/TakeView.vue'), meta: { title: '取图' } },
    { path: '/contact', name: 'contact', component: () => import('@/views/ContactView.vue'), meta: { title: '联系我们' } },
    { path: '/s/:shareToken', name: 'share', component: () => import('@/views/ShareView.vue'), props: true, meta: { title: '返图链接' } },
    {
      path: '/admin',
      component: () => import('@/views/admin/AdminLayout.vue'),
      meta: { auth: true, admin: true, title: '后台控制台' },
      children: [
        { path: '', name: 'admin', component: () => import('@/views/admin/AdminDashboard.vue'), meta: { title: '仪表盘' } },
        {
          path: 'albums',
          name: 'admin-albums',
          component: () => import('@/views/admin/AdminAlbums.vue'),
          meta: { title: '相册管理' },
        },
        {
          path: 'members',
          name: 'admin-members',
          component: () => import('@/views/admin/AdminMembers.vue'),
          meta: { title: '成员与临时账号' },
        },
        {
          path: 'tags',
          name: 'admin-tags',
          component: () => import('@/views/admin/AdminTags.vue'),
          meta: { title: '标签库' },
        },
        {
          path: 'drive',
          name: 'admin-drive',
          component: () => import('@/views/admin/AdminDrive.vue'),
          meta: { title: '网盘管理' },
        },
        {
          path: 'shares',
          name: 'admin-shares',
          component: () => import('@/views/admin/AdminShares.vue'),
          meta: { title: '返图链接' },
        },
        {
          path: 'logs',
          name: 'admin-logs',
          component: () => import('@/views/admin/AdminLogs.vue'),
          meta: { title: '日志审计' },
        },
        {
          path: 'settings',
          name: 'admin-settings',
          component: () => import('@/views/admin/AdminSettings.vue'),
          meta: { title: '站点设置' },
        },
        // D28：站外来源登记只认 L4，用等级而不是能力位——这一位不参与 D21 的按人覆盖
        {
          path: 'crawler',
          name: 'admin-crawler',
          component: () => import('@/views/admin/AdminCrawler.vue'),
          meta: { title: '站外来源登记', super: true },
        },
      ],
    },
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { title: '登录' } },
    { path: '/:catchAll(.*)', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { title: '页面不存在' } },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

// 会话在首帧前恢复，否则刷新后会看到"未登录"闪一下
let restoring: Promise<void> | null = null;

router.beforeEach(async (to) => {
  const session = useSessionStore();
  restoring ??= session.bootstrap();
  await restoring;
  if (to.meta.auth && !session.loggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  // 8.1：/ 只面向未登录状态，登录身份一律落到宫格工作台
  if (to.name === 'showcase' && session.loggedIn) {
    return { name: 'home' };
  }
  // member 元数据：注册入口、网盘均只对正式成员开放
  const isMemberOnly = !!to.meta.member && !session.isMember;
  // 拍展传图已并入相册 tab，入口页那一格按 caps.upload 显示，这里用同一个尺子拦深链：
  // D27 起这一位只属于正式成员（临时账号只能取图），超管按人关掉时标签与深链一起消失
  const queryTab = Array.isArray(to.query.tab) ? to.query.tab[0] : to.query.tab;
  const uploadTabForbidden =
    (to.path === '/albums' || to.path === '/drive') && queryTab === 'upload' && !session.caps.upload;
  if (isMemberOnly || uploadTabForbidden) {
    ElMessage.warning(isMemberOnly ? '该功能仅对正式成员开放' : '当前身份没有「传图」权限');
    return session.loggedIn ? { name: 'home' } : { name: 'login', query: { redirect: to.fullPath } };
  }
  // 后台只对 L3+ 开，越级进来直接拦在路由，免得到处弹 403
  if (to.meta.admin && !session.caps.adminConsole) {
    ElMessage.warning('后台控制台仅对 L3 管理员及以上开放');
    return { name: 'home' };
  }
  // D28：标了 super 的那几页连 L3 都不给进，口径与后端 admin/crawler 守卫一致
  if (to.meta.super && session.level !== UserLevel.SuperAdmin) {
    ElMessage.warning('该页面仅对超级管理员开放');
    return { name: 'home' };
  }
  return true;
});

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '')} · 皮克社工作室`;
});

/** 登出后令牌已清空，缓存的恢复动作要一并作废，否则下次导航仍用旧会话 */
export function resetSessionRestore(): void {
  restoring = null;
}

export default router;
