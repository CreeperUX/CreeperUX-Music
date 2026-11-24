// Account and security (#/account): two-step verification, app passwords, and the way to the approval page for apps
// that sign in through the browser. These are the Sonus server's /auth routes (api/sonus.js); the page opens them with
// a web session of its own (the password again, and a code), which is kept in memory only.
//
// This is the first page of what becomes the admin area: users, the library and scans, and server settings come here as
// further views once the server has /sonus/v1 (docs/server-roadmap.md, phase 6).
import { h } from '../dom.js';
import { scope } from './common.js';
import { createAuthApi } from '../api/sonus.js';
import { codeField, copyButton, setupPanel, recoveryPanel, sessionGate } from './twostep.js';

export function accountView(holder, route, ctx) {
  const t = ctx.t, A = t.acc, L = t.login, bag = scope(), { UI, S } = ctx;
  const acc = ctx.adapter.account(), auth = createAuthApi(acc.server);
  holder.classList.add('cm-settings');
  const body = h('div', { class: 'cm-pad' }, h('h1', { class: 'cm-greeting' }, t.account), h('p', { class: 'cm-set-intro' }, A.intro));
  holder.append(body);
  const area = h('div', { class: 'cm-account' });
  body.append(area);
  let alive = true;
  bag.add(() => { alive = false; });
  const date = v => (v ? S.format.relative(Date.parse(v)) : '');
  const section = (title, intro) => { const sec = h('section', { class: 'cm-set', 'aria-label': title }, h('h2', { class: 'cm-set-title' }, title), intro ? h('p', { class: 'cm-set-intro' }, intro) : null); area.append(sec); return sec; };
  const fail = (sec, err) => sec.append(h('p', { class: 'cm-login-error', role: 'alert' }, err.message));
  // the session ran out while the page was open: ask again
  const guard = fn => async (...args) => { try { return await fn(...args); } catch (err) { if (err.status === 401 && !err.twoFactor && alive) { start(); return undefined; } throw err; } };

  function start() {
    area.replaceChildren();
    if (!ctx.adapter.extensions?.().has('sonusDeviceLogin')) { section(t.account).append(h('p', { class: 'cm-set-status' }, A.unsupported)); return; }
    sessionGate(area, { UI, S, t, auth, user: acc.user, onReady: () => { if (alive) render(); } });
  }

  function render() {
    area.replaceChildren();
    const top = h('div', { class: 'cm-account-top' }, h('span', { class: 'cm-set-status' }, A.verified(auth.session?.username ?? acc.user)));
    area.append(top);
    UI.createButton(top, { label: A.lock, icon: 'lock', variant: 'ghost', onClick: () => { auth.forget(); start(); } }, S);
    twoStep(section(A.twoStep));
    appPasswords(section(A.appPasswords, A.appIntro));
    const dev = section(A.devices, A.devicesIntro);
    dev.append(h('a', { class: 'cm-linkbtn', href: '#/device' }, h('span', {}, A.devOpen)));
  }

  // ------------------------------------------------ two-step verification
  async function twoStep(sec) {
    const box = h('div', { class: 'cm-set-row' });
    sec.append(box);
    let st;
    try { st = await guard(auth.status)(); } catch (err) { fail(sec, err); return; }
    if (!st || !alive) return;
    const draw = () => {
      box.replaceChildren(
        h('p', { class: 'cm-state', 'data-on': st.enabled || null }, st.enabled ? A.on : A.off, st.enabled && st.enabledAt ? h('span', { class: 'cm-set-status' }, ` · ${date(st.enabledAt)}`) : null),
        h('p', { class: 'cm-set-status' }, st.mode === 'required' ? A.modeRequired : st.mode === 'off' ? A.modeOff : A.modeOptional),
        st.enabled ? h('p', { class: 'cm-set-status' }, A.recoveryLeft(st.recoveryCodesLeft ?? 0)) : null);
      const actions = h('div', { class: 'cm-set-row cm-set-buttons' });
      box.append(actions);
      if (!st.enabled && st.mode !== 'off') UI.createButton(actions, { label: A.setUp, variant: 'primary', onClick: setUp }, S);
      if (st.enabled) UI.createButton(actions, { label: A.newCodes, variant: 'secondary', onClick: () => askCode(async code => showCodes((await auth.newRecoveryCodes(code)).recoveryCodes)) }, S);
      if (st.enabled && st.mode === 'optional') UI.createButton(actions, { label: A.disable, variant: 'danger', onClick: () => askCode(async code => { await auth.disable(code); UI.toast({ kind: 'ok', message: A.turnedOff }, S); reload(); }) }, S);
    };
    const reload = async () => { try { st = (await guard(auth.status)()) ?? st; } catch { /* keep what is shown */ } if (alive) draw(); };
    const showCodes = codes => { box.replaceChildren(h('h3', { class: 'cm-card-title' }, L.recoveryTitle)); recoveryPanel(box, { UI, S, L, codes: codes ?? [], onDone: reload }); };
    function setUp() {
      box.replaceChildren(h('p', { class: 'cm-set-intro' }, A.setupIntro));
      setupPanel(box, { UI, S, L, auth, onCancel: draw, onDone: payload => { UI.toast({ kind: 'ok', message: A.turnedOn }, S); showCodes(payload.recoveryCodes); } });
    }
    /** A code first (the server asks for one before it changes anything), then the action. */
    function askCode(action) {
      const form = h('form', { class: 'cm-login-form', novalidate: '' });
      box.replaceChildren(form);
      const field = codeField(form, { UI, S, label: L.code, description: A.codeFor });
      const alert = h('p', { class: 'cm-login-error', role: 'alert', hidden: '' });
      const actions = h('div', { class: 'cm-login-actions' });
      form.append(alert, actions);
      const submit = UI.createButton(actions, { label: L.confirm, variant: 'primary', type: 'submit' }, S);
      UI.createButton(actions, { label: L.cancel, variant: 'ghost', onClick: draw }, S);
      form.addEventListener('submit', async e => {
        e.preventDefault();
        alert.hidden = true; submit.update({ busy: true });
        try { await action(field.value.trim()); }
        catch (err) { if (!form.isConnected) return; alert.textContent = err.message; alert.hidden = false; submit.update({ busy: false }); field.input.focus(); field.input.select(); }
      });
      field.input.focus();
    }
    draw();
  }

  // ------------------------------------------------ app passwords (and the keys of apps signed in through the browser)
  function appPasswords(sec) {
    const made = h('div', { class: 'cm-made', role: 'status' });
    const list = h('ul', { class: 'cm-app-list' });
    const form = h('form', { class: 'cm-app-form', novalidate: '' });
    sec.append(form, made, list);
    const name = UI.createTextField(form, { label: A.appName, placeholder: A.appNameHint, maxLength: 64, name: 'app-password-name' }, S);
    const create = UI.createButton(form, { label: A.create, icon: 'plus', variant: 'primary', type: 'submit' }, S);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      create.update({ busy: true });
      try {
        const r = await guard(auth.createAppPassword)(name.value.trim() || clientLabel());
        if (r && alive) {
          const secret = h('code', { class: 'cm-secret', dir: 'ltr' }, r.password);
          const row = h('div', { class: 'cm-made-row' }, secret);
          made.replaceChildren(h('p', { class: 'cm-set-status' }, A.newPassword), row);
          copyButton(row, { UI, S, L, text: () => r.password, target: secret });
          name.update({ value: '' });
          await load();
        }
      } catch (err) { made.replaceChildren(h('p', { class: 'cm-login-error', role: 'alert' }, err.message)); }
      create.update({ busy: false });
    });
    const clientLabel = () => acc.client;
    async function load() {
      let items;
      try { items = await guard(auth.appPasswords)(); } catch (err) { list.replaceChildren(h('li', { class: 'cm-login-error', role: 'alert' }, err.message)); return; }
      if (!items || !alive) return;
      if (!items.length) { list.replaceChildren(h('li', { class: 'cm-set-status' }, A.none)); return; }
      list.replaceChildren(...items.map(p => {
        const li = h('li', { class: 'cm-app-row' },
          h('div', { class: 'cm-app-text' }, h('strong', {}, p.name || '—'),
            h('span', { class: 'cm-set-status' }, `${A.createdAt(date(p.createdAt))} · ${p.lastUsedAt ? A.lastUsed(date(p.lastUsedAt), p.lastUsedBy) : A.neverUsed}`)));
        const b = UI.createButton(li, { label: A.revoke, variant: 'secondary', onClick: async () => {
          if (!await UI.confirm({ title: A.revokeConfirm(p.name), message: A.revokeMsg, confirmLabel: A.revoke, danger: true }, S)) return;
          try { await guard(auth.deleteAppPassword)(p.id); UI.toast({ kind: 'ok', message: A.revoked(p.name) }, S); } catch (err) { UI.toast({ kind: 'fail', message: err.message }, S); }
          load();
        } }, S);
        b.element.setAttribute('aria-label', A.revokeX(p.name));
        return li;
      }));
    }
    load();
  }

  start();
  return { title: t.account, destroy: () => bag.destroy() };
}
