// The fork's web sign-in (/auth/login, two-step verification) and JSON routes signed with its session (the
// X-ND-Authorization header), which the golden-database builder and the device sign-in tests use.
import { step, totp } from './totp.mjs';

/** { status, json } of a JSON request; token: a session to sign it with. */
export async function webJson(base, path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-ND-Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
  return { status: res.status, json };
}

/**
 * Signs a user in on the web ({ username, password, totpSecret? }) and returns the session token. Each authenticator
 * code is taken once, and the server accepts the next step's code too, so a code refused as used is retried with it.
 */
export async function signIn(base, user) {
  const login = otp => webJson(base, '/auth/login', { method: 'POST', body: { username: user.username, password: user.password, ...(otp ? { otp } : {}) } });
  let r = await login();
  if (r.status === 401 && r.json?.twoFactor === 'code' && user.totpSecret) {
    // Both codes taken already (signed in twice within a step): wait for the next step.
    for (let round = 0; round < 3 && r.status !== 200; round++) {
      if (round) await new Promise(done => setTimeout(done, 30_000 - (Date.now() % 30_000) + 250));
      const now = step();
      for (const s of [now, now + 1]) {
        r = await login(totp(user.totpSecret, s));
        if (r.status === 200) break;
      }
    }
  }
  if (r.status !== 200 || !r.json?.token) throw new Error(`signing ${user.username} in: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}
