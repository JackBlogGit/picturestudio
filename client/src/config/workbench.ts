/**
 * 首页功能宫格的唯一数据源：PRD 8.4 的「宫格 × 等级可见性」矩阵 + 8.5 的图标映射。
 * 标记不可见的格一律**不渲染**（不是置灰），低权限身份因此看不到功能的存在性。
 */
import type { Component } from 'vue';
import {
  Camera,
  ChatDotRound,
  CopyDocument,
  DataLine,
  Delete,
  Document,
  Files,
  Grid,
  Lock,
  Picture,
  Search,
  Setting,
  UploadFilled,
} from '@element-plus/icons-vue';
import type { Profile } from '@/types/api';
import { UserLevel } from '@/types/api';

export type CellKey =
  | 'upload'
  | 'shoot'
  | 'crawler'
  | 'encrypted'
  | 'materials'
  | 'manage'
  | 'settings'
  | 'logs'
  | 'dashboard'
  | 'backup'
  | 'take'
  | 'contact'
  | 'destroy';

export interface WorkCell {
  key: CellKey;
  label: string;
  icon: Component;
  /** 有值才导航；没实现的目标留空，点击给提示而不是跳 404 */
  to: string | null;
  /** 目标页尚未落地时的说明，直接进 toast 文案 */
  pendingHint: string | null;
  /** 危险格走确认弹窗，不参与导航 */
  danger: boolean;
}

interface CellDef extends WorkCell {
  /** 能看到该格的成员等级；临时账号不看这个字段 */
  levels: UserLevel[];
  /** 临时账号是否渲染该格 */
  forTemp: boolean;
}

const L1 = UserLevel.Trainee;
const L2 = UserLevel.Member;
const L3 = UserLevel.Admin;
const L4 = UserLevel.SuperAdmin;
const ALL_LEVELS: UserLevel[] = [L1, L2, L3, L4];

const DEFS: Record<CellKey, CellDef> = {
  upload: {
    key: 'upload',
    label: '传文件',
    icon: UploadFilled,
    // D18：上传面板是网盘的「上传」标签页，不另立路由
    to: '/drive?tab=upload',
    pendingHint: null,
    danger: false,
    levels: ALL_LEVELS,
    forTemp: false,
  },
  shoot: {
    key: 'shoot',
    label: '拍展',
    icon: Camera,
    // 拍展传图已并入相册页的第二个 tab
    to: '/albums?tab=upload',
    pendingHint: null,
    danger: false,
    levels: ALL_LEVELS,
    forTemp: false,
  },
  crawler: {
    key: 'crawler',
    label: '爬虫',
    icon: Search,
    to: null,
    pendingHint: '爬虫模块尚未开放（第 18 章，采集范围与版权约束待定）',
    danger: false,
    levels: [L4],
    forTemp: false,
  },
  encrypted: {
    // D19：四级成员均有自己的加密空间（private 档 = 归属人本人 + L4），不是「仅管理员」
    // D26：客户端信封加密已落地，这一格直接进 /drive/encrypted
    key: 'encrypted',
    label: '加密文件',
    icon: Lock,
    to: '/drive/encrypted',
    pendingHint: null,
    danger: false,
    levels: ALL_LEVELS,
    forTemp: false,
  },
  materials: {
    key: 'materials',
    label: '素材库',
    icon: Files,
    to: null,
    pendingHint: '素材库（/materials）尚未实现',
    danger: false,
    levels: ALL_LEVELS,
    forTemp: false,
  },
  manage: {
    key: 'manage',
    label: '管理',
    icon: Grid,
    to: null,
    pendingHint: '我的资源管理（/me/manage）尚未实现',
    danger: false,
    levels: ALL_LEVELS,
    forTemp: false,
  },
  settings: {
    key: 'settings',
    label: '设置',
    icon: Setting,
    to: '/me',
    pendingHint: null,
    danger: false,
    levels: ALL_LEVELS,
    forTemp: true,
  },
  logs: {
    key: 'logs',
    label: '日志',
    icon: Document,
    to: '/admin/logs',
    pendingHint: null,
    danger: false,
    levels: [L3, L4],
    forTemp: false,
  },
  dashboard: {
    key: 'dashboard',
    label: '仪表',
    icon: DataLine,
    to: '/admin',
    pendingHint: null,
    danger: false,
    levels: [L3, L4],
    forTemp: false,
  },
  backup: {
    key: 'backup',
    label: '备份',
    icon: CopyDocument,
    to: null,
    pendingHint: '备份模块尚未实现（导出包含未加水印原图，禁止落 web 根）',
    danger: false,
    levels: [L4],
    forTemp: false,
  },
  take: {
    key: 'take',
    label: '取图',
    icon: Picture,
    to: '/take',
    pendingHint: null,
    danger: false,
    levels: [],
    forTemp: true,
  },
  contact: {
    key: 'contact',
    label: '联系我们',
    icon: ChatDotRound,
    to: '/contact',
    pendingHint: null,
    danger: false,
    levels: [],
    forTemp: true,
  },
  destroy: {
    key: 'destroy',
    label: '一键销毁帐号',
    icon: Delete,
    to: null,
    pendingHint: null,
    danger: true,
    levels: [],
    forTemp: true,
  },
};

