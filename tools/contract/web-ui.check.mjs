// The old web UI (Navidrome's React app) against the Rust server's /auth, headless: a new server and its first admin
// (two-step verification set up without an enrolment code), the browser sign-in's approval page (who asks and from
// where; allowed only with a verification code; refused; a typed code; a code nobody waits for), app passwords (made
// only with a code), a second user who sets two-step verification up with the enrolment code the admin made on the
// user's page, the admin's reset, and the UI's own calls to Navidrome's API with the session the Rust server gave it.
//
//   node tools/contract/web-ui.check.mjs           the Rust server running its own Navidrome (cargo run in server/)
//   node tools/contract/web-ui.check.mjs --go      Navidrome alone: the control (it asks for none of the codes, and
//                                                  the same UI goes through without them)
//   … --navidrome <exe>                            another build of the fork than the fixtures' (its UI is in it)
//
// Needs Playwright with its Chromium (the repository's node_modules; `npm install` in the main checkout) and the golden
// fixtures' Navidrome (tools/fixtures/build.mjs), built from a fork whose UI knows the codes (0.64.2-sonus.11 or
// later). Screenshots go to tools/fixtures/.work/web-ui/. The accounts are made for the run, on a throwaway database,
// and never printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totp } from './lib/totp.mjs';
import { WORK } from '../fixtures/lib/navidrome.mjs';
import { serveGolden } from '../fixtures/serve.mjs';
import { startGatewayOnGolden } from './diff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Playwright from this checkout, else from the main checkout a worktree belongs to
function loadPlaywright() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here }).toString().trim();
  for (const root of [resolve(here, '../..'), resolve(common, '..')]) {
    try { return createRequire(join(root, 'package.json'))('playwright'); } catch { /* not here */ }
  }
  throw new Error('Playwright not found: run `npm install` in the repository');
}

const alone = process.argv.includes('--go');
const exe = (i => (i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : undefined))(process.argv.indexOf('--navidrome'));
const env = { ND_DEFAULTLANGUAGE: 'zh-Hans' };
const server = alone ? await serveGolden({ env, empty: true, navidrome: exe }) : await startGatewayOnGolden({ env, empty: true, navidrome: exe });
const base = server.url;
const shots = join(WORK, 'web-ui', alone ? 'go' : 'rust');
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const account = { username: 'qa', password: randomBytes(12).toString('base64url') };
const family = { username: 'family', password: randomBytes(12).toString('base64url') };

const results = [];
let browser, page, failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`✓ ${name}`); } catch (e) {
    results.push(`✗ ${name}: ${e.message.split('\n')[0]}`);
    await page?.screenshot({ path: join(shots, `fail-${++failures}.png`) }).catch(() => {});
  }
};
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const rest = async (method, query) => (await (await fetch(`${base}/rest/${method}?v=1.16.1&c=qa&f=json&${query}`)).json())['subsonic-response'];
const start = async device => (await post('/auth/device/start', { client: 'Sonus', device })).json();
const poll = async s => (await post('/auth/device/poll', { deviceCode: s.deviceCode })).json();

const CODE = 'input[aria-label="验证码"], input[aria-label="Verification code"]';
const ENROL = 'input[aria-label="绑定码"], input[aria-label="Enrolment code"]';
// the key of a new authenticator, shown in groups of four
const KEY_SHOWN = /((?:[A-Z2-7]{4} ){3,}[A-Z2-7]{1,4})/;
/** On the set-up card: reads the key, confirms a code from it, and returns the key and the recovery codes shown once. */
async function finishSetup(p, shot) {
  await p.getByText(/绑定验证器 App|Set up an authenticator app/).waitFor();
  await p.waitForFunction(re => new RegExp(re).test(document.body.innerText), KEY_SHOWN.source);
  const secret = (await p.locator('body').innerText()).match(KEY_SHOWN)[1].replaceAll(' ', '');
  const qr = p.locator('img[src^="data:image/png;base64,"]').first();
  await qr.waitFor();
  assert(await qr.evaluate(img => img.complete && img.naturalWidth > 100 && img.naturalWidth === img.naturalHeight), 'the QR code is not a square picture');
  if (shot) await p.screenshot({ path: join(shots, shot) });
  await p.fill(CODE, totp(secret));
  await p.click('button[type="submit"]');
  const list = p.locator('[aria-label="恢复码"], [aria-label="Recovery codes"]');
  await list.waitFor();
  const recovery = await list.locator('span').allInnerTexts();
  assert(recovery.length === 10, `${recovery.length} recovery codes shown`);
  await p.getByText(/我已保存，继续|I have saved them, continue/i).click();
  return { secret, recovery };
}

