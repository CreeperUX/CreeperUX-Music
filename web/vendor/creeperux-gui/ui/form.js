import { setup, fill, uid } from './base.js';
import { createAsyncAction } from '../async-action.js';

/**
 * createForm(container, { onSubmit: async (values, signal) => any, saveBar = true, onDirtyChange({ count, keys }) })
 * Register controls with form.add(name, control, initialValue). A control needs `.value`, `.update({ value })` and
 * optionally `.validate()` and `.focus()`; every stage 2 field satisfies this. The form tracks dirty fields, validates
 * on submit (focusing the first invalid one), runs onSubmit as an async action (busy, failure + retry at the source;
 * a second submit while one is pending is ignored and returns { status: 'pending' }) and shows a save bar with the
 * unsaved count, Discard and Save (D17). A field whose check answers later (G17) is waited for: Save says
 * "Checking…", and the first invalid field in form order gets focus whichever check answered first.
 */
export function createForm(container, props = {}, services) {
  const c = setup(container, services, 'form');
  let p = { saveBar: true, ...props };
  const fields = new Map(); // name → { control, initial }
  const msg = c.h('span', { class: 'ui-savebar-msg', role: 'status' });
  const discard = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost' });
  const save = c.h('button', { type: 'submit', class: 'ui-button', 'data-variant': 'primary' });
  const bar = c.own(c.h('div', { class: 'ui-savebar', hidden: true, role: 'region' }, msg, discard, save));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const dirtyKeys = () => [...fields].filter(([, f]) => !same(f.control.value, f.initial)).map(([k]) => k);
  let barShown = false, ticket = 0, lastCount = -1, checking = false, round = 0;
  const action = createAsyncAction({ clearConfirmedAfter: 1600, onChange: s => renderBar(s) });
  c.cleanup(() => action.destroy());
  function renderBar(s = action.state) {
    discard.textContent = c.s.t('form.discard'); save.textContent = c.s.t('form.save');
    bar.setAttribute('aria-label', c.s.t('form.unsaved', { count: dirtyKeys().length }));
    const busy = s.phase === 'pending' || checking;
    save.toggleAttribute('aria-busy', busy); save.setAttribute('aria-disabled', String(busy));
    fill(save, busy ? c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }) : '', checking ? c.s.t('field.checking') : s.phase === 'pending' ? c.s.t('action.pending') : c.s.t('form.save'));
    const n = dirtyKeys().length;
    if (s.phase === 'failed' && !checking) { msg.dataset.kind = 'error'; msg.textContent = s.error?.message && s.error.message !== 'timeout' ? `${c.s.t('action.failed')}: ${s.error.message}` : c.s.t('action.failed'); save.lastChild.textContent = c.s.t('retry'); }
    else if (s.phase === 'confirmed') { msg.dataset.kind = 'ok'; msg.textContent = c.s.t('action.confirmed'); }
    else { msg.dataset.kind = ''; msg.textContent = c.s.t('form.unsaved', { count: n }); }
    const show = p.saveBar && (n > 0 || busy || s.phase === 'failed' || s.phase === 'confirmed');
    if (show !== barShown) {
      barShown = show; const my = ++ticket;
      if (show) { bar.hidden = false; c.s.motion.animate(bar, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: 8 } }); }
      else c.s.motion.animate(bar, { o: 0, y: 8 }, { role: 'exit' }).then(ok => { if (ok && my === ticket) { bar.hidden = true; c.s.motion.reset(bar); } });
    }
    if (n !== lastCount) { lastCount = n; c.emit(bar, 'dirty-change', { count: n, keys: dirtyKeys() }, p.onDirtyChange); }
  }
  function values() { return Object.fromEntries([...fields].map(([k, f]) => [k, f.control.value])); }
  async function submit() {
    if (action.pending || checking) return { status: 'pending' };
    const list = [...fields.values()], my = ++round;
    let verdicts = list.map(f => { const ok = f.control.validate ? f.control.validate() : true; return f.control.checking && f.control.validateAsync ? f.control.validateAsync() : ok; });
    if (verdicts.some(v => typeof v?.then === 'function')) {
      checking = true; renderBar();
      try { verdicts = await Promise.all(verdicts); } finally { checking = false; }
      if (c.dead) return { status: 'destroyed' };
      if (my !== round) { renderBar(); return { status: 'superseded' }; } // Discard while checking
    }
    const firstInvalid = list[verdicts.findIndex(ok => !ok)]?.control;
    if (firstInvalid) { renderBar(); firstInvalid.focus?.(); msg.dataset.kind = 'error'; msg.textContent = c.s.t('form.fixErrors'); c.s.announce(c.s.t('form.fixErrors'), { politeness: 'assertive' }); return { status: 'invalid' }; }
    const snapshot = values();
    const r = await action.run(signal => p.onSubmit ? p.onSubmit(snapshot, signal) : Promise.resolve(), { value: snapshot });
    if (r.status === 'confirmed') { for (const [k, f] of fields) f.initial = snapshot[k]; c.s.announce(c.s.t('action.confirmed')); }
    else if (r.status === 'failed') c.s.announce(c.s.t('action.failed'), { politeness: 'assertive' });
    renderBar();
    return r;
  }
  function reset() { round++; for (const [, f] of fields) f.control.update({ value: f.initial, error: null }); action.reset(); renderBar(); }
  c.on(container, 'cx:change', () => renderBar());
  c.on(container, 'cx:input', () => renderBar());
  c.on(discard, 'click', reset);
  c.on(save, 'click', e => { e.preventDefault(); submit(); });
  if (container.tagName === 'FORM') c.on(container, 'submit', e => { e.preventDefault(); submit(); });
  container.classList.add('ui-form');
  container.append(bar);
  renderBar();
  return {
    root: container, bar,
    add(name, control, initial = control.value) { fields.set(name, { control, initial }); container.append(bar); renderBar(); return control; }, // the save bar stays last
    remove(name) { fields.delete(name); renderBar(); },
    get values() { return values(); }, get dirty() { return dirtyKeys(); }, get state() { return action.state; },
    submit, reset,
    update(n) { p = { ...p, ...n }; renderBar(); },
    destroy() { container.classList.remove('ui-form'); return c.destroy(); },
  };
}

