// Sign-in to a music server (Navidrome or another Subsonic-compatible one): shown instead of the workspace while there
// is no saved sign-in. On success the page reloads and starts with the library. ?demo=<address> (the demo launcher sets
// it) adds a button that signs in to the local demo server's account.
//
// Three ways in, the last two on a Sonus server only (api/sonus.js):
// - the password, as a Subsonic token (any server);
// - the password and a two-step code: when the server refuses the password for the API (two-step verification is on),
//   the page opens a web session with password and code, makes an app password for this browser, and signs in with
//   that. A user the server requires to set two-step verification up does it here first;
// - through the browser: the page shows a code, the user allows it on a page that is already signed in (this client's
//   #/device, or the server's own), and the server hands this browser an API key. The password never comes here.
import { h, ic } from '../dom.js';
import { signIn, signInWithKey, lastServer, normalizeServer, serverExtensions, clientName } from '../api/subsonic.js';
import { createAuthApi } from '../api/sonus.js';
import { configuredServer } from '../api/config.js';
import { codeField, setupPanel, recoveryPanel } from './twostep.js';

export const DEMO_ACCOUNT = { user: 'demo', password: 'demo' };

export function mountLogin(root, { UI, S, t, server = '', demo = null, error = '' }) {
  const L = t.login, fixed = configuredServer();
  root.classList.add('cm', 'cm-login-root');
  const card = h('main', { class: 'cm-login', 'aria-labelledby': 'cm-login-title' });
  root.replaceChildren(card);
  const brand = h('div', { class: 'cm-login-brand' }, h('img', { src: './assets/icon.svg', alt: '', width: 40, height: 40 }), h('span', { class: 'cm-brand-name', 'aria-hidden': 'true' }, 'Sonus'));
  let stop = () => {}; // ends what the current step left running (the browser sign-in's polling)
  const kept = { server: fixed || server || lastServer(), user: '', password: '' };
  function frame(title, intro) {
    stop(); stop = () => {};
    card.replaceChildren(brand, h('h1', { id: 'cm-login-title', class: 'cm-login-title', tabindex: '-1' }, title), intro ? h('p', { class: 'cm-login-intro' }, intro) : null);
  }
  // signed in: start the app. A link to the approval page (#/device?code=…) is kept, everything else starts at home.
  const done = () => { history.replaceState(null, '', `${location.pathname}${location.hash.startsWith('#/device') ? location.hash : '#/'}`); location.reload(); };

  // ------------------------------------------------ the password
  function passwordStep(message = '') {
    frame(L.title, fixed ? L.fixedIntro : L.intro);
    const form = h('form', { class: 'cm-login-form', novalidate: '' });
    card.append(form);
    const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
    const fServer = fixed ? null : UI.createTextField(form, { label: L.server, description: L.serverHint, type: 'url', value: kept.server, autocomplete: 'url', name: 'server', required: true }, S);
    const fUser = UI.createTextField(form, { label: L.user, value: kept.user, autocomplete: 'username', name: 'username', required: true }, S);
    const fPass = UI.createTextField(form, { label: L.password, type: 'password', reveal: true, autocomplete: 'current-password', name: 'password' }, S);
    form.append(alert);
    const actions = h('div', { class: 'cm-login-actions' });
    form.append(actions);
    const submit = UI.createButton(actions, { label: L.submit, variant: 'primary', type: 'submit' }, S);
    const address = () => (fixed || fServer.value);
    const browser = UI.createButton(actions, { label: L.browser, icon: 'link', variant: 'secondary', onClick: () => browserStep(address(), { show, button: browser, focus: () => fServer?.input.focus() }) }, S);
    if (demo) UI.createButton(actions, { label: L.demo, icon: 'sparkle', variant: 'ghost', onClick: () => go(demo, DEMO_ACCOUNT.user, DEMO_ACCOUNT.password) }, S);
    card.append(h('p', { class: 'cm-login-note' }, ic('info'), h('span', {}, L.note)));

    const show = msg => { alert.textContent = msg || ''; alert.hidden = !msg; };
    show(message);
    async function go(address, user, password) {
      show('');
      Object.assign(kept, { server: address, user, password });
      submit.update({ busy: true, label: L.busy });
      try {
        await signIn({ server: address, user, password });
        done();
      } catch (err) {
        // refused for the API: on a Sonus server the account may have two-step verification on (or must set it up)
        if (err?.code === 40 && user && (await serverExtensions(address)).has('sonusDeviceLogin') && await webSignIn(address, user, password)) return;
        if (!form.isConnected) return; // another step took over
        show(err?.message || String(err));
        submit.update({ busy: false, label: L.submit });
        (err?.code === 40 || !fServer ? fPass : fServer).input.focus();
      }
    }
    form.addEventListener('submit', e => { e.preventDefault(); go(address(), fUser.value, fPass.value); });
    (!fServer || fServer.value ? (fUser.value ? fPass : fUser) : fServer).input.focus();
  }

  // ------------------------------------------------ the password and a code (a web session, then an app password)
  /** Resolves true when it took over (signed in, or showing a further step); false to report the password as wrong. */
  async function webSignIn(address, user, password) {
    const auth = createAuthApi(normalizeServer(address));
    try { await finish(auth, await auth.login({ username: user, password })); return true; }
    catch (err) {
      if (err.twoFactor === 'code') { codeStep(auth, user, password); return true; }
      if (err.twoFactor === 'setup') { setupStep(auth, err.setupToken); return true; }
      return false; // the password is wrong there too (or the server has no web sign-in)
    }
  }
  function codeStep(auth, user, password) {
    frame(L.codeTitle, L.codeIntro);
    const form = h('form', { class: 'cm-login-form', novalidate: '' });
    card.append(form);
    const field = codeField(form, { UI, S, label: L.code });
    const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
    const actions = h('div', { class: 'cm-login-actions' });
    form.append(alert, actions);
    const submit = UI.createButton(actions, { label: L.verify, variant: 'primary', type: 'submit' }, S);
    UI.createButton(actions, { label: L.back, variant: 'ghost', onClick: () => passwordStep() }, S);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      alert.hidden = true; submit.update({ busy: true });
      try { await finish(auth, await auth.login({ username: user, password, otp: field.value.trim() })); }
      catch (err) {
        if (!form.isConnected) return;
        alert.textContent = err.message; alert.hidden = false; submit.update({ busy: false }); field.input.focus(); field.input.select();
      }
    });
    field.input.focus();
  }
  function setupStep(auth, token) {
    frame(L.setupTitle, L.setupIntro);
    setupPanel(card, { UI, S, L, auth, token, onCancel: () => passwordStep(), onDone: payload => {
      frame(L.recoveryTitle);
      recoveryPanel(card, { UI, S, L, codes: payload.recoveryCodes ?? [], onDone: () => finish(auth, payload).catch(err => passwordStep(err.message)) });
    } });
  }
  /** With a web session: a password of this browser's own (listed under app passwords, revoked there), kept as a token. */
  async function finish(auth, payload) {
    frame(L.title, L.finishing);
    try {
      const made = await auth.createAppPassword(clientName());
      await signIn({ server: auth.server, user: payload.username, password: made.password });
    } catch (err) { passwordStep(err.message); return; }
    done();
  }

  // ------------------------------------------------ through the browser
  async function browserStep(address, { show, button, focus }) {
    const base = normalizeServer(address);
    if (!base) { show('请填写服务器地址。'); focus(); return; }
    const auth = createAuthApi(base);
    let start;
    button.update({ busy: true });
    try { start = await auth.deviceStart({ client: 'Sonus', device: clientName().replace(/^Sonus \((.*)\)$/, '$1') }); }
    catch (err) { button.update({ busy: false }); show(err.status === 404 || err.status === 405 ? L.browserUnsupported : err.message); return; }
    kept.server = address;
    frame(L.browser, L.browserIntro);
    const status = h('p', { class: 'cm-login-status', role: 'status' }, h('span', { class: 'cm-spinner', 'aria-hidden': 'true' }), L.browserWaiting);
    const actions = h('div', { class: 'cm-login-actions' });
    card.append(
      h('p', { class: 'cm-code', dir: 'ltr', 'aria-label': `${L.browserCode} ${start.userCode.split('').join(' ')}` }, start.userCode),
      h('a', { class: 'cm-linkbtn', href: `${base}${start.verificationPath}`, target: '_blank', rel: 'noopener' }, ic('link'), h('span', {}, L.browserOpen)),
      status, actions);
    UI.createButton(actions, { label: L.cancel, variant: 'secondary', onClick: () => passwordStep() }, S);
    let timer = 0, over = false;
    stop = () => { over = true; clearTimeout(timer); };
    const until = Date.now() + (start.expiresIn || 600) * 1000;
    const poll = async () => {
      if (over) return;
      let r = null;
      try { r = await auth.devicePoll(start.deviceCode); } catch { /* the network blinked: ask again */ }
      if (over) return;
      if (r?.status === 'approved') {
        try { await signInWithKey({ server: base, user: r.username, apiKey: r.apiKey }); done(); } catch (err) { passwordStep(err.message); }
        return;
      }
      if (r?.status === 'denied') { passwordStep(L.browserDenied); return; }
      if (r?.status === 'expired' || Date.now() > until) { passwordStep(L.browserExpired); return; }
      timer = setTimeout(poll, Math.max(1, r?.interval ?? start.interval ?? 2) * 1000);
    };
    timer = setTimeout(poll, Math.max(1, start.interval ?? 2) * 1000);
    card.querySelector('.cm-linkbtn').focus();
  }

  passwordStep(error);
}
