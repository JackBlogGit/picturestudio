/**
 * 公开通道的 mock：站点简介（游客可读）。
 * 对应后端 GET /public/site-info —— 走的是无鉴权前缀，
 * 响应体里绝不出现配置以外的内部字段。
 */
import { SETTINGS, settingBool } from './tables';
import { parseContactChannels } from '@/utils/contact';
import type { SiteInfo } from '@/types/api';

export function siteInfo(): SiteInfo {
  return {
    title: SETTINGS['site.title'],
    introLines: SETTINGS['site.intro'].split('\n').filter((line) => line !== ''),
    commentEnabled: settingBool('guest.comment_enabled'),
    watermarkText: SETTINGS['watermark.text'],
    contact: parseContactChannels(SETTINGS['site.contact']),
  };
}
