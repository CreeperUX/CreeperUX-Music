// Settings: playback (order, stop after the current song, replay gain), the output device, the server account, the
// interface's own appearance, and what the server and the app are.
import { h, ic } from '../dom.js';
import { scope } from './common.js';
import { VERSION } from '../version.js';

export function settingsView(holder, route, ctx) {
  const t = ctx.t, s = t.set, bag = scope(), UI = ctx.UI, a = ctx.adapter;
  holder.classList.add('cm-settings');
  const body = h('div', { class: 'cm-pad' }, h('h1', { class: 'cm-greeting' }, t.settings));
  holder.append(body);
  const section = (title, intro) => { const sec = h('section', { class: 'cm-set', 'aria-label': title }, h('h2', { class: 'cm-set-title' }, title), intro ? h('p', { class: 'cm-set-intro' }, intro) : null); body.append(sec); return sec; };
  const row = (sec, cls = '') => { const r = h('div', { class: `cm-set-row ${cls}` }); sec.append(r); return r; };
  const facts = (sec, list) => sec.append(h('dl', { class: 'cm-facts cm-set-facts' }, list.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))));

  // ------------------------------------------------ playback
  const play = section(s.playback);
  const order = bag.add(UI.createRadioGroup(row(play), { label: t.playbackOrder, value: ctx.player.order,
    options: Object.entries(t.orders).map(([value, label]) => ({ value, label })),
    onChange: e => ctx.run(a.setOrder(e.value)) }, ctx.S));
  const stop = bag.add(UI.createSwitch(row(play), { label: t.stopAfterCurrent, checked: !!ctx.player.stopAfterCurrent, onChange: e => ctx.run(a.setStopAfterCurrent(e.checked)) }, ctx.S));
  bag.add(UI.createRadioGroup(row(play), { label: t.replayGainMode, value: ctx.player.replayGain, orientation: 'horizontal',
    options: Object.entries(t.rgModes).map(([value, label]) => ({ value, label })), onChange: e => ctx.run(a.setReplayGain(e.value)) }, ctx.S));
  bag.add(ctx.on('player', ({ player, prev }) => {
    if (player.order !== prev?.order) order.update({ value: player.order });
    if (player.stopAfterCurrent !== prev?.stopAfterCurrent) stop.update({ checked: !!player.stopAfterCurrent });
  }));

  // ------------------------------------------------ output device
  const out = section(t.output, s.outputIntro);
  const outRow = row(out);
  const outOptions = () => ctx.outputs.map(o => ({ value: o.id, label: o.name, group: o.detail || '', disabled: o.state === 'unavailable' }));
  const current = () => ctx.outputs.find(o => o.state === 'connected')?.id ?? null;
  const outStatus = h('p', { class: 'cm-set-status', role: 'status' });
  const select = bag.add(UI.createSelect(outRow, { label: t.output, options: outOptions(), value: current(), presentation: 'popup', searchable: ctx.outputs.length > 8,
    onChange: e => { if (e.value && e.value !== current()) ctx.run(a.setOutput(e.value)).finally(sync); } }, ctx.S));
  outRow.append(outStatus);
  const sync = () => {
    select.update({ options: outOptions(), value: current() });
    const o = ctx.outputs.find(x => x.state === 'connecting' || x.state === 'error') || ctx.outputs.find(x => x.state === 'connected');
    outStatus.textContent = !o ? s.noOutputs : o.state === 'connecting' ? s.connecting(o.name) : o.state === 'error' ? s.outputError(o.name, o.detail) : s.outputActive(o.name, o.detail);
  };
  sync(); bag.add(ctx.on('outputs', sync));

  // ------------------------------------------------ the account
  const acc = a.account(), accSec = section(s.account, s.accountIntro);
  facts(accSec, [[s.accountServer, acc.server], [s.accountUser, acc.user], [s.storage, a.loginStorage() === 'credential-manager' ? s.storageHost : s.storageBrowser]]);
  bag.add(UI.createButton(row(accSec), { label: s.signOut, icon: 'logout', variant: 'secondary', onClick: async () => { await a.signOut(); location.replace(`${location.pathname}#/`); location.reload(); } }, ctx.S));

  // ------------------------------------------------ appearance (this interface)
  const look = section(s.appearance);
  bag.add(UI.createSegmented(row(look), { label: t.theme, value: ctx.prefs.theme, options: ['dark', 'light', 'system'].map(v => ({ value: v, label: t[v] })),
    onChange: e => { ctx.prefs.theme = e.value; if (e.value === 'system') delete ctx.root.dataset.theme; else ctx.root.dataset.theme = e.value; ctx.savePrefs(); } }, ctx.S));
  bag.add(UI.createSegmented(row(look), { label: t.density, value: ctx.prefs.density, options: [['compact', t.compact], ['', t.comfortable], ['touch', t.touch]].map(([value, label]) => ({ value, label })),
    onChange: e => { ctx.prefs.density = e.value; if (e.value) ctx.root.dataset.density = e.value; else delete ctx.root.dataset.density; ctx.savePrefs(); } }, ctx.S));
  bag.add(UI.createSegmented(row(look), { label: t.language, value: ctx.prefs.locale, options: [{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }],
    onChange: e => { ctx.prefs.locale = e.value; ctx.savePrefs(); location.reload(); } }, ctx.S));
  bag.add(UI.createButton(row(look), { label: t.shortcuts, icon: 'info', variant: 'secondary', onClick: () => ctx.keys.openHelp() }, ctx.S));

  // ------------------------------------------------ about
  const about = section(s.about);
  const ab = a.about();
  const reloads = ctx.reloads?.() ?? [];
  facts(about, [[s.app, `${t.app} ${VERSION}${globalThis.chrome?.webview ? ' · Windows' : ''}`], [s.player, ab.player], [s.plugin, ab.plugin], [s.address, location.origin],
    [s.reloads, reloads.length ? s.reloadsN(reloads.length, new Date(reloads[reloads.length - 1]).toLocaleTimeString(ctx.prefs.locale)) : '0']]);
  const elsewhere = row(about, 'cm-set-note'); elsewhere.append(ic('info'), h('span', {}, s.elsewhere));
  return { title: t.settings, destroy: () => bag.destroy() };
}
