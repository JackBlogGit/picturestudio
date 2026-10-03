import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Capabilities, LoginResult, Profile, TempFlags } from '@/types/api';
import { UserLevel } from '@/types/api';
import { api } from '@/api/client';
import { getAccessToken, setAccessToken } from '@/api/token';

const NO_CAPS: Capabilities = {
  download: false,
  zip: false,
  upload: false,
  editOwn: false,
  editAny: false,
  delete: false,
  changeVisibility: false,
  canSetPublic: false,
  shareLink: false,
  adminConsole: false,
  writeSiteSettings: false,
};

const NO_FLAGS: TempFlags = {
  preview: false,
  download: false,
  editTag: false,
};

/** 顶栏右槽显示等级的显示名，不显示数字，也不显示字面「等级」（PRD 8.5） */
const IDENTITY_LABEL: Record<UserLevel, string> = {
  [UserLevel.Trainee]: '见习成员',
  [UserLevel.Member]: '成员',
  [UserLevel.Admin]: '管理员',
  [UserLevel.SuperAdmin]: '超级管理员',
};

/** 会话中心：登录态、能力位与身份文案都从这里出，页面不再各自解析 profile */
export const useSessionStore = defineStore('session', () => {
  const profile = ref<Profile | null>(null);
  const ready = ref(false);

  const isMember = computed(() => profile.value?.kind === 'user');
  const isTemp = computed(() => profile.value?.kind === 'temp');
  const loggedIn = computed(() => !!profile.value);
  const level = computed<UserLevel | 0>(() => (profile.value?.kind === 'user' ? profile.value.level : 0));

  /** 临时账号没有 capabilities，这里把 flags 折成同一组开关，页面只认一套字段 */
  const caps = computed<Capabilities>(() => {
    if (profile.value?.kind === 'user') return profile.value.capabilities;
    if (profile.value?.kind === 'temp') {
      const flags = profile.value.flags;
      // D27：不给 upload——临时账号只读取图，拍展传图与传文件的入口因此整体消失
      return {
        ...NO_CAPS,
        download: flags.download,
        zip: flags.download,
        editOwn: flags.editTag,
      };
    }
    return NO_CAPS;
  });

  const displayName = computed(() => {
    if (profile.value?.kind === 'user') return `${profile.value.nickname}（L${profile.value.level}）`;
    if (profile.value?.kind === 'temp') return `${profile.value.displayName}（临时账号）`;
    return '';
  });

  const identityLabel = computed(() => {
    if (profile.value?.kind === 'user') return IDENTITY_LABEL[profile.value.level] ?? `L${profile.value.level}`;
    if (profile.value?.kind === 'temp') return '临时账号';
    return '未登录';
  });

  /** 顶栏中槽（D17）：职务缺失时退化成只显示名称 */
  const welcome = computed(() => {
    if (profile.value?.kind === 'user') {
      const position = profile.value.position.trim();
      return position ? `你好！${profile.value.nickname} · ${position}` : `你好！${profile.value.nickname}`;
    }
    if (profile.value?.kind === 'temp') return '皮克社工作室欢迎您';
    return '';
  });

  const accountId = computed(() => (profile.value?.kind === 'temp' ? profile.value.accountId : ''));

  /** 服务端时刻与本机时刻的差，倒计时用它做差值（PRD 8.5） */
  const serverOffset = ref(0);

  function serverNow(): number {
    return Date.now() + serverOffset.value;
  }

  /** 当前身份能看到的档位数量：档位下拉要按这个裁（PRD 6.2） */
  const visibilityOptions = computed(() => {
    if (profile.value?.kind === 'user') {
      const max = profile.value.level >= UserLevel.SuperAdmin ? 4 : profile.value.level >= UserLevel.Admin ? 3 : 2;
      const tiers = (['public', 'member', 'admin', 'private'] as const).slice(0, max);
      // 对外发布被按人关掉时，public 连选项都不给（与接口的 SET_PUBLIC_FORBIDDEN 同一把尺子）
      return profile.value.capabilities.canSetPublic ? tiers : tiers.filter((t) => t !== 'public');
    }
    return ['public'] as const;
  });

  async function fetchMe(): Promise<void> {
    if (!getAccessToken()) {
      profile.value = null;
      return;
    }
    try {
      const next = await api.get<Profile>('/auth/me');
      serverOffset.value = Date.parse(next.serverTime) - Date.now();
      profile.value = next;
    } catch {
      setAccessToken('');
      profile.value = null;
    }
  }

  async function login(username: string, password: string): Promise<LoginResult> {
    const result = await api.post<LoginResult>('/auth/login', { username, password });
    setAccessToken(result.accessToken);
    await fetchMe();
    return result;
  }

  async function loginTemp(accessToken: string, password: string): Promise<LoginResult> {
    const result = await api.post<LoginResult>('/auth/temp-token', { accessToken, password });
    setAccessToken(result.accessToken);
    await fetchMe();
    return result;
  }

  async function logout(): Promise<void> {
    try {
      if (loggedIn.value) await api.post('/auth/logout');
    } finally {
      setAccessToken('');
      profile.value = null;
    }
  }

  /** D15 自助销毁：后 6 位随请求体提交给服务端复校；账号已不存在，不能再打 /auth/logout */
  async function tempDestroy(accountTail: string): Promise<void> {
    await api.post('/auth/temp-destroy', { accountTail });
    setAccessToken('');
    profile.value = null;
  }

  /** 演示用的身份直切：mock 模式写死令牌，真实模式仍走账号密码 */
  async function impersonate(token: string): Promise<void> {
    setAccessToken(token);
    await fetchMe();
  }

  async function bootstrap(): Promise<void> {
    await fetchMe();
    ready.value = true;
  }

  return {
    profile,
    ready,
    isMember,
    isTemp,
    loggedIn,
    level,
    caps,
    displayName,
    identityLabel,
    welcome,
    accountId,
    serverNow,
    visibilityOptions,
    login,
    loginTemp,
    logout,
    tempDestroy,
    impersonate,
    bootstrap,
  };
});
