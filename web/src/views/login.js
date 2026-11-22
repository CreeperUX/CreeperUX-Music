// Sign-in to a music server (Navidrome or another Subsonic-compatible one): shown instead of the workspace while there
// is no saved sign-in. On success the page reloads and starts with the library. ?demo=<address> (the demo launcher sets
// it) adds a button that signs in to the local demo server's account.
import { h, ic } from '../dom.js';
import { signIn, lastServer } from '../api/subsonic.js';

export const DEMO_ACCOUNT = { user: 'demo', password: 'demo' };

export function mountLogin(root, { UI, S, t, server = '', demo = null, error = '' }) {
  const L = t.login;
  root.classList.add('cm', 'cm-login-root');
  const card = h('main', { class: 'cm-login', 'aria-labelledby': 'cm-login-title' },
    h('div', { class: 'cm-login-brand' }, h('img', { src: './assets/icon.svg', alt: '', width: 40, height: 40 }), h('span', { class: 'cm-brand-name', 'aria-hidden': 'true' }, 'CreeperUX ', h('b', {}, 'Music'))),
    h('h1', { id: 'cm-login-title', class: 'cm-login-title' }, L.title),
    h('p', { class: 'cm-login-intro' }, L.intro));
  const form = h('form', { class: 'cm-login-form', novalidate: '' });
  card.append(form);
  root.replaceChildren(card);

  const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
  const fServer = UI.createTextField(form, { label: L.server, description: L.serverHint, type: 'url', value: server || lastServer(), autocomplete: 'url', name: 'server', required: true }, S);
  const fUser = UI.createTextField(form, { label: L.user, autocomplete: 'username', name: 'username', required: true }, S);
  const fPass = UI.createTextField(form, { label: L.password, type: 'password', reveal: true, autocomplete: 'current-password', name: 'password' }, S);
  form.append(alert);
  const actions = h('div', { class: 'cm-login-actions' });
  form.append(actions);
  const submit = UI.createButton(actions, { label: L.submit, variant: 'primary', type: 'submit' }, S);
  if (demo) UI.createButton(actions, { label: L.demo, icon: 'sparkle', variant: 'secondary', onClick: () => go(demo, DEMO_ACCOUNT.user, DEMO_ACCOUNT.password) }, S);
  card.append(h('p', { class: 'cm-login-note' }, ic('info'), h('span', {}, L.note)));

  const show = msg => { alert.textContent = msg || ''; alert.hidden = !msg; };
  show(error);
  async function go(address, user, password) {
    show('');
    submit.update({ busy: true, label: L.busy });
    try {
      await signIn({ server: address, user, password });
      history.replaceState(null, '', `${location.pathname}#/`); // drops ?demo / ?server
      location.reload();
    } catch (err) {
      show(err?.message || String(err));
      submit.update({ busy: false, label: L.submit });
      (err?.code === 40 ? fPass : fServer).input.focus();
    }
  }
  form.addEventListener('submit', e => { e.preventDefault(); go(fServer.value, fUser.value, fPass.value); });
  (fServer.value ? fUser : fServer).input.focus();
}