/** 图 7 的十格阅读顺序（L4 逐格对应），低等级按此顺序裁剪 */
const MEMBER_ORDER: CellKey[] = [
  'upload',
  'shoot',
  'crawler',
  'encrypted',
  'materials',
  'manage',
  'settings',
  'logs',
  'dashboard',
  'backup',
];

/** 临时账号只保留联系、取图、设置、销毁四格，传文件已从游客能力中移除 */
const TEMP_ORDER: CellKey[] = ['contact', 'take', 'settings', 'destroy'];

/**
 * 「管理」一格两路由（D16）：L3/L4 进全站后台，L1/L2 是自己的资源管理。
 * 后台页现在挂在 /admin，仪表盘是它的首页。
 */
function manageTarget(profile: Profile): string | null {
  return profile.kind === 'user' && profile.level >= L3 ? '/admin' : null;
}

function toCell(def: CellDef): WorkCell {
  return { key: def.key, label: def.label, icon: def.icon, to: def.to, pendingHint: def.pendingHint, danger: def.danger };
}

/**
 * 未登录用户在展示首页 / 上只有这两格（PRD 8.4 的公开列）：
 * 取图 = 贴口令进 /s/:token，联系我们 = 公开联系方式页。
 * 其余功能一律不渲染，避免向未登录用户暴露功能存在性。
 */
export const GUEST_CELLS: WorkCell[] = (['contact', 'take'] as CellKey[]).map((key) => toCell(DEFS[key]));

/** 当前身份的宫格，按 8.4 逐格裁剪；未登录没有工作台宫格，展示首页那两格见 GUEST_CELLS */
export function cellsFor(profile: Profile | null): WorkCell[] {
  if (!profile) return [];
  if (profile.kind === 'temp') {
    return TEMP_ORDER.filter((key) => DEFS[key].forTemp).map((key) => toCell(DEFS[key]));
  }
  return MEMBER_ORDER.filter((key) => DEFS[key].levels.includes(profile.level)).map((key) => {
    const cell = toCell(DEFS[key]);
    if (cell.key === 'manage') {
      const to = manageTarget(profile);
      return to ? { ...cell, to, pendingHint: null } : cell;
    }
    return cell;
  });
}

/**
 * 列数由格数决定，不用 auto-fill——否则 6 格排成 4+2，与图 8 的 3+3 不符（8.5）。
 * 移动端两列交给 CSS 覆盖。
 */
export function columnsFor(count: number): number {
  return count >= 7 ? 4 : 3;
}
