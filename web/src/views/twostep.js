// Pieces the sign-in page and the account pages share: asking for a verification code, setting up an authenticator,
// showing recovery codes once, and the password gate that opens a web session (api/sonus.js).
import { h } from '../dom.js';

/** A field for a code from the authenticator, or a recovery code (so not six boxes: recovery codes are longer). */
export function codeField(container, { UI, S, label, description }) {
  const f = UI.createTextField(container, { label, description, autocomplete: 'one-time-code', name: 'otp' }, S);
  f.input.setAttribute('autocapitalize', 'off'); f.input.setAttribute('spellcheck', 'false');
  return f;
}

/** A button that copies text and says so; where the browser refuses, the text is selected instead. */
export function copyButton(container, { UI, S, L, text, target }) {
  const b = UI.createButton(container, { label: L.copy, icon: 'copy', variant: 'secondary', onClick: async () => {
    try { await navigator.clipboard.writeText(text()); b.update({ label: L.copied }); setTimeout(() => b.update({ label: L.copy }), 2000); }
    catch { const r = document.createRange(); r.selectNodeContents(target); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  } }, S);
  return b;
}

/**
 * Sets up an authenticator: the QR code and its key, then a code from the app to confirm.
 * @param o.token   The setup token from a sign-in that asked for the setup; omitted when signed in.
 * @param o.code    A current code, when replacing an authenticator that is already set up.
 * @param o.onDone  Called with the server's answer ({ recoveryCodes, … }).
 */
export function setupPanel(container, { UI, S, L, auth, token, code, onDone, onCancel }) {
  const box = h('div', { class: 'cm-setup' }, h('p', { class: 'cm-login-status', role: 'status' }, '…'));
  container.append(box);
  auth.setupBegin({ token, code }).then(info => {
    const form = h('form', { class: 'cm-login-form', novalidate: '' });
    const secret = h('code', { class: 'cm-secret', dir: 'ltr' }, info.secret);
    box.replaceChildren(
      info.qr ? h('img', { class: 'cm-qr', src: info.qr, alt: L.qrAlt, width: 200, height: 200 }) : null,
      h('p', { class: 'cm-login-note' }, h('span', {}, L.secret)), secret, form);
    const field = codeField(form, { UI, S, label: L.code });
    const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
    const actions = h('div', { class: 'cm-login-actions' });
    form.append(alert, actions);
    const submit = UI.createButton(actions, { label: L.confirm, variant: 'primary', type: 'submit' }, S);
    if (onCancel) UI.createButton(actions, { label: L.cancel, variant: 'ghost', onClick: onCancel }, S);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      alert.hidden = true; submit.update({ busy: true });
      try { onDone(await auth.setupConfirm({ token, code: field.value.trim() })); }
      catch (err) { alert.textContent = err.message; alert.hidden = false; submit.update({ busy: false }); field.input.focus(); field.input.select(); }
    });
    field.input.focus();
  }, err => {
    box.replaceChildren(h('p', { class: 'cm-login-error', role: 'alert' }, err.message));
    if (onCancel) UI.createButton(box, { label: L.back, variant: 'secondary', onClick: onCancel }, S);
  });
  return box;
}

/** The recovery codes, shown once: a list to copy, and a button to go on. */
export function recoveryPanel(container, { UI, S, L, codes, onDone }) {
  const list = h('ul', { class: 'cm-codes', dir: 'ltr' }, codes.map(c => h('li', {}, c)));
  const actions = h('div', { class: 'cm-login-actions' });
  const box = h('div', { class: 'cm-setup' }, h('p', { class: 'cm-login-intro' }, L.recoveryIntro), list, actions);
  container.append(box);
  const ok = UI.createButton(actions, { label: L.recoverySaved, variant: 'primary', onClick: onDone }, S);
  copyButton(actions, { UI, S, L, text: () => codes.join('\n'), target: list });
  ok.element.focus();
  return box;
}

/**
 * Opens a web session with the account password (and a code when two-step verification is on), then calls onReady.
 * Shows nothing and calls onReady at once when there is a session already.
 */
export function sessionGate(container, { UI, S, t, auth, user = '', onReady }) {
  if (auth.session) { onReady(); return null; }
  const A = t.acc, L = t.login;
  const form = h('form', { class: 'cm-login-form cm-gate', novalidate: '' });
  const box = h('section', { class: 'cm-set', 'aria-labelledby': 'cm-gate-title' }, h('h2', { id: 'cm-gate-title', class: 'cm-set-title' }, A.gateTitle), h('p', { class: 'cm-set-intro' }, A.gateIntro), form);
  container.append(box);
  const fUser = UI.createTextField(form, { label: L.user, value: user, autocomplete: 'username', name: 'username', readOnly: !!user }, S);
  const fPass = UI.createTextField(form, { label: L.password, type: 'password', reveal: true, autocomplete: 'current-password', name: 'password' }, S);
  const codeBox = h('div', { hidden: '' });
  form.append(codeBox);
  let fCode = null;
  const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
  const actions = h('div', { class: 'cm-login-actions' });
  form.append(alert, actions);
  const submit = UI.createButton(actions, { label: A.gateSubmit, variant: 'primary', type: 'submit' }, S);
  const show = msg => { alert.textContent = msg || ''; alert.hidden = !msg; };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    show(''); submit.update({ busy: true });
    try {
      await auth.login({ username: fUser.value.trim(), password: fPass.value, otp: fCode?.value.trim() || undefined });
      box.remove(); onReady();
    } catch (err) {
      submit.update({ busy: false });
      if (err.twoFactor === 'code') {
        if (!fCode) { fCode = codeField(codeBox, { UI, S, label: L.code, description: L.codeIntro }); codeBox.hidden = false; } else show(err.message);
        fCode.input.focus(); fCode.input.select();
      } else if (err.twoFactor === 'setup') {
        // the server wants two-step verification set up before it opens a session
        form.hidden = true;
        const setup = setupPanel(box, { UI, S, L, auth, token: err.setupToken, onCancel: () => { setup.remove(); form.hidden = false; },
          onDone: payload => { setup.remove(); recoveryPanel(box, { UI, S, L, codes: payload.recoveryCodes ?? [], onDone: () => { box.remove(); onReady(); } }); } });
      } else { show(err.message); fPass.input.focus(); }
    }
  });
  (user ? fPass : fUser).input.focus({ preventScroll: true });
  return box;
}
