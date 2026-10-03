/**
 * 随机口令生成（PRD 6.2 / D35）。纯前端行为：生成串由创建者复制给账号的使用者，
 * 服务端只收到一条普通的 `password`，强度仍按 6.2 的既有规则校验。
 * 字母表沿用帐户ID（`server/src/common/temp-account/account-no.ts`）剔除 `0 O 1 I L` 的做法——
 * 这一串迟早要被人手敲进登录框，抄错一位就只剩「密码不对」。
 */
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGIT = '23456789';

/** 注册页与提示文案共用这一个长度；12 位取自 55 枚字母表，约 2^69 种 */
export const TEMP_PASSWORD_LENGTH = 12;

/** 逐字节拒绝采样：`byte % max` 直接取模会让靠前的字符概率略高 */
function randomIndex(max: number): number {
  const limit = 256 - (256 % max);
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    if (byte[0] < limit) return byte[0] % max;
  }
}

export function generateTempPassword(length = TEMP_PASSWORD_LENGTH): string {
  // 先各锁一枚大小写与数字，之后无论强度规则加严到哪一档都不会把随机串挡在门外
  const chars = [UPPER, LOWER, DIGIT].map((pool) => pool[randomIndex(pool.length)]);
  const all = UPPER + LOWER + DIGIT;
  for (let i = chars.length; i < length; i += 1) chars.push(all[randomIndex(all.length)]);
  // 锁定的三枚不该永远排在开头
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
