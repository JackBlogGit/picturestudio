const TOKEN_KEY = 'piks.accessToken';

/** 真接口与 mock 共用这一处令牌存放，免得两边各写一份 key */
export function getAccessToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAccessToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
