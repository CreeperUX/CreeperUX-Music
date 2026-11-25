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

const sent = new Map(); // an authenticator's secret → the last step whose code this process sent
const nextStep = () => new Promise(done => setTimeout(done, 30_000 - (Date.now() % 30_000) + 250));

/**
 * Sends a request that takes a verification code of the user ({ totpSecret }): `send(code)` answers { status, json },
 * and is tried again while the server refuses the code. Each authenticator code is taken once, the server accepts the
 * next step's too, and a wrong one counts against the account (ten an hour): so no step is sent twice by this process,
 * and when both are spent it waits for the next (up to 30 s). Another process may have used a step: then one try is
 * refused, and the following step is sent.
 */
export async function withCode(user, send) {
  let r = null;
  for (let tries = 0; tries < 4; tries++) {
    let s = Math.max(step(), (sent.get(user.totpSecret) ?? 0) + 1);
    while (s > step() + 1) await nextStep();
    sent.set(user.totpSecret, s);
    r = await send(totp(user.totpSecret, s));
    if (!(r.status === 401 && r.json?.twoFactor === 'code')) return r;
  }
  return r;
}

/** Signs a user in on the web ({ username, password, totpSecret? }) and returns the session token (see `withCode`). */
export async function signIn(base, user) {
  const login = otp => webJson(base, '/auth/login', { method: 'POST', body: { username: user.username, password: user.password, ...(otp ? { otp } : {}) } });
  let r = await login();
  if (r.status === 401 && r.json?.twoFactor === 'code' && user.totpSecret) r = await withCode(user, login);
  if (r.status !== 200 || !r.json?.token) throw new Error(`signing ${user.username} in: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}
