/**
 * 后台写操作的身份再验证（PRD 6.1 / D34）在验收脚本里的统一应对。
 * 页面点「保存」后，ElMessageBox.prompt 是异步挂到 body 上的：脚本不等它出现就往下读，
 * 这笔写入会被卡在弹窗里，后面的断言全读成旧值——所以每个碰到后台保存的脚本都要走这里。
 * 各 verify-*.mjs 自带一套 CDP 脚手架，这里只借用它们已经定义好的 evalJs / sleep。
 */
export const DEMO_PASSWORD = 'demo1234';

export function makeReauth({ evalJs, sleep, password = DEMO_PASSWORD }) {
  const READ = `(() => {
    const box = document.querySelector('.el-message-box');
    if (!box) return JSON.stringify({ open: false });
    const input = box.querySelector('.el-message-box__input input');
    return JSON.stringify({
      open: true,
      title: box.querySelector('.el-message-box__title')?.innerText.trim() ?? '',
      message: box.querySelector('.el-message-box__message')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      type: input?.type ?? null,
      value: input?.value ?? '',
      error: box.querySelector('.el-message-box__errormsg')?.innerText.trim() ?? '',
      buttons: [...box.querySelectorAll('.el-message-box__btns button')].map((b) => b.innerText.trim()),
    });
  })()`;

  async function state() {
    return JSON.parse(await evalJs(READ));
  }

  async function waitFor(timeoutMs = 3000) {
    for (let i = 0; i < timeoutMs / 100; i += 1) {
      const box = await state();
      if (box.open) return box;
      await sleep(100);
    }
    return { open: false };
  }

  async function fill(value) {
    return evalJs(`(() => {
      const input = document.querySelector('.el-message-box__input input');
      if (!input) return 'no-input';
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
  }

  async function press(which = 'confirm') {
    return evalJs(`(() => {
      const box = document.querySelector('.el-message-box');
      const btns = [...(box?.querySelectorAll('.el-message-box__btns button') ?? [])];
      const want = ${JSON.stringify(which)};
      const target = want === 'cancel'
        ? btns.find((b) => !b.classList.contains('el-button--primary'))
        : btns.find((b) => b.classList.contains('el-button--primary'));
      if (!target) return 'no-button';
      target.click();
      return target.innerText.trim();
    })()`);
  }

  /** 点完「保存」接着调：等弹窗出来 → 填口令 → 按「确认提交」，默认填演示层的缺省口令 */
  async function pass(value = password) {
    const box = await waitFor();
    if (!box.open) return 'no-prompt';
    await fill(value);
    await sleep(150);
    const label = await press('confirm');
    await sleep(800);
    return label;
  }

  /** 超管点「取消」这一支：弹窗关掉、请求根本不发 */
  async function cancel() {
    const box = await waitFor();
    if (!box.open) return 'no-prompt';
    const label = await press('cancel');
    await sleep(500);
    return label;
  }

  return { state, waitFor, fill, press, pass, cancel };
}