try {
  browser = await loadPlaywright().chromium.launch();
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 900 } });
  page = await context.newPage();
  // what the page asks of Navidrome's own API, and how it was answered
  const api = [];
  page.on('response', r => { const path = new URL(r.url()).pathname; if (path.startsWith('/api/')) api.push([path, r.status()]); });
  let first, key, admin, enrolment, familyId;
  // a recovery code of the admin's not used yet: each verification code the run needs takes one (an authenticator's
  // code works once, and the next comes only after 30 s)
  const own = () => { const code = admin.recovery.shift(); assert(code, 'no recovery code left'); return code; };

  await check('新服务器：打开网页先建第一个管理员；必须二步验证，不需要绑定码，直接绑定验证器', async () => {
    first = await start('验收电脑');
    assert(/^\/app\/#\/device\?code=[A-Z]{4}-[A-Z]{4}$/.test(first.verificationPath), first.verificationPath);
    await page.goto(base + first.verificationPath);
    await page.waitForSelector('input[name="confirmPassword"]');
    await page.screenshot({ path: join(shots, '1-first-admin.png') });
    await page.fill('input[name="username"]', account.username);
    await page.fill('input[name="password"]', account.password);
    await page.fill('input[name="confirmPassword"]', account.password);
    await page.click('button[type="submit"]');
    await page.getByText(/绑定验证器 App|Set up an authenticator app/).waitFor();
    assert(!(await page.locator(ENROL).count()), 'the first admin was asked for an enrolment code');
    admin = await finishSetup(page, '2-setup.png');
  });
  await check('允许页：显示同一个代码、应用、设备和请求来自的地址', async () => {
    await page.goto(base + first.verificationPath);
    await page.waitForSelector(`text=${first.userCode}`, { timeout: 15000 });
    const body = await page.locator('body').innerText();
    assert(body.includes('验收电脑') && body.includes('Sonus') && body.includes(account.username), body.slice(0, 400));
    if (!alone) assert(/(来自|came from) (127\.0\.0\.1|::1)/.test(body), `the address that asked is not shown: ${body.slice(0, 400)}`);
    await page.screenshot({ path: join(shots, '3-approve.png') });
  });
  await check('点“允许”要验证码：没有验证码点不了，验证码不对被拒绝，应用什么也拿不到', async () => {
    if (alone) return; // Navidrome alone asks for none
    const allow = page.getByRole('button', { name: /允许 Sonus|Allow Sonus/i });
    await page.locator(CODE).waitFor();
    assert(await allow.isDisabled(), 'the button can be pressed without a code');
    await page.fill(CODE, '000000');
    const refused = page.waitForResponse(r => r.url().includes('/approve'));
    await allow.click();
    assert((await refused).status() === 401, 'a wrong code was not refused');
    await page.getByText(/验证码不对|That code is not right/).waitFor();
    await page.screenshot({ path: join(shots, '3b-wrong-code.png') });
    assert((await poll(first)).status === 'pending', 'the app got an answer');
  });
  await check('输入验证码后点“允许”：应用随后拿到它自己的 API 密钥，能用来调用接口', async () => {
    assert((await poll(first)).status === 'pending', 'not pending before the decision');
    if (!alone) await page.fill(CODE, own());
    await page.getByRole('button', { name: /允许 Sonus|Allow Sonus/i }).click();
    await page.getByText(/已允许|^Allowed/).waitFor();
    await page.screenshot({ path: join(shots, '4-allowed.png') });
    const r = await poll(first);
    assert(r.status === 'approved' && r.username === account.username && r.apiKey, `poll: ${r.status}`);
    key = r.apiKey;
    assert((await poll(first)).status === 'expired', 'the key was handed over twice');
    assert((await rest('ping', `apiKey=${encodeURIComponent(key)}`)).status === 'ok', 'ping with the key');
    assert((await rest('tokenInfo', `apiKey=${encodeURIComponent(key)}`)).tokenInfo?.username === account.username, 'tokenInfo');
  });
  await check('个人设置的“应用专用密码”里列出这个密钥；新建一个要验证码，验证码不对不生成', async () => {
    await page.goto(`${base}/app/#/personal`);
    await page.waitForSelector('text=Sonus · 验收电脑', { timeout: 15000 });
    await page.getByPlaceholder(/例如：书房电脑|e\.g\. Study PC/).fill('客厅音箱');
    await page.getByRole('button', { name: /^(生成|Create)$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator(CODE).waitFor();
    if (!alone) {
      await dialog.locator(CODE).fill('000000');
      const refused = page.waitForResponse(r => r.url().endsWith('/auth/app-passwords') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: /^(确认|Confirm)$/ }).click();
      assert((await refused).status() === 401, 'a wrong code made an app password');
      assert(!(await page.locator('text=客厅音箱').count()), 'listed after a wrong code');
    }
    await dialog.locator(CODE).fill(own());
    await dialog.getByRole('button', { name: /^(确认|Confirm)$/ }).click();
    await page.getByText(/“客厅音箱”的应用专用密码|App password for “客厅音箱”/).waitFor();
    await page.screenshot({ path: join(shots, '5-app-password.png') });
    await page.getByRole('button', { name: /^(完成|Done)$/ }).click();
    await page.locator('text=客厅音箱').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '5-personal.png') });
  });
  await check('界面用登录得到的会话调用 Navidrome 自己的接口（/api）：全部成功', async () => {
    await page.goto(`${base}/app/#/album`);
    await page.waitForResponse(r => new URL(r.url()).pathname.startsWith('/api/album'), { timeout: 15000 });
    await page.waitForTimeout(500);
    assert(api.length > 3, `only ${api.length} calls to /api`);
    const refused = api.filter(([, status]) => status === 401 || status === 403);
    assert(refused.length === 0, `refused: ${JSON.stringify(refused.slice(0, 5))}`);
    await page.screenshot({ path: join(shots, '6-albums.png') });
  });
  await check('管理员新建用户后，在用户页生成绑定码（要管理员自己的验证码），只显示一次', async () => {
    // the user is made as the UI makes it: through Navidrome's own API, with the session in the page
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const made = await fetch(`${base}/api/user`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ND-Authorization': `Bearer ${token}` },
      body: JSON.stringify({ userName: family.username, name: 'Family', password: family.password, isAdmin: false }) });
    assert(made.status === 200, `making the user: HTTP ${made.status}`);
    familyId = (await made.json()).id;
    await page.goto(`${base}/app/#/user/${familyId}`);
    await page.getByText(/尚未绑定|Not set up/).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /生成绑定码|Make an enrolment code/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator(CODE).fill(own());
    await dialog.getByRole('button', { name: /^(确认|Confirm)$/ }).click();
    if (alone) { await page.getByText(/这个服务器不使用绑定码|does not use enrolment codes/).waitFor(); return; }
    const shown = page.locator('[aria-label="绑定码"], [aria-label="Enrolment code"]');
    await shown.waitFor();
    enrolment = (await shown.innerText()).trim();
    assert(/^[a-z2-9]{4}(-[a-z2-9]{4}){2}$/.test(enrolment), 'the enrolment code shown is not one');
    await page.getByRole('button', { name: /^(完成|Done)$/ }).click();
    await page.getByText(/已有一个绑定码在等|An enrolment code is waiting/).waitFor();
    await page.locator('text=/已有一个绑定码在等|An enrolment code is waiting/').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '7-user-enrolment.png') }); // after the dialog: the code is not in the picture
  });
  await check('新用户第一次登录：只有密码绑定不了，要先输入绑定码；错的被拒绝，对的才显示二维码', async () => {
    const other = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 900 } });
    const p = await other.newPage();
    try {
      await p.goto(`${base}/app/#/login`);
      await p.waitForSelector('input[name="username"]');
      await p.fill('input[name="username"]', family.username);
      await p.fill('input[name="password"]', family.password);
      await p.click('button[type="submit"]');
      if (!alone) {
        await p.locator(ENROL).waitFor();
        assert(!(await p.locator('img[src^="data:image/png;base64,"]').count()), 'a key to scan was shown before the enrolment code');
        await p.screenshot({ path: join(shots, '8-enrolment.png') });
        await p.fill(ENROL, 'aaaa-bbbb-cccc');
        await p.click('button[type="submit"]');
        await p.getByText(/绑定码不对|That enrolment code is not right/).waitFor();
        await p.fill(ENROL, enrolment);
        await p.click('button[type="submit"]');
      }
      family.secret = (await finishSetup(p, '9-family-setup.png')).secret;
      await p.waitForFunction(() => localStorage.getItem('username') === 'family' && !!localStorage.getItem('token'), null, { timeout: 15000 });
    } finally { await other.close(); }
  });
  await check('管理员在用户页重置对方的二步验证（要管理员自己的验证码）：得到新的绑定码，用过的旧码作废', async () => {
    await page.goto(`${base}/app/#/user/${familyId}`);
    await page.reload();
    await page.getByRole('button', { name: /重置二步验证|Reset two-step verification/ }).click();
    const dialog = page.getByRole('dialog');
    if (!alone) {
      await dialog.locator(CODE).fill('000000');
      const refused = page.waitForResponse(r => r.url().endsWith('/reset'));
      await dialog.getByRole('button', { name: /^(确认|Confirm)$/ }).click();
      assert((await refused).status() === 401, 'a wrong code reset the user');
    }
    await dialog.locator(CODE).fill(own());
    await dialog.getByRole('button', { name: /^(确认|Confirm)$/ }).click();
    if (alone) { await page.getByText(/尚未绑定|Not set up/).waitFor(); return; }
    const shown = page.locator('[aria-label="绑定码"], [aria-label="Enrolment code"]');
    await shown.waitFor();
    const fresh = (await shown.innerText()).trim();
    assert(/^[a-z2-9]{4}(-[a-z2-9]{4}){2}$/.test(fresh) && fresh !== enrolment, 'no new enrolment code after the reset');
    await page.getByRole('button', { name: /^(完成|Done)$/ }).click();
    // the code that was used enrols nobody again; the new one does
    const again = await (await post('/auth/login', family)).json();
    const setUp = code => post('/auth/2fa/setup', { token: again.setupToken, enrolmentCode: code });
    assert((await setUp(enrolment)).status === 401, 'the used enrolment code worked again');
    assert((await setUp(fresh)).status === 200, 'the new enrolment code does not work');
  });
  await check('已登录时再打开另一台的允许页，点“拒绝”：应用得到“拒绝”（拒绝不需要验证码）', async () => {
    const s = await start('另一台');
    await page.goto(base + s.verificationPath);
    await page.waitForSelector(`text=${s.userCode}`);
    await page.getByRole('button', { name: /^(拒绝|Refuse)$/i }).click();
    await page.getByText(/已拒绝 Sonus|Sonus was refused/).waitFor();
    assert((await poll(s)).status === 'denied', 'not denied');
  });
  await check('没带代码打开：可以手动输入代码', async () => {
    const s = await start('手输');
    await page.goto(`${base}/app/#/device`);
    await page.getByText(/输入应用里显示的代码|Enter the code the app shows/).waitFor();
    await page.fill('input', s.userCode.toLowerCase().replace('-', ''));
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^(继续|Continue)$/i }).click();
    await page.waitForSelector(`text=${s.userCode}`);
  });
  await check('过期或不存在的代码：说明没有等待中的登录', async () => {
    await page.goto(`${base}/app/#/device?code=BBBB-BBBB`);
    await page.getByText(/没有找到等待这个代码的登录|No sign-in is waiting for this code/).waitFor();
    await page.screenshot({ path: join(shots, '10-missing.png') });
  });
  await check('应用退出登录时交还密钥：随即失效（错误 44）', async () => {
    const status = (await post('/auth/device/revoke', { apiKey: key })).status;
    assert(status === 204, `revoke ${status}`);
    assert((await rest('ping', `apiKey=${encodeURIComponent(key)}`)).error?.code === 44, 'still works');
  });
  await check('退出后重新登录：要验证码，输入后进入界面', async () => {
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${base}/app/#/login`);
    await page.waitForSelector('input[name="username"]');
    await page.fill('input[name="username"]', account.username);
    await page.fill('input[name="password"]', account.password);
    await page.click('button[type="submit"]');
    const code = page.locator(CODE);
    await code.waitFor();
    await page.screenshot({ path: join(shots, '11-code.png') });
    // the setup used an earlier step's code: the next step's is accepted too (clocks drift), and not used yet
    const signedIn = page.waitForResponse(r => r.url().endsWith('/auth/login') && r.status() === 200, { timeout: 15000 });
    await code.fill(totp(admin.secret, Math.floor(Date.now() / 30000) + 1));
    await page.click('button[type="submit"]');
    await signedIn;
  });
} finally {
  await browser?.close();
  await server.stop();
}
console.log(`${alone ? 'Navidrome alone' : 'The Rust server'} (${base}); screenshots in ${shots}`);
console.log(results.join('\n'));
process.exit(results.length > 0 && results.every(r => r.startsWith('✓')) ? 0 : 1);
