export enum UserLevel {
  Trainee = 1,
  Member = 2,
  Admin = 3,
  SuperAdmin = 4,
}

export const LEVEL_LABEL: Record<UserLevel, string> = {
  [UserLevel.Trainee]: '见习成员',
  [UserLevel.Member]: '普通成员',
  [UserLevel.Admin]: '普通管理员',
  [UserLevel.SuperAdmin]: '超级管理员',
};

export function isLevelAtLeast(level: UserLevel | undefined, min: UserLevel): boolean {
  return level !== undefined && level >= min;
}
