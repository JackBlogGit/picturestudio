export enum Visibility {
  Public = 'public',
  Member = 'member',
  Admin = 'admin',
  Private = 'private',
}

const STRICTNESS: Record<Visibility, number> = {
  [Visibility.Public]: 1,
  [Visibility.Member]: 2,
  [Visibility.Admin]: 3,
  [Visibility.Private]: 4,
};

export function rank(v: Visibility): number {
  return STRICTNESS[v];
}

export function stricter(a: Visibility, b: Visibility): Visibility {
  return rank(a) >= rank(b) ? a : b;
}

export function isLooserThan(child: Visibility, parent: Visibility): boolean {
  return rank(child) < rank(parent);
}

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  [Visibility.Public]: '公开',
  [Visibility.Member]: '成员可见',
  [Visibility.Admin]: '仅管理员',
  [Visibility.Private]: '私有',
};
