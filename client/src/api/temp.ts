/**
 * 临时账号任务流接口（手绘稿 20 / 22 / 23）。注册页建账号，任务列表与任务管理读同一批行；
 * 谁能看到哪些任务由 mock/temps.ts 收口（正式成员都只看自己登记的，L3 起能看全部），
 * 页面不自己判断归属，只把 scope 传过去。
 */
import { api } from './client';
import type { TempRegisterPayload, TempTaskRow } from '@/types/api';

/** 换一个：拿一个还没被占用的帐户ID；顺带下发本身份的时长上限（D9），输入框不自己猜规则 */
export const nextAccountCode = () => api.get<{ code: string; maxDays: number }>('/temp-tasks/next-code');

/** 创立：成功后服务端顺手在隐藏的「拍展」子树里挂上帐户 ID 目录（规则 3） */
export const registerTemp = (body: TempRegisterPayload) => api.post<TempTaskRow>('/temp-tasks/register', body);

export const listTasks = (query: { keyword?: string; scope?: 'mine' | 'all'; sort?: 'asc' | 'desc' } = {}) =>
  api.get<TempTaskRow[]>('/temp-tasks', { query });

/** 前期（stage=1）/ 后期（stage=2）返图的完成标记 */
export const setTaskStage = (tempId: number, body: { stage: 1 | 2; done: 0 | 1 }) =>
  api.patch<TempTaskRow>(`/temp-tasks/${tempId}/stage`, body);

/** 注销：只关登录入口，帐户 ID 目录与里面的交付物保留 */
export const destroyTask = (tempId: number) => api.delete<{ tempId: number; removed: true }>(`/temp-tasks/${tempId}`);
