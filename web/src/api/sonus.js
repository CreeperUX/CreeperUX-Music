// The Sonus server's own routes, beside the Subsonic API (api/subsonic.js):
//
// - /auth (the fork's server/auth.go, sonus_twofactor.go and sonus_device.go; later the Rust server's, unchanged): the
//   web sign-in with two-step verification, app passwords, and the browser sign-in for apps (an app shows a code, the
//   user allows it on a signed-in page, the app gets an API key of its own).
// - /sonus/v1 (not designed yet, docs/server-roadmap.md phase 6): users, the library and scans, settings. Its calls go
//   here too, through the same `call`, when it exists; the pages that use it live under views/ next to account.js.
//
// The web session (a JWT from /auth/login) is kept in memory only: it opens the account pages, never playback, and a
// reload asks for the password again. Playback and the library use the Subsonic sign-in kept by api/subsonic.js.

const sessions = new Map(); // server → { token, username, isAdmin }

/** An error from these routes: `status` (HTTP), `twoFactor` ('code' | 'setup') and `setupToken` when the sign-in wants more. */
export class ServerError extends Error {
  constructor(message, { status = 0, twoFactor = null, setupToken = null } = {}) { super(message); this.status = status; this.twoFactor = twoFactor; this.setupToken = setupToken; }
}

const MESSAGES = {
  'Invalid username or password': '用户名或密码不正确。',
  'Verification code required': '请输入验证码。',
  'Invalid verification code': '验证码不正确，或已经用过。',
  'Two-step verification must be set up': '这个服务器要求先设置两步验证。',
  'Two-step verification is required on this server': '这个服务器要求两步验证，不能关闭。',
  'Two-step verification is turned off on this server': '这个服务器没有开启两步验证。',
  'No sign-in waiting for this code: it may have expired': '没有等待这个代码的登录请求：可能已经过期。',
  'Not authenticated': '登录已过期，请重新输入密码。',
  'No such app password': '找不到这个应用专用密码。',
};

/**
 * The /auth routes of one server.
 * @param {string} server  The server's address (with its base path), no trailing slash.
 */
export function createAuthApi(server) {
  const base = String(server ?? '').replace(/\/+$/, '');
  async function call(method, path, body, { token } = {}) {
    const bearer = token ?? sessions.get(base)?.token;
    let res;
    try {
      res = await fetch(`${base}/auth${path}`, { method, headers: { 'Content-Type': 'application/json', ...(bearer ? { 'X-ND-Authorization': `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new ServerError(`连不上 ${base}。检查地址和网络。`); }
    let data = null;
    try { data = await res.json(); } catch { /* 204, or not JSON */ }
    if (!res.ok) {
      if (res.status === 401 && !data?.twoFactor && bearer && token === undefined) sessions.delete(base); // the session ran out
      const text = data?.error ?? '';
      throw new ServerError(MESSAGES[text] ?? (text || (res.status === 404 ? '这个服务器没有这项功能。' : res.status === 429 ? '尝试次数太多，请稍后再试。' : `服务器返回了 ${res.status}。`)),
        { status: res.status, twoFactor: data?.twoFactor ?? null, setupToken: data?.setupToken ?? null });
    }
    return data;
  }
  const keep = payload => { if (payload?.token) sessions.set(base, { token: payload.token, username: payload.username, isAdmin: !!payload.isAdmin }); return payload; };
  return {
    server: base,
    /** The web session, or null: { token, username, isAdmin }. */
    get session() { return sessions.get(base) ?? null; },
    forget() { sessions.delete(base); },

    /** Password sign-in; with two-step verification on, a first call without `otp` fails with twoFactor 'code'. */
    login: ({ username, password, otp }) => call('POST', '/login', { username, password, ...(otp ? { otp } : {}) }, { token: '' }).then(keep),
    /** Starts setting up an authenticator: { secret, uri, qr (a data: PNG), issuer, account }. `token`: a setup token from the sign-in; omitted when signed in. */
    setupBegin: ({ token, code } = {}) => call('POST', '/2fa/setup', { ...(token ? { token } : {}), ...(code ? { code } : {}) }, token ? { token } : {}),
    /** Confirms it with a code from the authenticator: signs in and gives { recoveryCodes }. */
    setupConfirm: ({ token, code }) => call('POST', '/2fa/confirm', { ...(token ? { token } : {}), code }, token ? { token } : {}).then(keep),
    /** { mode: 'required' | 'optional' | 'off', enabled, enabledAt?, recoveryCodesLeft } */
    status: () => call('GET', '/2fa'),
    newRecoveryCodes: code => call('POST', '/2fa/recovery-codes', { code }),
    disable: code => call('POST', '/2fa/disable', { code }),

    /** [{ id, name, createdAt, lastUsedAt?, lastUsedBy? }]: app passwords, and the keys of apps signed in through the browser. */
    appPasswords: () => call('GET', '/app-passwords').then(list => list ?? []),
    /** { appPassword, password }: the password is shown once. */
    createAppPassword: name => call('POST', '/app-passwords', { name }),
    deleteAppPassword: id => call('DELETE', `/app-passwords/${encodeURIComponent(id)}`),

    // the browser sign-in, an app's side: start, then poll until 'approved' (with apiKey and username), 'denied' or 'expired'
    deviceStart: ({ client, device }) => call('POST', '/device/start', { client, device }, { token: '' }),
    devicePoll: deviceCode => call('POST', '/device/poll', { deviceCode }, { token: '' }),
    deviceRevoke: apiKey => call('POST', '/device/revoke', { apiKey }, { token: '' }),
    // … and the approval page's side (signed in): what asks, then allow or refuse
    deviceInfo: code => call('GET', `/device/${encodeURIComponent(code)}`),
    deviceDecide: (code, allow) => call('POST', `/device/${encodeURIComponent(code)}/${allow ? 'approve' : 'deny'}`),
  };
}
