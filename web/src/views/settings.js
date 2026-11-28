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

  // ------------------------------------------------ quality & volume normalization
  const qual = section(s.quality, s.qualityIntro);
  const tierOpts = Object.entries(t.qualityTiers).map(([value, label]) => ({ value, label }));
  const wifiQ = bag.add(UI.createRadioGroup(row(qual), { label: s.wifiQuality, value: ctx.player.wifiQuality ?? 'auto', orientation: 'horizontal',
    options: tierOpts, onChange: e => ctx.run(a.setWifiQuality(e.value)) }, ctx.S));
  const cellQ = bag.add(UI.createRadioGroup(row(qual), { label: s.cellularQuality, value: ctx.player.cellularQuality ?? 'auto', orientation: 'horizontal',
    options: tierOpts, onChange: e => ctx.run(a.setCellularQuality(e.value)) }, ctx.S));
  const qNote = row(qual, 'cm-set-note'); qNote.append(ic('info'), h('span', {}, s.qualityNote));
  const loudLvl = bag.add(UI.createRadioGroup(row(qual), { label: s.loudness, value: ctx.player.loudnessLevel ?? 'off', orientation: 'horizontal',
    options: Object.entries(t.loudnessLevels).map(([value, label]) => ({ value, label })),
    onChange: e => ctx.run(a.setLoudnessLevel(e.value)) }, ctx.S));
  const loudModeRow = row(qual);
  const loudMode = bag.add(UI.createRadioGroup(loudModeRow, { label: s.loudnessMode, value: ctx.player.loudnessMode ?? 'album', orientation: 'horizontal',
    options: Object.entries(t.loudnessModes).map(([value, label]) => ({ value, label })),
    onChange: e => ctx.run(a.setLoudnessMode(e.value)) }, ctx.S));
  loudModeRow.hidden = (ctx.player.loudnessLevel ?? 'off') === 'off';
  const lNote = row(qual, 'cm-set-note'); lNote.append(ic('info'), h('span', {}, s.loudnessNote));

  bag.add(ctx.on('player', ({ player, prev }) => {
    if (player.order !== prev?.order) order.update({ value: player.order });
    if (player.stopAfterCurrent !== prev?.stopAfterCurrent) stop.update({ checked: !!player.stopAfterCurrent });
    if (player.wifiQuality !== prev?.wifiQuality) wifiQ.update({ value: player.wifiQuality ?? 'auto' });
    if (player.cellularQuality !== prev?.cellularQuality) cellQ.update({ value: player.cellularQuality ?? 'auto' });
    if (player.loudnessLevel !== prev?.loudnessLevel) {
      loudLvl.update({ value: player.loudnessLevel ?? 'off' });
      loudModeRow.hidden = (player.loudnessLevel ?? 'off') === 'off';
    }
    if (player.loudnessMode !== prev?.loudnessMode) loudMode.update({ value: player.loudnessMode ?? 'album' });
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
  if (a.extensions?.().has('sonusDeviceLogin')) row(accSec).append(h('a', { class: 'cm-linkbtn', href: '#/account' }, ic('lock'), h('span', {}, t.account)));
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

  // ------------------------------------------------ advanced
  const adv = section(s.advanced);
  const orig = bag.add(UI.createSwitch(row(adv), { label: s.alwaysOriginal, checked: !!ctx.player.alwaysOriginal, onChange: e => ctx.run(a.setAlwaysOriginal(e.checked)) }, ctx.S));
  const origNote = row(adv, 'cm-set-note'); origNote.append(ic('info'), h('span', {}, s.alwaysOriginalNote));
  bag.add(ctx.on('player', ({ player, prev }) => {
    if (player.alwaysOriginal !== prev?.alwaysOriginal) orig.update({ checked: !!player.alwaysOriginal });
  }));

  // ------------------------------------------------ about
  const about = section(s.about);
  const ab = a.about();
  const reloads = ctx.reloads?.() ?? [];
  facts(about, [[s.app, `${t.app} ${VERSION}${globalThis.chrome?.webview ? ' · Windows' : ''}`], [s.player, ab.player], [s.plugin, ab.plugin], [s.address, location.origin],
    [s.reloads, reloads.length ? s.reloadsN(reloads.length, new Date(reloads[reloads.length - 1]).toLocaleTimeString(ctx.prefs.locale)) : '0']]);
  const elsewhere = row(about, 'cm-set-note'); elsewhere.append(ic('info'), h('span', {}, s.elsewhere));
  return { title: t.settings, destroy: () => bag.destroy() };
}
