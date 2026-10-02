/**
 * PRD 6.2 / 12 章：手机号是 PII，任何 API 响应与 logs.detail 一律脱敏，
 * 只有工单 owner 本人与 L3/L4 才允许拿到完整值——判定交给调用方，格式统一在这里。
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '****';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** 大陆 11 位、1 开头、第二位 3–9；只用来判合法性，不做归属地 */
export function isMainlandPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value);
}