/**
 * createFieldset(container, { legend, description, error, hideLegend, disabled, columns = 1 }, services) → { root, body, … }
 * Groups any fields under a legend (G17). It is a native fieldset: screen readers announce the legend with the first
 * field, and `disabled` disables every native control inside (the slider and colour picker take their own `disabled`).
 * `error` is a message for the group as a whole, such as a rule across its fields. Put the fields in handle.body;
 * `columns` sets them side by side, dropping to fewer columns where a column would be narrower than 12rem.
 */
export function createFieldset(container, props = {}, services) {
  const c = setup(container, services, 'fieldset');
  let p = { columns: 1, ...props };
  const legend = c.h('legend', { class: 'ui-fieldset-legend' });
  const descId = uid('dsc'), desc = c.h('div', { class: 'ui-field-desc', id: descId, hidden: true });
  const errId = uid('err'), err = c.h('div', { class: 'ui-field-error', id: errId, hidden: true }, c.icon('alert'), c.h('span'));
  const body = c.h('div', { class: 'ui-fieldset-body' });
  const el = c.own(c.h('fieldset', { class: 'ui-fieldset' }, legend, desc, err, body));
  function render() {
    legend.textContent = p.legend ?? '';
    legend.classList.toggle('ui-visually-hidden', !!p.hideLegend);
    desc.textContent = p.description ?? ''; desc.hidden = !p.description;
    err.lastChild.textContent = p.error || ''; err.hidden = !p.error;
    const by = [p.description ? descId : null, p.error ? errId : null].filter(Boolean).join(' ');
    if (by) el.setAttribute('aria-describedby', by); else el.removeAttribute('aria-describedby');
    el.disabled = !!p.disabled;
    body.style.setProperty('--ui-columns', String(Math.max(1, Math.floor(p.columns) || 1)));
  }
  render(); container.append(el);
  const first = () => body.querySelector('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]');
  return { root: el, body, update(n) { p = { ...p, ...n }; render(); }, focus: () => first()?.focus(), destroy: () => c.destroy() };
}
