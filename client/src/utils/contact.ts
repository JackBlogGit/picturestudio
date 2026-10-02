import type { ContactChannel } from '@/types/api';

export const CONTACT_TYPES: { value: ContactChannel['type']; label: string }[] = [
  { value: 'weibo', label: '微博' },
  { value: 'bilibili', label: 'B站' },
  { value: 'qqgroup', label: 'QQ群' },
  { value: 'wechat', label: '微信' },
  { value: 'email', label: '邮箱' },
  { value: 'other', label: '其他' },
];

const TYPE_LABEL = Object.fromEntries(CONTACT_TYPES.map((t) => [t.value, t.label])) as Record<ContactChannel['type'], string>;

export function contactTypeLabel(type: ContactChannel['type']): string {
  return TYPE_LABEL[type] ?? type;
}

/** 空值渠道不展示：后台留了半填的一行不该在对外页面上冒出个空壳 */
export function parseContactChannels(raw: string | undefined): ContactChannel[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item): ContactChannel | null => {
      const row = item as Partial<Record<keyof ContactChannel, unknown>>;
      const value = typeof row?.value === 'string' ? row.value.trim() : '';
      const label = typeof row?.label === 'string' ? row.label.trim() : '';
      if (!value) return null;
      const type = CONTACT_TYPES.some((t) => t.value === row?.type)
        ? (row.type as ContactChannel['type'])
        : 'other';
      return { type, label: label || contactTypeLabel(type), value };
    })
    .filter((row): row is ContactChannel => row !== null);
}
