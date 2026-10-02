/**
 * 取图接口层（PRD 18 章）。只有临时账号有「待领清单」这一说，
 * 游客与成员进 /take 看到的是口令领图入口，走的是 /public/share 那条已有通道。
 */
import { api } from './client';
import type { TakePending } from '@/types/api';

export const getTakePending = () => api.get<TakePending>('/take/pending');
