// The old web UI (Navidrome's React app) against the Rust server's /auth, headless: a new server, the first admin, the
// sign-in form with the two-step verification setup, the browser sign-in's approval page (allow, refuse, a typed code, a
// code nobody waits for), the key in Personal settings, and the UI's own calls to Navidrome's API with the session the
// Rust server gave it.
//
//   node tools/contract/web-ui.check.mjs           the Rust server running its own Navidrome (cargo run in server/)
//   node tools/contract/web-ui.check.mjs --go      Navidrome alone: the control
//
// Needs Playwright with its Chromium (the repository's node_modules; `npm install` in the main checkout) and the golden
// fixtures' Navidrome (tools/fixtures/build.mjs). Screenshots go to tools/fixtures/.work/web-ui/. The account is made
// for the run, on a throwaway database, and never printed.
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
const env = { ND_DEFAULTLANGUAGE: 'zh-Hans' };
const server = alone ? await serveGolden({ env, empty: true }) : await startGatewayOnGolden({ env, empty: true });
const base = server.url;
const shots = join(WORK, 'web-ui', alone ? 'go' : 'rust');
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const account = { username: 'qa', password: randomBytes(12).toString('base64url') };

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

try {
  // the first admin: with two-step verification required, the answer is the setup step, not a session
  const made = await post('/auth/createAdmin', account);
  assert(made.status === 401 && (await made.json()).twoFactor === 'setup', `createAdmin: HTTP ${made.status}`);

  browser = await loadPlaywright().chromium.launch();
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 760 } });
  page = await context.newPage();
  // what the page asks of Navidrome's own API, and how it was answered
  const api = [];
  page.on('response', r => { const path = new URL(r.url()).pathname; if (path.startsWith('/api/')) api.push([path, r.status()]); });
  let first, key, secretSeen;

  await check('没登录时打开允许页：先到网页登录页', async () => {
    first = await start('验收电脑');
    assert(/^\/app\/#\/device\?code=[A-Z]{4}-[A-Z]{4}$/.test(first.verificationPath), first.verificationPath);
    await page.goto(base + first.verificationPath);
    await page.waitForSelector('input[name="username"]');
    await page.screenshot({ path: join(shots, '1-login.png') });
  });
  await check('密码错误：登录页提示，不进入下一步', async () => {
    await page.fill('input[name="username"]', account.username);
    await page.fill('input[name="password"]', 'not the password');
    const refused = page.waitForResponse(r => r.url().endsWith('/auth/login'));
    await page.click('button[type="submit"]');
    assert((await refused).status() === 401, 'the sign-in was not refused');
    await page.waitForSelector('input[name="username"]');
  });
  await check('登录（必须二步验证：先绑定验证器）后回到允许页，显示同一个代码和设备', async () => {
    await page.fill('input[name="username"]', account.username);
    await page.fill('input[name="password"]', account.password);
    await page.click('button[type="submit"]');
    await page.getByText(/绑定验证器 App|Set up an authenticator app/).waitFor();
    // the key comes after the card (fetched): shown in groups of four; the QR code beside it is the server's PNG
    const keyShown = /((?:[A-Z2-7]{4} ){3,}[A-Z2-7]{1,4})/;
    await page.waitForFunction(re => new RegExp(re).test(document.body.innerText), keyShown.source);
    const secret = (await page.locator('body').innerText()).match(keyShown)[1].replaceAll(' ', '');
    secretSeen = secret;
    const qr = page.locator('img[src^="data:image/png;base64,"]').first();
    await qr.waitFor();
    assert(await qr.evaluate(img => img.complete && img.naturalWidth > 100 && img.naturalWidth === img.naturalHeight), 'the QR code is not a square picture');
    await page.screenshot({ path: join(shots, '2-setup.png') });
    await page.fill('input[aria-label="验证码"], input[aria-label="Verification code"]', totp(secret));
    await page.click('button[type="submit"]');
    await page.getByText(/我已保存，继续|I have saved them, continue/i).click();
    await page.waitForSelector(`text=${first.userCode}`, { timeout: 15000 });
    assert(page.url().endsWith(`/app/#/device?code=${first.userCode}`), page.url());
    const body = await page.locator('body').innerText();
    assert(body.includes('验收电脑') && body.includes('Sonus') && body.includes(account.username), body.slice(0, 400));
    await page.screenshot({ path: join(shots, '3-approve.png') });
  });
  await check('点“允许”：应用随后拿到它自己的 API 密钥，能用来调用接口', async () => {
    assert((await poll(first)).status === 'pending', 'not pending before the decision');
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
  await check('个人设置的“应用专用密码”里列出这个密钥（可撤销）', async () => {
    await page.goto(`${base}/app/#/personal`);
    await page.waitForSelector('text=Sonus · 验收电脑', { timeout: 15000 });
    await page.locator('text=Sonus · 验收电脑').scrollIntoViewIfNeeded();
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
  await check('已登录时再打开另一台的允许页，点“拒绝”：应用得到“拒绝”', async () => {
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
    await page.screenshot({ path: join(shots, '7-missing.png') });
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
    const code = page.locator('input[aria-label="验证码"], input[aria-label="Verification code"]');
    await code.waitFor();
    await page.screenshot({ path: join(shots, '8-code.png') });
    // the setup used this step's code: the next step's is accepted too (clocks drift), and not used yet
    const signedIn = page.waitForResponse(r => r.url().endsWith('/auth/login') && r.status() === 200, { timeout: 15000 });
    await code.fill(totp(secretSeen, Math.floor(Date.now() / 30000) + 1));
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
