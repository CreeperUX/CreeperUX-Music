// The approval page of the browser sign-in (#/device?code=ABCD-EFGH, as an app opens it): an app asked to sign in; the
// signed-in user checks that the code is the one the app shows, and allows it (the server then hands the app an API key
// of its own) or refuses. The page shows which app and device ask, and from which address; with two-step verification
// allowing takes a verification code, so one click on someone else's link hands nothing over. Opened without a code,
// it asks for one. It needs a web session (api/sonus.js), so it asks for
// the password and a two-step code first. It works inside the app (a view) and alone, before anyone has signed in to
// this client (mountDevice): approving an app does not need this browser to keep a sign-in.
import { h } from '../dom.js';
import { createAuthApi } from '../api/sonus.js';
import { codeField, sessionGate } from './twostep.js';

function devicePanel(container, { UI, S, t, auth, user, code }) {
  const A = t.acc;
  let alive = true;
  const box = h('div', { class: 'cm-device' });
  container.append(box);
  const say = (text, kind) => box.replaceChildren(h('p', { class: kind === 'bad' ? 'cm-login-error' : 'cm-device-done', role: 'status', tabindex: '-1' }, text));

  function ask(message = '') {
    const form = h('form', { class: 'cm-login-form', novalidate: '' });
    box.replaceChildren(h('p', { class: 'cm-set-intro' }, A.devAsk), form);
    const field = UI.createTextField(form, { label: A.devCode, name: 'device-code', required: true, placeholder: 'ABCD-EFGH', error: message || undefined }, S);
    field.input.setAttribute('autocapitalize', 'characters'); field.input.setAttribute('spellcheck', 'false');
    const actions = h('div', { class: 'cm-login-actions' });
    form.append(actions);
    UI.createButton(actions, { label: A.devNext, variant: 'primary', type: 'submit' }, S);
    form.addEventListener('submit', e => { e.preventDefault(); const v = field.value.trim().toUpperCase(); if (v) load(v); });
    field.input.focus({ preventScroll: true });
  }
  async function load(c) {
    box.replaceChildren(h('p', { class: 'cm-login-status', role: 'status' }, h('span', { class: 'cm-spinner', 'aria-hidden': 'true' }), '…'));
    let info;
    try { info = await auth.deviceInfo(c); }
    catch (err) {
      if (!alive) return;
      if (err.status === 401) { box.replaceChildren(); sessionGate(box, { UI, S, t, auth, user, onReady: () => load(c) }); return; }
      ask(err.status === 404 ? A.devMissing : err.message); return;
    }
    if (!alive) return;
    const actions = h('div', { class: 'cm-login-actions' });
    const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
    const form = h('form', { class: 'cm-login-form', novalidate: '' });
    box.replaceChildren(
      h('p', { class: 'cm-set-intro' }, A.devIntro),
      h('p', { class: 'cm-code', dir: 'ltr', 'aria-label': `${A.devCode} ${info.userCode.split('').join(' ')}` }, info.userCode),
      h('dl', { class: 'cm-facts' }, h('div', {}, h('dt', {}, A.devClient), h('dd', {}, info.client || '—')), h('div', {}, h('dt', {}, A.devDevice), h('dd', {}, info.device || '—')),
        info.address ? h('div', {}, h('dt', {}, A.devFrom), h('dd', { dir: 'ltr' }, info.address)) : null),
      form);
    // allowing takes a code of the account's own when the server says so (the account has two-step verification)
    if (info.codeRequired) form.append(h('p', { class: 'cm-set-intro' }, A.devCodeIntro));
    const otp = info.codeRequired ? codeField(form, { UI, S, label: t.login.code }) : null;
    form.append(alert, actions);
    const decide = allow => async () => {
      alert.hidden = true;
      if (allow && otp && !otp.value.trim()) { otp.input.focus(); return; }
      try { await auth.deviceDecide(info.userCode, allow, otp?.value.trim()); if (alive) { say(allow ? A.allowed : A.denied); box.firstChild.focus(); } }
      catch (err) {
        if (err.status === 404) ask(A.devMissing);
        else { alert.textContent = err.message; alert.hidden = false; if (otp) { otp.input.focus(); otp.input.select(); } }
      }
    };
    const allow = UI.createButton(actions, { label: A.allow, variant: 'primary', type: 'submit' }, S);
    UI.createButton(actions, { label: A.deny, variant: 'secondary', onClick: decide(false) }, S);
    form.addEventListener('submit', e => { e.preventDefault(); decide(true)(); });
    (otp ? otp.input : allow.element).focus({ preventScroll: true });
  }
  // the session first: the server answers nothing about a code to someone it does not know
  sessionGate(box, { UI, S, t, auth, user, onReady: () => { if (alive) { if (code) load(code); else ask(); } } });
  return () => { alive = false; };
}

/** Inside the app: a page in the main view. */
export function deviceView(holder, route, ctx) {
  const t = ctx.t, acc = ctx.adapter.account();
  holder.classList.add('cm-settings');
  const body = h('div', { class: 'cm-pad' }, h('h1', { class: 'cm-greeting' }, t.acc.devTitle));
  holder.append(body);
  const sec = h('section', { class: 'cm-set cm-device-card', 'aria-label': t.acc.devTitle });
  body.append(sec);
  const stop = devicePanel(sec, { UI: ctx.UI, S: ctx.S, t, auth: createAuthApi(acc.server), user: acc.user, code: route.query.get('code') || '' });
  return { title: t.acc.devTitle, destroy: stop };
}

/** Alone, in place of the sign-in page: this browser has no sign-in of its own, and needs none to approve an app. */
export function mountDevice(root, { UI, S, t, server, code }) {
  root.classList.add('cm', 'cm-login-root');
  const card = h('main', { class: 'cm-login cm-device-card', 'aria-labelledby': 'cm-login-title' },
    h('div', { class: 'cm-login-brand' }, h('img', { src: './assets/icon.svg', alt: '', width: 40, height: 40 }), h('span', { class: 'cm-brand-name', 'aria-hidden': 'true' }, 'Sonus')),
    h('h1', { id: 'cm-login-title', class: 'cm-login-title' }, t.acc.devTitle),
    h('p', { class: 'cm-login-intro', dir: 'ltr' }, server.replace(/^https?:\/\//, '')));
  root.replaceChildren(card);
  devicePanel(card, { UI, S, t, auth: createAuthApi(server), user: '', code });
  card.append(h('p', { class: 'cm-login-note' }, h('a', { href: '#/', onClick: () => setTimeout(() => location.reload()) }, t.acc.toSignIn)));
}
