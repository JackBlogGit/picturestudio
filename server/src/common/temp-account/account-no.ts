import { randomInt } from 'node:crypto';

/**
 * 帐户ID（PRD 6.2）：`YK` + 6 位随机大写字母数字，全局唯一、系统生成、不可改，
 * 可替代 login_name 在登录页登录。字母表刻意剔除 `0 O 1 I L`——手抄一个帐户ID 时
 * 这几个字符必然抄错，而它是唯一登录凭据。
 */
export const ACCOUNT_NO_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ACCOUNT_NO_PREFIX = 'YK';
export const ACCOUNT_NO_RANDOM_LEN = 6;
export const ACCOUNT_NO_REGEX = new RegExp(
  `^${ACCOUNT_NO_PREFIX}[${ACCOUNT_NO_ALPHABET}]{${ACCOUNT_NO_RANDOM_LEN}}$`,
);

export function randomAccountNo(): string {
  let suffix = '';
  for (let i = 0; i < ACCOUNT_NO_RANDOM_LEN; i += 1) {
    suffix += ACCOUNT_NO_ALPHABET[randomInt(ACCOUNT_NO_ALPHABET.length)];
  }
  return ACCOUNT_NO_PREFIX + suffix;
}

export function isAccountNo(value: string): boolean {
  return ACCOUNT_NO_REGEX.test(value ?? '');
}

/** 候选 ID 撞库时重生成；5 次仍撞说明字母表被人为写坏了，直接报错而不是静默死循环 */
export function uniqueAccountNo(taken: Set<string>, attempts = 5): string {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = randomAccountNo();
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`连续 ${attempts} 次生成的帐户ID 都已存在，拒绝继续`);
}
