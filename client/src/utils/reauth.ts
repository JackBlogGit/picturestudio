/**
 * 后台改动的身份再验证（PRD 6.1 / D34）：提交前拿一次当前账号的登录口令交给请求层带走，
 * 一次提交结束就清除，口令不跟着下一个动作走，也不落任何浏览器存储。
 */
import { ElMessageBox } from 'element-plus';
import { clearReauthPassword, setReauthPassword } from '@/api/client';

/** 返回 false = 超管点了取消，调用方直接 return，不要发请求 */
export async function askReauth(action: string): Promise<boolean> {
  const input = await ElMessageBox.prompt(
    `「${action}」是后台改动，需要先验证身份。演示层缺省口令是 demo1234，改过密码的账号填改后的。`,
    '身份再验证',
    {
      inputType: 'password',
      inputPlaceholder: '当前账号的登录口令',
      confirmButtonText: '确认提交',
      cancelButtonText: '取消',
      closeOnClickModal: false,
      inputValidator: (value: string) => (value && value.trim() ? true : '登录口令不能为空'),
    },
  ).catch(() => null);
  if (!input) return false;
  setReauthPassword(input.value);
  return true;
}

/** 提交收尾：成功、失败、被后端挡回来都要调，放在 finally 里 */
export function endReauth(): void {
  clearReauthPassword();
}
